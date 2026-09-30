import { KillstreakManager, KILLSTREAK_SLOT_LABELS } from "../killstreaks/KillstreakManager";
import { KillstreakState } from "../killstreaks/KillstreakState";
import { hudFeed } from "./HudFeed";
import { killstreakColor, killstreakIconSvg, PADLOCK_SVG } from "./hudIcons";
import { replayAnim } from "./hudKit";

const SVG_NS = "http://www.w3.org/2000/svg";
/** Gap between two ring notches, in degrees (ring = pathLength 360). */
const NOTCH_GAP = 9;
const CONFETTI = 8;

interface Medal {
  root: HTMLDivElement;
  ring: SVGSVGElement;
  art: HTMLDivElement;
  count: HTMLSpanElement;
  segs: SVGCircleElement[];
  /** Id currently drawn (icon + notches are rebuilt only when it changes). */
  drawnId: string;
  lastState: string;
  lastKills: number;
}

/**
 * KILLSTREAK MEDALLIONS (bottom-right, above the weapon plate) — one big
 * round medallion per equipped slot (keys W / X / C), empty slots hidden:
 *
 *   LOCKED  greyed silhouette + padlock; a notched gold ring (one notch
 *           per required kill) fills kill after kill, each notch pops in.
 *   UNLOCK  the padlock bursts in two halves, colours flood back with a
 *           bounce, sun rays spin behind + confetti, a "READY" sticker
 *           lands in the top-centre event feed.
 *   READY   gold rim, gentle float, a shine sweep, and the key cap hops.
 *   ACTIVE  warm pulsing glow + spinning ring.
 *   SPENT   washed-out with a "USED" stamp.
 *
 * Re-renders from manager callbacks wired in Game (manager.onChanged →
 * render, manager.onReady → notifyReady). DOM is built once; render only
 * swaps classes (and rebuilds a medallion when its equipped id changes).
 */
export class KillstreakHUD {
  private readonly root: HTMLElement;
  private readonly medals: Medal[] = [];

  constructor(private readonly manager: KillstreakManager) {
    this.root = document.createElement("div");
    this.root.id = "killstreak-hud";

    for (let i = 0; i < 3; i++) {
      const root = document.createElement("div");
      root.className = "ks-medal empty";
      root.innerHTML = `
        <div class="ks-rays"></div>
        <div class="ks-confetti">${"<i></i>".repeat(CONFETTI)}</div>
        <div class="ks-disc">
          <div class="ks-art"></div>
          <div class="ks-lock">${PADLOCK_SVG}</div>
          <span class="ks-count"></span>
          <span class="ks-used">USED</span>
        </div>
        <span class="ks-key">${KILLSTREAK_SLOT_LABELS[i]}</span>`;
      const ring = document.createElementNS(SVG_NS, "svg");
      ring.setAttribute("class", "ks-ring");
      ring.setAttribute("viewBox", "0 0 80 80");
      ring.setAttribute("aria-hidden", "true");
      root.insertBefore(ring, root.querySelector(".ks-disc"));
      this.medals.push({
        root,
        ring,
        art: root.querySelector(".ks-art")!,
        count: root.querySelector(".ks-count")!,
        segs: [],
        drawnId: "",
        lastState: "",
        lastKills: -1,
      });
      this.root.appendChild(root);
    }

    // Mounted at the TOP of the bottom-right column, above the weapon plate.
    const col = document.getElementById("right-hud-col");
    if (col) {
      col.insertBefore(this.root, col.firstChild);
    } else {
      (document.getElementById("hud") ?? document.body).appendChild(this.root);
    }
    this.render();
  }

  /** (Re)build the icon + notched ring of a medallion for a new streak id. */
  private draw(m: Medal, id: string, required: number): void {
    m.drawnId = id;
    m.root.style.setProperty("--ks", killstreakColor(id));
    m.art.innerHTML = killstreakIconSvg(id);
    while (m.ring.firstChild) m.ring.removeChild(m.ring.firstChild);
    m.segs = [];

    const track = document.createElementNS(SVG_NS, "circle");
    track.setAttribute("class", "ks-ring-track");
    track.setAttribute("cx", "40");
    track.setAttribute("cy", "40");
    track.setAttribute("r", "35");
    m.ring.appendChild(track);

    const n = Math.max(1, required);
    const span = 360 / n;
    const len = Math.max(4, span - NOTCH_GAP);
    for (let s = 0; s < n; s++) {
      const c = document.createElementNS(SVG_NS, "circle");
      c.setAttribute("class", "ks-seg");
      c.setAttribute("cx", "40");
      c.setAttribute("cy", "40");
      c.setAttribute("r", "35");
      c.setAttribute("pathLength", "360");
      c.setAttribute("stroke-dasharray", `${len} 360`);
      // Start at 12 o'clock, clockwise; centre the gap between notches.
      c.setAttribute("transform", `rotate(${-90 + s * span + NOTCH_GAP / 2} 40 40)`);
      m.ring.appendChild(c);
      m.segs.push(c);
    }
    m.lastKills = -1;
  }

  /** Full re-render from manager state (cheap: 3 medallions of classes). */
  render(): void {
    for (let i = 0; i < 3; i++) {
      const slot = this.manager.slots[i];
      const m = this.medals[i];

      if (slot.isEmpty || !slot.def) {
        if (m.lastState !== "empty") {
          m.lastState = "empty";
          m.root.className = "ks-medal empty";
          m.drawnId = "";
        }
        continue;
      }

      const def = slot.def;
      if (m.drawnId !== def.id) this.draw(m, def.id, def.requiredKills);

      const state =
        slot.state === KillstreakState.LOCKED
          ? "locked"
          : slot.state === KillstreakState.READY
            ? "ready"
            : slot.state === KillstreakState.ACTIVE
              ? "active"
              : "spent";
      if (state !== m.lastState) {
        m.lastState = state;
        m.root.classList.remove("empty", "locked", "ready", "active", "spent");
        m.root.classList.add(state);
      }

      // Notches: lit up to the kill count (all lit once armed / active).
      const lit = state === "locked" ? slot.kills : state === "spent" ? 0 : m.segs.length;
      if (lit !== m.lastKills) {
        const animate = m.lastKills >= 0 && state === "locked";
        for (let s = 0; s < m.segs.length; s++) {
          const on = s < lit;
          const seg = m.segs[s];
          if (seg.classList.contains("on") === on) continue;
          seg.classList.toggle("on", on);
          // Pop only the notches gained by a kill (not a death reset).
          if (on && animate) replayAnim(seg, "pop");
        }
        m.lastKills = lit;
      }

      const countText = state === "locked" ? `${slot.kills}/${def.requiredKills}` : "";
      if (m.count.textContent !== countText) m.count.textContent = countText;
    }
  }

  /** A kill landed: the charging medallions give a little "gulp". */
  notifyKill(): void {
    for (let i = 0; i < 3; i++) {
      const slot = this.manager.slots[i];
      if (slot.isEmpty || slot.state !== KillstreakState.LOCKED) continue;
      replayAnim(this.medals[i].ring, "gulp");
    }
  }

  /** Big unlock moment on the slot that just became READY. */
  notifyReady(slotIndex: number): void {
    const m = this.medals[slotIndex];
    if (!m) return;
    replayAnim(m.root, "unlock");
    const def = this.manager.slots[slotIndex]?.def;
    if (def) hudFeed().push("streak", def.name, `READY [${KILLSTREAK_SLOT_LABELS[slotIndex]}]`);
  }
}
