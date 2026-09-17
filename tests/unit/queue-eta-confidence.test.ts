import { describe, expect, it } from "vitest";

import { classifyEtaConfidence } from "@/modules/queue-eta-estimator/confidence";

const thresholds = {
  highMaxWidthMinutes: 10,
  mediumMaxWidthMinutes: 25,
};

describe("classifyEtaConfidence", () => {
  it.each([
    { width: 0, expected: "high" },
    { width: 10, expected: "high" },
    { width: 10.1, expected: "medium" },
    { width: 25, expected: "medium" },
    { width: 25.1, expected: "low" },
  ] as const)("classifies width $width as $expected", ({ width, expected }) => {
    expect(classifyEtaConfidence(width, thresholds)).toBe(expected);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
    "rejects invalid uncertainty width %s",
    (width) => {
      expect(() => classifyEtaConfidence(width, thresholds)).toThrow(RangeError);
    },
  );

  it("rejects inverted thresholds", () => {
    expect(() =>
      classifyEtaConfidence(5, {
        highMaxWidthMinutes: 20,
        mediumMaxWidthMinutes: 10,
      }),
    ).toThrow(RangeError);
  });
});
