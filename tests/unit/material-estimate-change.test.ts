import { describe, expect, it } from "vitest";

import {
  isMaterialEstimateChange,
  type QueueEstimateSnapshot,
} from "@/modules/queue-eta-estimator/material-change";

const baseline: QueueEstimateSnapshot = {
  minWaitMinutes: 10,
  maxWaitMinutes: 20,
  queuePosition: 5,
  sessionStatus: "active",
  approachingTurn: false,
};

describe("material estimate change policy", () => {
  it("stays quiet below every default threshold", () => {
    expect(
      isMaterialEstimateChange(baseline, {
        minWaitMinutes: 18,
        maxWaitMinutes: 30,
        queuePosition: 4,
        sessionStatus: "active",
        approachingTurn: false,
      }),
    ).toBe(false);
  });

  it("marks a midpoint change at the default threshold as material", () => {
    expect(
      isMaterialEstimateChange(baseline, {
        ...baseline,
        minWaitMinutes: 20,
        maxWaitMinutes: 30,
      }),
    ).toBe(true);
  });

  it("marks an uncertainty change at the default threshold as material", () => {
    expect(
      isMaterialEstimateChange(baseline, {
        ...baseline,
        minWaitMinutes: 5,
        maxWaitMinutes: 30,
      }),
    ).toBe(true);
  });

  it(
    "marks a queue-position change at the default threshold as material",
    () => {
      expect(
        isMaterialEstimateChange(baseline, {
          ...baseline,
          queuePosition: 3,
        }),
      ).toBe(true);
    },
  );

  it("marks a newly delayed session as material", () => {
    expect(
      isMaterialEstimateChange(baseline, {
        ...baseline,
        sessionStatus: "delayed",
      }),
    ).toBe(true);
  });

  it("marks a newly cancelled session as material", () => {
    expect(
      isMaterialEstimateChange(baseline, {
        ...baseline,
        sessionStatus: "cancelled",
      }),
    ).toBe(true);
  });

  it("marks a newly approaching turn as material", () => {
    expect(
      isMaterialEstimateChange(baseline, {
        ...baseline,
        approachingTurn: true,
      }),
    ).toBe(true);
  });
});
