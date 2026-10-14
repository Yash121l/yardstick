import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configDir, telemetryDisabled } from "./telemetry.js";

describe("telemetry opt-out", () => {
  it("honours DO_NOT_TRACK and YARDSTICK_TELEMETRY=0", () => {
    expect(telemetryDisabled({ DO_NOT_TRACK: "1" })).toBe(true);
    expect(telemetryDisabled({ DO_NOT_TRACK: "true" })).toBe(true);
    expect(telemetryDisabled({ YARDSTICK_TELEMETRY: "0" })).toBe(true);
    expect(telemetryDisabled({ CI: "true" })).toBe(true);
    expect(telemetryDisabled({ DO_NOT_TRACK: "0" })).toBe(false);
    expect(telemetryDisabled({})).toBe(false);
  });

  it("keeps the install id under the user config dir", () => {
    expect(configDir({ XDG_CONFIG_HOME: "/tmp/cfg" })).toBe(join("/tmp/cfg", "yardstick"));
  });
});
