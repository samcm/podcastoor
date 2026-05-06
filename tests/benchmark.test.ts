import { describe, expect, it } from "vitest";
import { runSampleBenchmark } from "../src/benchmark.js";

describe("benchmark", () => {
  it("computes a stable sample transcript distance", () => {
    const result = runSampleBenchmark();
    expect(result.referenceWords).toBeGreaterThan(0);
    expect(result.wordErrorRate).toBeGreaterThanOrEqual(0);
    expect(result.wordErrorRate).toBeLessThan(0.2);
  });
});
