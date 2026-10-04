import { HitZone } from "../combat/HitZone";
import { HitFeedbackConfig as hfc } from "../combat/HitFeedbackConfig";

/**
 * Crosshair-centered hitmarker (DOM/CSS, zero per-frame JS). The centre stays free: the
 * hitmarker is 4 DIAGONAL arms only (between the 4 radial ticks of the crosshair).
 *
 * Three states, only ever triggered by a CONFIRMED hit:
 *  - BODY: short cream diagonals (100–160 ms).
 *  - HEAD: the same cream diagonals, bigger and pushed a little further out.
 *  - KILL: longer yellow diagonals with an outer accent dot (~260 ms). A late non-lethal
 *    confirmation arriving inside that window never overwrites it.
 *
 * All animation ends at opacity 0, so nothing lingers and no update() call is ever needed.
 * `show()` retriggers via the classic reflow trick.
 */
export class HitmarkerHUD {
  private readonly root: HTMLDivElement;

  constructor() {
    this.root = document.createElement("div");
    this.root.id = "hitmarker";
    // Configurable durations → CSS variables (single source: HitFeedbackConfig).
    this.root.style.setProperty("--hm-body-dur", `${hfc.bodyHitmarkerDuration}s`);
    this.root.style.setProperty("--hm-head-dur", `${hfc.headshotHitmarkerDuration}s`);
    this.root.style.setProperty("--hm-kill-dur", `${hfc.killHitmarkerDuration}s`);

    // 4 diagonal arms around the crosshair center.
    for (let i = 0; i < 4; i++) {
      const arm = document.createElement("div");
      arm.className = "hm-arm";
      arm.style.setProperty("--r", `${45 + i * 90}deg`);
      this.root.appendChild(arm);
    }

    document.body.appendChild(this.root);
  }

  /** Duration override currently written to the CSS variables (false = the default lifetimes). */
  private overridden = false;
  /** performance.now() until which a KILL pulse is protected from being overwritten. */
  private killUntil = 0;

  /**
   * Pulse the hitmarker. Retriggers cleanly even mid-animation.
   * `durationSec` (optional) = a shorter lifetime for THIS pulse only (rapid-fire weapons: every ball restarts a
   * short tick); omitted = the default lifetimes of HitFeedbackConfig, restored if a previous pulse overrode them.
   * `kill` = this hit eliminated the target: the longer yellow pulse (ignores `durationSec`).
   */
  show(zone: HitZone, durationSec?: number, kill = false): void {
    const now = performance.now();
    if (kill) {
      this.killUntil = now + hfc.killHitmarkerDuration * 1000;
    } else if (now < this.killUntil) {
      return; // a late non-lethal confirmation must not crush the elimination feedback
    }

    const head = zone === HitZone.HEAD;
    if (durationSec !== undefined && !kill) {
      this.root.style.setProperty(head ? "--hm-head-dur" : "--hm-body-dur", `${durationSec}s`);
      this.overridden = true;
    } else if (this.overridden) {
      this.root.style.setProperty("--hm-body-dur", `${hfc.bodyHitmarkerDuration}s`);
      this.root.style.setProperty("--hm-head-dur", `${hfc.headshotHitmarkerDuration}s`);
      this.overridden = false;
    }
    this.root.classList.remove("hm-body", "hm-head", "hm-kill");
    void this.root.offsetWidth; // reflow → restart the CSS animations
    this.root.classList.add(kill ? "hm-kill" : head ? "hm-head" : "hm-body");
  }
}
