import { describe, it, expect } from "vitest";
import {
  decideAutoFix,
  type AutoFixMemory,
  type AutoFixSignals,
} from "../src/lib/autofix";

// Invariant locked: the auto-fix loop ALWAYS terminates, and only retries
// on a genuine, changing, actionable defect.

const M0: AutoFixMemory = {
  attempts: 0,
  active: false,
  lastVfsHash: null,
  lastErrorSig: null,
};

function signals(p: Partial<AutoFixSignals>): AutoFixSignals {
  return {
    actionableCount: 1,
    actionableAllMissingAsset: false,
    booted: false,
    vfsHash: "h1",
    errorSig: "e1",
    maxAttempts: 3,
    ...p,
  };
}

describe("decideAutoFix - termination & robustness", () => {
  it("succeeds when nothing is actionable", () => {
    const { decision } = decideAutoFix(M0, signals({ actionableCount: 0 }));
    expect(decision).toEqual({ kind: "success" });
  });

  it("retries a fresh, actionable, changing error (incrementing attempts)", () => {
    const { decision, memory } = decideAutoFix(M0, signals({}));
    expect(decision).toEqual({ kind: "retry", attempt: 1 });
    expect(memory.attempts).toBe(1);
    expect(memory.active).toBe(true);
  });

  it("stops (no-progress) when the VFS is unchanged between attempts", () => {
    // After one retry, feed the SAME vfsHash again.
    const first = decideAutoFix(M0, signals({ vfsHash: "same" }));
    const second = decideAutoFix(
      first.memory,
      signals({ vfsHash: "same", errorSig: "e2" }),
    );
    expect(second.decision).toEqual({ kind: "stop", reason: "no-progress" });
  });

  it("stops (no-progress/stuck) when the SAME error-set persists despite edits", () => {
    const first = decideAutoFix(M0, signals({ vfsHash: "v1", errorSig: "E" }));
    // VFS changed (v2) but the identical actionable error-set (E) remains.
    const second = decideAutoFix(
      first.memory,
      signals({ vfsHash: "v2", errorSig: "E" }),
    );
    expect(second.decision).toEqual({ kind: "stop", reason: "no-progress" });
  });

  it("respects maxAttempts", () => {
    const mem: AutoFixMemory = { ...M0, attempts: 3, active: true };
    const { decision } = decideAutoFix(mem, signals({ maxAttempts: 3 }));
    expect(decision).toEqual({ kind: "stop", reason: "max-attempts" });
  });

  it("terminates on oscillation A->B->A within maxAttempts", () => {
    // Each step changes VFS and error-set (so neither no-progress guard
    // fires); the loop must still stop by exhausting attempts.
    let mem = M0;
    const seq = ["A", "B", "A", "B", "A", "B"];
    let steps = 0;
    for (let i = 0; i < seq.length; i++) {
      const { decision, memory } = decideAutoFix(
        mem,
        signals({ vfsHash: `v${i}`, errorSig: seq[i], maxAttempts: 3 }),
      );
      mem = memory;
      steps++;
      if (decision.kind !== "retry") {
        expect(decision).toEqual({ kind: "stop", reason: "max-attempts" });
        break;
      }
    }
    expect(steps).toBeLessThanOrEqual(4); // 3 retries + 1 stop
  });

  it("PROPERTY: for any input sequence, the loop terminates within maxAttempts and never throws", () => {
    // Seeded LCG so failures are reproducible without a fuzz dependency.
    let seed = 0x9e3779b9;
    const rnd = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0xffffffff;
    };
    for (let trial = 0; trial < 2000; trial++) {
      const maxAttempts = 1 + Math.floor(rnd() * 5);
      let mem: AutoFixMemory = { ...M0 };
      let calls = 0;
      let terminated = false;
      // Drive the loop: keep feeding signals while it says "retry".
      for (let i = 0; i < maxAttempts + 5; i++) {
        calls++;
        const s = signals({
          actionableCount: rnd() < 0.15 ? 0 : 1 + Math.floor(rnd() * 3),
          actionableAllMissingAsset: rnd() < 0.3,
          booted: rnd() < 0.5,
          vfsHash: rnd() < 0.5 ? "stable" : `v${Math.floor(rnd() * 4)}`,
          errorSig: `e${Math.floor(rnd() * 3)}`,
          maxAttempts,
        });
        const { decision, memory } = decideAutoFix(mem, s);
        mem = memory;
        expect(mem.attempts).toBeLessThanOrEqual(maxAttempts);
        if (decision.kind !== "retry") {
          terminated = true;
          break;
        }
      }
      // It must terminate within maxAttempts retries (+1 for the stop call).
      expect(terminated).toBe(true);
      expect(calls).toBeLessThanOrEqual(maxAttempts + 1);
    }
  });

  // Booted gate is the FIX (commit 2). RED before, GREEN after.
  it("booted gate: booted + only missing-asset artifacts -> success (no auto-fix)", () => {
    const { decision } = decideAutoFix(
      M0,
      signals({
        actionableCount: 1,
        actionableAllMissingAsset: true,
        booted: true,
      }),
    );
    expect(decision).toEqual({ kind: "success" });
  });
});
