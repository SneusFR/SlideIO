import { KILLSTREAK_SLOT_LABELS } from "../killstreaks/KillstreakManager";
import { KillstreakState } from "../killstreaks/KillstreakState";
import type { KillstreakView } from "../hud/protocol";
import { killstreakIconSvg } from "./hudIcons";
import { replayAnim } from "./hudKit";

/** Width of the reference frame the capsules were measured on (= leaderboard's). */
const REF_WIDTH = 1816;

/** Display order of the column, top → bottom (cheapest streak on top). */
const ORDER = ["MOLE_STRIKE", "ORBITAL_SCAN", "NOVA_STRIKE"] as const;

interface Capsule {
  root: HTMLDivElement;
  count: HTMLSpanElement;
  key: HTMLSpanElement;
  /** Equipped slot index shown by this capsule (-1 = not equipped → hidden). */
  slot: number;
  shown: string;
  ready: boolean | null;
}

/**
 * KILLSTREAK CAPSULES (right edge, above the weapon plate): one compact
 * capsule per equipped killstreak, in a fixed order (Mole → Scan → Nova),
 * each holding only [ pictogram · acquired/required · key cap ].
 *
 *   NOT AVAILABLE  cream capsule, ink outline, black & white pictogram,
 *                  dark counter (charging, already used, or running).
 *   AVAILABLE      the slot is READY: HUD cyan capsule, the pictogram takes
 *                  its colours back, and the real activation key cap shows.
 *
 * Display only: progress, availability, death resets, consumption and
 * equipment all come from the game's KillstreakManager (Game wires onChanged
 * → render and onReady → notifyReady); `view.slots` is its slots as of the
 * last render (the HUD runtime swaps in each copy the game sends). The DOM is
 * built once; render only touches text / classes when something changed.
 * Drawn in the 1816px reference space and scaled with the window like the
 * leaderboard (--ks-s).
 */
export class KillstreakHUD {
  private readonly root: HTMLElement;
  private readonly caps: Capsule[] = [];
  private readonly onResize = (): void => this.syncScale();

  constructor(private readonly manager: KillstreakView) {
    this.root = document.createElement("div");
    this.root.id = "killstreak-hud";

    for (const id of ORDER) {
      const root = document.createElement("div");
      root.className = "ks-cap";
      root.dataset.ks = id;
      root.innerHTML = `
        <span class="ks-pic">${killstreakIconSvg(id)}</span>
        <span class="ks-count"></span>
        <span class="ks-key"></span>`;
      this.caps.push({
        root,
        count: root.querySelector(".ks-count")!,
        key: root.querySelector(".ks-key")!,
        slot: -1,
        shown: "",
        ready: null,
      });
      this.root.appendChild(root);
    }

    // Mounted at the TOP of the bottom-right column, above the weapon plate.
    const col = document.getElementById("right-hud-col");
    if (col) col.insertBefore(this.root, col.firstChild);
    else (document.getElementById("hud") ?? document.body).appendChild(this.root);

    window.addEventListener("resize", this.onResize);
    this.syncScale();
    this.render();
  }

  /** Re-render from the manager state (cheap: three capsules). */
  render(): void {
    const slots = this.manager.slots;
    let any = false;
    for (let c = 0; c < ORDER.length; c++) {
      const cap = this.caps[c];
      const slot = slots.findIndex((s) => s.def?.id === ORDER[c]);
      if (slot !== cap.slot) {
        cap.slot = slot;
        cap.root.classList.toggle("on", slot >= 0);
        cap.key.textContent = slot >= 0 ? KILLSTREAK_SLOT_LABELS[slot] : "";
        cap.ready = null;
      }
      if (slot < 0) continue;
      any = true;

      const s = slots[slot];
      const req = s.def!.requiredKills;
      // A charged slot (ready, running or used) reads full; charging = kills.
      const got = s.state === KillstreakState.LOCKED ? Math.min(s.kills, req) : req;
      const text = `${got}/${req}`;
      if (text !== cap.shown) {
        cap.shown = text;
        cap.count.textContent = text;
        // Five characters (10/25 … 25/25): tighter digits, same capsule size.
        cap.root.classList.toggle("w5", text.length >= 5);
      }
      const ready = s.state === KillstreakState.READY;
      if (ready !== cap.ready) {
        cap.ready = ready;
        cap.root.classList.toggle("ready", ready);
      }
    }
    this.root.classList.toggle("hidden", !any);
  }

  /** The slot just became READY: one short pulse of its capsule. */
  notifyReady(slotIndex: number): void {
    const id = this.manager.slots[slotIndex]?.def?.id;
    const cap = this.caps.find((c) => c.root.dataset.ks === id);
    if (cap) replayAnim(cap.root, "pulse");
  }

  dispose(): void {
    window.removeEventListener("resize", this.onResize);
    this.root.remove();
  }

  /**
   * Same rule as the leaderboard (innerWidth / 1816, clamped), divided by
   * the zoom the responsive rules put on #right-hud-col so the capsules keep
   * exactly the reference proportion of the screen width.
   */
  private syncScale(): void {
    const s = Math.min(2.6, Math.max(0.7, window.innerWidth / REF_WIDTH));
    const col = this.root.parentElement;
    const colZoom = col ? Number.parseFloat(getComputedStyle(col).zoom) || 1 : 1;
    this.root.style.setProperty("--ks-s", (s / colZoom).toFixed(4));
  }
}
