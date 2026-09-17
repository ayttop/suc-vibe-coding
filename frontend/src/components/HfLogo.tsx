import hfLogoUrl from "../assets/hf-logo.svg";

/**
 * Official Hugging Face emoji logo.
 *
 * Source SVG: copied from `reachy_mini_desktop_app/src/assets/hf-logo.svg`.
 */
export function HfLogo({ size = 20 }: { size?: number }) {
  return (
    <img
      src={hfLogoUrl}
      alt="Hugging Face"
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
