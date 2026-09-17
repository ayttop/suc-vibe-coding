import reachyHeadUrl from "../assets/reachy-head.svg";

/**
 * Illustrated Reachy Mini head, used as the app's brand mark in the top bar.
 *
 * Source SVG: `reachy_mini_desktop_app/src/assets/reachy-head.svg`
 * (multi-color illustration, not theme-colored via `currentColor`).
 */
export function ReachyLogo({ size = 28 }: { size?: number }) {
  return (
    <img
      src={reachyHeadUrl}
      alt="Reachy Mini"
      width={size}
      height={size}
      draggable={false}
      style={{
        display: "inline-block",
        flex: "0 0 auto",
        objectFit: "contain",
        userSelect: "none",
      }}
    />
  );
}
