// Pure helpers for the auto-fix loop. Kept dependency-free (no React, no
// SDK) so the termination invariants and the context-inlining guarantee are
// unit- and property-testable in isolation.

// ── Inline-context selection ────────────────────────────────────────────
// Per-file inline budget. Kept high enough that the 3 static app files
// (index.html ~18KB, main.js ~11KB, README) are ALWAYS inlined into the
// model's useful-context, so it edits against the real text instead of
// rewriting from a truncated view. TOTAL_CAP bounds the aggregate.
export const PER_FILE_CAP = 24_000;
export const TOTAL_CAP = 48_000;

export interface InlineFile {
  path: string;
  size: number;
  content?: string;
}

/**
 * Decide which files are inlined verbatim into the model's useful-context.
 * A file is inlined iff it fits under `perFileCap` AND the running total
 * budget still has room.
 */
export function selectInlineContext(
  files: { path: string; content: string }[],
  perFileCap: number = PER_FILE_CAP,
  totalCap: number = TOTAL_CAP,
): InlineFile[] {
  let budget = totalCap;
  return files.map((f) => {
    const inlineable =
      f.content.length <= perFileCap && budget - f.content.length >= 0;
    if (inlineable) budget -= f.content.length;
    return {
      path: f.path,
      size: f.content.length,
      content: inlineable ? f.content : undefined,
    };
  });
}

// ── Auto-fix decision ───────────────────────────────────────────────────
export interface AutoFixMemory {
  attempts: number;
  active: boolean;
  lastVfsHash: string | null;
  lastErrorSig: string | null;
}

export interface AutoFixSignals {
  actionableCount: number;
  /** true when every actionable diagnostic is a missing-local-asset
   *  compile-error (the build-race artifact). */
  actionableAllMissingAsset: boolean;
  /** the current preview document reported it executed (booted). */
  booted: boolean;
  vfsHash: string;
  errorSig: string;
  maxAttempts: number;
}

export type AutoFixDecision =
  | { kind: "success" }
  | { kind: "stop"; reason: "max-attempts" | "no-progress" }
  | { kind: "retry"; attempt: number };

/**
 * Given the loop memory and current signals, decide whether to retry an
 * auto-fix, stop, or declare success. Guarantees termination: it only
 * returns `retry` while incrementing `attempts`, and it stops at
 * `maxAttempts`, on an unchanged VFS, or on an unchanged actionable
 * error-set.
 */
export function decideAutoFix(
  mem: AutoFixMemory,
  s: AutoFixSignals,
): { decision: AutoFixDecision; memory: AutoFixMemory } {
  // Nothing actionable -> the turn succeeded.
  if (s.actionableCount === 0) {
    return { decision: { kind: "success" }, memory: { ...mem, active: false } };
  }
  // Booted gate: the app executed, and the only actionable items are
  // missing-local-asset build-race artifacts -> not a real defect, so don't
  // burn an auto-fix attempt on them.
  if (s.booted && s.actionableAllMissingAsset) {
    return { decision: { kind: "success" }, memory: { ...mem, active: false } };
  }
  if (mem.attempts >= s.maxAttempts) {
    return {
      decision: { kind: "stop", reason: "max-attempts" },
      memory: { ...mem, active: false },
    };
  }
  // Files unchanged since the last attempt -> no progress.
  if (mem.active && mem.lastVfsHash !== null && mem.lastVfsHash === s.vfsHash) {
    return {
      decision: { kind: "stop", reason: "no-progress" },
      memory: { ...mem, active: false },
    };
  }
  const memAfterVfs: AutoFixMemory = { ...mem, lastVfsHash: s.vfsHash };
  // Files changed but the SAME actionable errors persist -> stuck.
  if (
    memAfterVfs.active &&
    memAfterVfs.lastErrorSig !== null &&
    memAfterVfs.lastErrorSig === s.errorSig
  ) {
    return {
      decision: { kind: "stop", reason: "no-progress" },
      memory: { ...memAfterVfs, active: false },
    };
  }
  const attempt = memAfterVfs.attempts + 1;
  return {
    decision: { kind: "retry", attempt },
    memory: {
      ...memAfterVfs,
      lastErrorSig: s.errorSig,
      attempts: attempt,
      active: true,
    },
  };
}
