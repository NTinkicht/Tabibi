import { describe, expect, it } from "vitest";

import { classifyEtaConfidence } from "@/modules/queue-eta-estimator/confidence";

const thresholds = {
  highMaxWidthMinutes: 10,
  mediumMaxWidthMinutes: 25,
};

describe("classifyEtaConfidence", () => {
  it("classifies zero uncertainty width as high confidence", () => {
    expect(classifyEtaConfidence(0, thresholds)).toBe("high");
  });

  it("classifies high confidence at the upper boundary", () => {
    expect(classifyEtaConfidence(10, thresholds)).toBe("high");
  });

  it("classifies medium confidence above the high boundary", () => {
    expect(classifyEtaConfidence(10.1, thresholds)).toBe("medium");
  });

  it("classifies medium confidence at the upper boundary", () => {
    expect(classifyEtaConfidence(25, thresholds)).toBe("medium");
  });

  it("classifies low confidence above the medium boundary", () => {
    expect(classifyEtaConfidence(25.1, thresholds)).toBe("low");
  });

  it("rejects a non-finite uncertainty width", () => {
    expect(() =>
      classifyEtaConfidence(Number.NaN, thresholds),
    ).toThrow(RangeError);
  });

  it("rejects a negative uncertainty width", () => {
    expect(() => classifyEtaConfidence(-1, thresholds)).toThrow(RangeError);
  });

  it.each([
    {
      name: "non-finite high threshold",
      value: { highMaxWidthMinutes: Number.NaN, mediumMaxWidthMinutes: 25 },
    },
    {
      name: "negative high threshold",
      value: { highMaxWidthMinutes: -1, mediumMaxWidthMinutes: 25 },
    },
    {
      name: "non-finite medium threshold",
      value: {
        highMaxWidthMinutes: 10,
        mediumMaxWidthMinutes: Number.POSITIVE_INFINITY,
      },
    },
    {
      name: "negative medium threshold",
      value: { highMaxWidthMinutes: 10, mediumMaxWidthMinutes: -1 },
    },
  ])("rejects $name", ({ value }) => {
    expect(() => classifyEtaConfidence(5, value)).toThrow(RangeError);
  });

  it("rejects inverted thresholds", () => {
    expect(() =>
      classifyEtaConfidence(5, {
        highMaxWidthMinutes: 20,
        mediumMaxWidthMinutes: 10,
      }),
    ).toThrow(RangeError);
  });
});
