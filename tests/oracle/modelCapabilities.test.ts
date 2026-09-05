import { describe, expect, it } from "vitest";
import {
  browserVersionPattern,
  resolveGptModelAlias,
  expectedBrowserModel,
} from "../../src/oracle/modelCapabilities.js";

describe("model capability metadata", () => {
  it("separates the fixed model identity from its moving browser label", () => {
    expect(resolveGptModelAlias("Latest")).toEqual({ model: "gpt-6-astra", pro: false });
    expect(resolveGptModelAlias("GPT 6 Pro")).toEqual({ model: "gpt-6-astra", pro: true });
    expect(expectedBrowserModel("gpt-6-pro")).toBe("gpt-6-astra");
    expect(resolveGptModelAlias("gpt-99-pro")).toBeUndefined();
  });

  it("validates another generation from metadata without changing DOM selection code", () => {
    const pattern = browserVersionPattern("7", "Example");
    expect(pattern.test("7pro")).toBe(true);
    expect(pattern.test("gpt 7 example pro")).toBe(true);
    for (const label of ["6 pro", "70 pro", "7 1 pro", "latest", "pro"])
      expect(pattern.test(label)).toBe(false);
  });

  it("keeps exact minor-version boundaries", () => {
    const pattern = browserVersionPattern("7.1");
    expect(pattern.test("7 1 pro")).toBe(true);
    expect(pattern.test("7 pro")).toBe(false);
    expect(pattern.test("7 10 pro")).toBe(false);
    expect(() => browserVersionPattern("7.*")).toThrow();
  });
});
