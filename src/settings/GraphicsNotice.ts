/**
 * A short notice over the game — the Auto guard's step ("Graphics lowered to
 * hold 60 FPS (resolution 90% → 85%)"): one line at the bottom center, for
 * a few seconds, never in the way (no pointer, no focus, under the network
 * debug panel).
 *
 * It lives in the GAME page, like the debug panel (#debug, same layer: above
 * the HUD's iframe): the HUD document is not touched (PERFORMANCE.md, rule
 * 31). Cheap on purpose, it appears at most a few times a session: plain
 * text on a flat translucent pill — no blur, no shadow, no gradient, so no
 * new raster shader of the browser (rule 15) — faded by ONE Web Animation of
 * its opacity (run by the compositor, on its own layer: rule 14), then out
 * of the rendering (display: none).
 */

/** How long a notice stays (ms): fade in, read, fade out. */
export const GRAPHICS_NOTICE_MS = 5200;

let box: HTMLDivElement | null = null;
let current: Animation | null = null;

export function showGraphicsNotice(text: string, ms = GRAPHICS_NOTICE_MS): void {
  if (typeof document === "undefined" || !document.body) return;
  if (!box) {
    box = document.createElement("div");
    box.id = "gfx-guard-notice";
    box.setAttribute("role", "status");
    box.setAttribute("aria-live", "polite");
    box.style.cssText = [
      "position: fixed",
      "left: 50%",
      "bottom: 46px",
      "transform: translateX(-50%)",
      "z-index: 11",
      "display: none",
      "max-width: 92vw",
      "padding: 4px 14px 3px",
      "border-radius: 999px",
      "background: rgba(16, 12, 8, 0.66)",
      "color: #f4ecd8",
      'font: 600 13px/1.35 "Baloo 2", system-ui, sans-serif',
      "letter-spacing: 0.3px",
      "white-space: nowrap",
      "overflow: hidden",
      "text-overflow: ellipsis",
      "pointer-events: none",
      "user-select: none",
      "opacity: 0",
      "will-change: opacity",
    ].join(";");
    document.body.appendChild(box);
  }
  const el = box;
  el.textContent = text;
  el.style.display = "block";
  current?.cancel();
  if (typeof el.animate !== "function") {
    // (No Web Animations: shown, then hidden.)
    el.style.opacity = "1";
    window.setTimeout(() => {
      if (box === el && el.textContent === text) el.style.display = "none";
    }, ms);
    return;
  }
  const anim = el.animate([{ opacity: 0 }, { opacity: 1, offset: 0.06 }, { opacity: 1, offset: 0.9 }, { opacity: 0 }], {
    duration: ms,
    easing: "linear",
  });
  current = anim;
  anim.onfinish = () => {
    if (current !== anim) return;
    current = null;
    el.style.display = "none";
  };
}
