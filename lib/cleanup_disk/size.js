"use strict";

function parse_size(text) {
  const raw = String(text).trim();
  const match = /^(\d+(?:\.\d+)?)\s*([kmgtpe]?)$/i.exec(raw);
  if (!match) {
    throw new Error(`Invalid size: ${text}`);
  }

  const value = Number(match[1]);
  const unit = (match[2] || "").toUpperCase();
  const mult = {
    "": 1,
    K: 1024,
    M: 1024 ** 2,
    G: 1024 ** 3,
    T: 1024 ** 4,
    P: 1024 ** 5,
    E: 1024 ** 6,
  };

  if (!(unit in mult)) {
    throw new Error(`Invalid size: ${text}`);
  }

  return Math.floor(value * mult[unit]);
}

function format_size(bytes) {
  const n = Number(bytes) || 0;
  const units = ["B", "K", "M", "G", "T"];
  let v = n;
  let i = 0;

  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }

  const digits = i === 0 || v >= 10 ? 0 : 1;
  return `${v.toFixed(digits)}${units[i]}`;
}

module.exports = {
  parse_size,
  format_size,
};
