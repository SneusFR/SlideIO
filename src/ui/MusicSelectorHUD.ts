import { MUSIC_TRACKS } from "../weapons/bassblaster/MusicTrackPlayer";
import { BassBlasterConfig as cfg } from "../weapons/bassblaster/BassBlasterConfig";

/**
 * Bass Blaster SOUNDTRACK selector — right side, right below the FFA
 * leaderboard.
 *
 * Behavior:
 *   - ↑ / ↓ cycles the active track (the Game forwards the key edges);
 *   - any interaction EXPANDS the panel (full track list + hints);
 *   - after a few seconds without interaction it auto-MINIMIZES into a
 *     slim chip showing only "♪ ACTIVE TRACK";
 *   - the next interaction instantly re-expands it.
 *
 * Pure presentation: it never owns gameplay state — the Game pushes the
 * active index in, and the arrows only fire a callback.
 */
export class MusicSelectorHUD {
  /** Fired when the player cycles with the arrows (-1 = up, +1 = down). */
  onCycle: ((delta: number) => void) | null = null;

  private readonly root: HTMLDivElement;
  private readonly titleEl: HTMLDivElement;
  private readonly listEl: HTMLDivElement;
  private readonly hintEl: HTMLDivElement;
  private readonly chipEl: HTMLDivElement;
  private readonly rows: HTMLDivElement[] = [];

  private activeIndex = 0;
  private idleTimer = 0;
  private expanded = false;
  private lastVisible: boolean | null = null;
  /** Throttle for the leaderboard-relative positioning. */
  private layoutTimer = 0;

  constructor() {
    this.root = document.createElement("div");
    this.root.id = "music-selector-hud";
    this.root.style.cssText = [
      "position:fixed",
      "right:16px",
      "top:250px", // repositioned under the leaderboard every update
      "width:252px",
      "box-sizing:border-box",
      "display:none",
      "flex-direction:column",
      "gap:6px",
      "padding:8px 10px",
      "background:linear-gradient(165deg, rgba(21,11,38,0.55), rgba(9,5,18,0.5))",
      "border:1px solid rgba(168,85,247,0.32)",
      "border-radius:8px",
      "box-shadow:0 0 14px rgba(124,58,237,0.14), inset 0 0 24px rgba(124,58,237,0.07)",
      "backdrop-filter:blur(2px)",
      "font-family:'Rajdhani','Segoe UI',sans-serif",
      "color:#e9d5ff",
      "pointer-events:none",
      "z-index:40",
      "transition:opacity 0.25s ease",
    ].join(";");

    this.titleEl = document.createElement("div");
    this.titleEl.textContent = "\u266A SOUNDTRACK";
    this.titleEl.style.cssText = [
      "font-family:'Orbitron',sans-serif",
      "font-size:10px",
      "font-weight:600",
      "letter-spacing:3px",
      "text-align:center",
      "color:#c084fc",
      "text-shadow:0 0 8px rgba(168,85,247,0.55)",
    ].join(";");
    this.root.appendChild(this.titleEl);

    // Full track list (expanded state).
    this.listEl = document.createElement("div");
    this.listEl.style.cssText = "display:flex;flex-direction:column;gap:3px";
    for (let i = 0; i < MUSIC_TRACKS.length; i++) {
      const row = document.createElement("div");
      row.style.cssText = [
        "display:flex",
        "align-items:center",
        "gap:8px",
        "padding:4px 8px",
        "border-radius:5px",
        "font-size:13px",
        "font-weight:600",
        "letter-spacing:1.5px",
        "transition:all 0.15s ease",
      ].join(";");
      const icon = document.createElement("span");
      icon.textContent = "\u266B";
      icon.style.cssText = "font-size:12px;opacity:0.8";
      const name = document.createElement("span");
      name.textContent = MUSIC_TRACKS[i].title;
      row.append(icon, name);
      this.listEl.appendChild(row);
      this.rows.push(row);
    }
    this.root.appendChild(this.listEl);

    this.hintEl = document.createElement("div");
    this.hintEl.textContent = "\u2191 / \u2193 — CHANGER DE MORCEAU";
    this.hintEl.style.cssText = [
      "font-size:9px",
      "letter-spacing:2px",
      "text-align:center",
      "color:rgba(216,180,254,0.55)",
    ].join(";");
    this.root.appendChild(this.hintEl);

    // Minimized chip (collapsed state): "♪ TRACK NAME".
    this.chipEl = document.createElement("div");
    this.chipEl.style.cssText = [
      "display:none",
      "align-items:center",
      "justify-content:center",
      "gap:6px",
      "font-size:12px",
      "font-weight:600",
      "letter-spacing:2px",
      "color:#d8b4fe",
      "text-shadow:0 0 6px rgba(168,85,247,0.6)",
    ].join(";");
    this.root.appendChild(this.chipEl);

    document.body.appendChild(this.root);
    this.renderRows();
    this.setExpanded(false, true);
  }

  /** Show/hide the whole selector (visible only with the blaster equipped). */
  setVisible(visible: boolean): void {
    if (visible === this.lastVisible) return;
    this.lastVisible = visible;
    this.root.style.display = visible ? "flex" : "none";
    if (visible) this.reposition();
  }

  /** Player pressed ↑ (delta -1) or ↓ (delta +1): expand + notify. */
  interact(delta: number): void {
    this.onCycle?.(delta);
    this.idleTimer = 0;
    if (!this.expanded) this.setExpanded(true);
    this.reposition();
  }

  /** Reflect the ACTIVE track (the Game pushes the source of truth in). */
  setActiveIndex(index: number): void {
    if (index === this.activeIndex) return;
    this.activeIndex = index;
    this.renderRows();
  }

  update(dt: number): void {
    if (this.lastVisible === false) return;

    // Auto-minimize after a short idle delay.
    if (this.expanded) {
      this.idleTimer += dt;
      if (this.idleTimer >= cfg.selectorIdleSeconds) this.setExpanded(false);
    }

    // Follow the (dynamic-height) leaderboard — cheap, throttled.
    this.layoutTimer -= dt;
    if (this.layoutTimer <= 0) {
      this.layoutTimer = 0.5;
      this.reposition();
    }
  }

  // ------------------------------------------------------------------

  private renderRows(): void {
    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i];
      if (i === this.activeIndex) {
        row.style.background = "rgba(124,58,237,0.28)";
        row.style.border = "1px solid rgba(168,85,247,0.55)";
        row.style.color = "#f3e8ff";
        row.style.textShadow = "0 0 8px rgba(216,180,254,0.8)";
      } else {
        row.style.background = "rgba(124,58,237,0.06)";
        row.style.border = "1px solid rgba(168,85,247,0.12)";
        row.style.color = "rgba(216,180,254,0.6)";
        row.style.textShadow = "none";
      }
    }
    this.chipEl.textContent = `\u266A ${MUSIC_TRACKS[this.activeIndex]?.title ?? ""}`;
  }

  private setExpanded(expanded: boolean, force = false): void {
    if (!force && expanded === this.expanded) return;
    this.expanded = expanded;
    this.idleTimer = 0;
    this.titleEl.style.display = expanded ? "block" : "none";
    this.listEl.style.display = expanded ? "flex" : "none";
    this.hintEl.style.display = expanded ? "block" : "none";
    this.chipEl.style.display = expanded ? "none" : "flex";
    this.root.style.opacity = expanded ? "1" : "0.75";
    this.root.style.padding = expanded ? "8px 10px" : "5px 10px";
    this.renderRows();
  }

  /** Anchor the panel just below the leaderboard (whatever its height). */
  private reposition(): void {
    const lb = document.getElementById("leaderboard-hud");
    if (lb && !lb.classList.contains("hidden")) {
      const rect = lb.getBoundingClientRect();
      this.root.style.top = `${Math.round(rect.bottom + 10)}px`;
    } else {
      this.root.style.top = "72px"; // leaderboard hidden → its usual spot
    }
  }
}