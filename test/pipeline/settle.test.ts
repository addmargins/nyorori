import { describe, expect, it } from "vitest";
import { allSettledOrThrow } from "../../src/pipeline/settle.js";

describe("allSettledOrThrow", () => {
  it("waits for the slow sibling before rejecting, so cleanup runs after all writes", async () => {
    const events: string[] = [];
    const slow = new Promise<number>((resolve) => setTimeout(() => (events.push("C done"), resolve(2)), 30));
    const failing = Promise.reject(new Error("B failed"));
    await expect(allSettledOrThrow([failing, slow])).rejects.toThrow("B failed");
    events.push("cleanup");
    expect(events).toEqual(["C done", "cleanup"]);
  });

  it("returns the values in order when all succeed", async () => {
    expect(await allSettledOrThrow([Promise.resolve(1), Promise.resolve("a")])).toEqual([1, "a"]);
  });
});
