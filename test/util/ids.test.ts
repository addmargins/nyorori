import { describe, expect, it } from "vitest";
import { errorMessage } from "../../src/util/errors.js";
import { isObjectId } from "../../src/util/ids.js";

describe("isObjectId", () => {
  it("accepts full lowercase SHA-1 and SHA-256 object ids only", () => {
    expect(isObjectId("a".repeat(40))).toBe(true);
    expect(isObjectId("0".repeat(64))).toBe(true);
    for (const bad of ["a".repeat(39), "a".repeat(41), "a".repeat(63), "A".repeat(40), "main", `${"a".repeat(40)}\n`]) {
      expect(isObjectId(bad)).toBe(false);
    }
  });
});

describe("errorMessage", () => {
  it("reads an Error's message and stringifies anything else", () => {
    expect(errorMessage(new TypeError("boom"))).toBe("boom");
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage(42)).toBe("42");
  });
});
