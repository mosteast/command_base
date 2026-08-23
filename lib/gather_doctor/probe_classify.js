"use strict";

function strip_cookie_extraction_noise(raw_text) {
  return String(raw_text || "")
    .split(/\r?\n/)
    .filter((line) => {
      const text = line.trim();
      if (!text) return false;
      if (/^Extracting cookies from\b/i.test(text)) return false;
      if (/^Extracted \d+ cookies from\b/i.test(text)) return false;
      return true;
    })
    .join("\n");
}

function classify_yt_dlp_probe(raw_text, { ok }) {
  const combined = String(raw_text || "");
  const signal_text = strip_cookie_extraction_noise(combined);

  if (ok) {
    return {
      status: "ok",
      message: "yt-dlp probe succeeded",
      reason: "",
    };
  }

  if (
    /sign in to confirm|not a bot|please sign in|use --cookies-from-browser or --cookies for the authentication/i.test(
      signal_text,
    )
  ) {
    return {
      status: "fail",
      message: "yt-dlp auth/cookie challenge",
      reason: "auth",
    };
  }

  if (/429|rate.?limit/i.test(signal_text)) {
    return {
      status: "warn",
      message: "yt-dlp rate limited",
      reason: "rate_limit",
    };
  }

  if (/HTTP Error 412|Precondition Failed/i.test(signal_text)) {
    return {
      status: "warn",
      message: "yt-dlp probe blocked (HTTP 412)",
      reason: "blocked",
    };
  }

  const short_error = signal_text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^ERROR:/i.test(line));
  return {
    status: "warn",
    message: short_error
      ? `yt-dlp probe failed: ${short_error.replace(/^ERROR:\s*/i, "").slice(0, 120)}`
      : "yt-dlp probe failed",
    reason: "other",
  };
}

function classify_gallery_dl_probe(raw_text, { ok }) {
  const combined = String(raw_text || "");

  if (ok) {
    return {
      status: "ok",
      message: "gallery-dl probe succeeded",
      reason: "",
    };
  }

  if (/Unsupported URL/i.test(combined)) {
    return {
      status: "warn",
      message: "gallery-dl probe URL unsupported; use a user/profile URL",
      reason: "bad_url",
    };
  }

  if (
    /login required|authentication|unauthorized|\b403\b|cookies? (are )?(missing|invalid|expired)/i.test(
      combined,
    )
  ) {
    return {
      status: "fail",
      message: "gallery-dl auth/cookie challenge",
      reason: "auth",
    };
  }

  if (/429|rate.?limit/i.test(combined)) {
    return {
      status: "warn",
      message: "gallery-dl rate limited",
      reason: "rate_limit",
    };
  }

  const short_error = combined
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /\[error\]/i.test(line) || /^ERROR:/i.test(line));
  return {
    status: "fail",
    message: short_error
      ? `gallery-dl probe failed: ${short_error.slice(0, 120)}`
      : "gallery-dl probe failed",
    reason: "other",
  };
}

module.exports = {
  strip_cookie_extraction_noise,
  classify_yt_dlp_probe,
  classify_gallery_dl_probe,
};
