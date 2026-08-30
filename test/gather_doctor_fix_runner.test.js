import { describe, expect, it } from "vitest";

const {
  apply_profile_query,
  should_plan_fix,
} = require("../lib/gather_doctor/fix_runner");

const instagram_matches = [
  { directory: "Profile 9", name: "nori", active_time: 30 },
  { directory: "Default", name: "Zheng", active_time: 20 },
  { directory: "Profile 8", name: "dev", active_time: 10 },
];

describe("gather_doctor fix_runner", () => {
  it("still plans a write when check is ok but --chrome-profile is set", () => {
    const result = {
      platform_key: "instagram",
      status: "ok",
      profile_matches: [instagram_matches[1]],
      selected_profile: instagram_matches[1],
    };
    expect(should_plan_fix(result, {})).toBe(false);
    expect(should_plan_fix(result, { chrome_profile: "Zheng" })).toBe(true);
    expect(
      should_plan_fix(
        {
          ...result,
          profile_matches: instagram_matches,
          selected_profile: instagram_matches[0],
        },
        {},
      ),
    ).toBe(true);
  });

  it("applies a typed profile name onto the planned platform", () => {
    const results = [
      {
        platform_key: "instagram",
        selected_profile: instagram_matches[0],
        profile_matches: instagram_matches,
      },
    ];
    const applied = apply_profile_query(results, "Zheng");
    expect(applied.ok).toBe(true);
    expect(applied.results[0].selected_profile.directory).toBe("Default");
    expect(applied.results[0].selected_profile.name).toBe("Zheng");
  });

  it("rejects an unknown typed profile name", () => {
    const applied = apply_profile_query(
      [
        {
          platform_key: "instagram",
          selected_profile: instagram_matches[0],
          profile_matches: instagram_matches,
        },
      ],
      "not-a-profile",
    );
    expect(applied.ok).toBe(false);
    expect(applied.results[0].selected_profile.directory).toBe("Profile 9");
  });
});
