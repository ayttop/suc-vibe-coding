import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useVirtualFS } from "../src/hooks/useVirtualFS";

// Invariant locked (preview flicker regression): `useVirtualFS().files` must
// keep a STABLE reference across re-renders that don't mutate the VFS.
//
// Why it matters: PreviewFrame's build effect depends on `files`. A parent
// re-render is triggered on every preview build (onDocReady -> setDocId sets
// diagnostics state). If `files` is a fresh array each render, that effect
// re-fires -> rebuild -> new docId -> <iframe key> remounts -> re-render ->
// ... an infinite ~300ms rebuild loop. In the P2 host preview that shows up
// as the Reachy sign-in screen "flickering" forever.

describe("useVirtualFS - referential stability (preview flicker guard)", () => {
  it("keeps `files` stable across re-renders that don't touch the VFS", () => {
    const { result, rerender } = renderHook(() => useVirtualFS());
    const first = result.current.files;
    rerender();
    rerender();
    expect(result.current.files).toBe(first);
  });

  it("returns a fresh `files` reference only when the VFS actually changes", () => {
    const { result, rerender } = renderHook(() => useVirtualFS());
    const before = result.current.files;
    act(() => result.current.writeFile("index.html", "<!doctype html>"));
    const afterWrite = result.current.files;
    expect(afterWrite).not.toBe(before);
    expect(afterWrite.map((f) => f.path)).toContain("index.html");
    // ...and stable again on the next unrelated re-render.
    rerender();
    expect(result.current.files).toBe(afterWrite);
  });
});
