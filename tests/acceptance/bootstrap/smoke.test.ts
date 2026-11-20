import { describe, expect, it } from "vitest";
import * as harness from "../../../src/index.js";

describe("bootstrap smoke", () => {
  it("exports a version string from the package entry", () => {
    expect(typeof harness.version).toBe("string");
    expect(harness.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
