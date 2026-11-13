import { describe, expect, it } from "vitest";
import { progressLabel, progressPercent, sendOutcome } from "./sendProgress.js";

// PHOTOFRAME-002: a 25-photo batch must never print "26 / 25".
describe("progressLabel", () => {
  it("names the photo in flight, one-based", () => {
    expect(progressLabel(0, 25)).toBe("Sending 1 of 25");
    expect(progressLabel(24, 25)).toBe("Sending 25 of 25");
  });

  it("stops at the total instead of running past it", () => {
    expect(progressLabel(25, 25)).toBe("Sent 25 of 25");
    // the old template expression, for comparison: done + 1 = 26 of 25
    expect(progressLabel(25, 25)).not.toBe(`Sending ${25 + 1} of 25`);
  });

  it("is safe on nonsense counts", () => {
    expect(progressLabel(0, 0)).toBe("Nothing to send");
    expect(progressLabel(-3, 5)).toBe("Sending 1 of 5");
    expect(progressLabel(99, 5)).toBe("Sent 5 of 5");
  });
});

describe("progressPercent", () => {
  it("never exceeds the bar", () => {
    expect(progressPercent(0, 25)).toBe(0);
    expect(progressPercent(12, 25)).toBeCloseTo(48);
    expect(progressPercent(25, 25)).toBe(100);
    expect(progressPercent(26, 25)).toBe(100);
    expect(progressPercent(1, 0)).toBe(0);
  });
});

describe("sendOutcome", () => {
  it("says what to do when the frame slept mid-batch", () => {
    const r = sendOutcome({ sent: 20, failed: 1, left: 4, asleep: true });
    expect(r.level).toBe("warning");
    expect(r.text).toContain("20 sent, 1 failed");
    expect(r.text).toContain("4 left");
    expect(r.text).toContain("Refresh");
  });

  it("promises that a retry sends only the failures", () => {
    const r = sendOutcome({ sent: 24, failed: 1, left: 1 });
    expect(r.text).toContain("24 sent, 1 failed");
    expect(r.text).toContain("retries only those");
  });

  it("is silent when everything went through", () => {
    expect(sendOutcome({ sent: 25, failed: 0, left: 0 })).toBeNull();
  });
});
