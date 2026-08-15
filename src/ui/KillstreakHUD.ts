import { KillstreakManager } from "../killstreaks/KillstreakManager";
import { KillstreakState } from "../killstreaks/KillstreakState";

/**
 * Bottom-right killstreak panel: 3 rows (keys 1/2/3), each showing the
 * equipped streak, kill progress and state (LOCKED / READY / ACTIVE / SPENT).
 * Self-contained: injects its own CSS, re-renders from manager callbacks
 * wired in Game (manager.onChanged → render, manager.onReady → notifyReady).
 */
export class KillstreakHUD {
  private readonly root: HTMLElement;
  private readonly rows: HTMLElement[] = [];

  constructor(private readonly manager: KillstreakManager) {
    injectStyles();
    this.root = document.createElement("div");
    this.root.id = "killstreak-hud";
    const header = document.createElement("div");
    header.className = "ks-header";
    header.textContent = "KILLSTREAKS";
    this.root.appendChild(header);

    for (let i = 0; i < 3; i++) {
      const row = document.createElement("div");
      row.className = "ks-row";
      row.innerHTML = `
        <span class="ks-key">${i + 1}</span>
        <span class="ks-name"></span>
        <span class="ks-progress"></span>
        <div class="ks-bar"><div class="ks-fill"></div></div>
      `;
      this.rows.push(row);
      this.root.appendChild(row);
    }

    const parent = document.getElementById("hud") ?? document.body;
    parent.appendChild(this.root);
    this.render();
  }

  /** Full re-render from manager state (cheap: 3 rows of text/classes). */
  render(): void {
    for (let i = 0; i < 3; i++) {
      const slot = this.manager.slots[i];
      const row = this.rows[i];
      const name = row.querySelector<HTMLElement>(".ks-name")!;
      const progress = row.querySelector<HTMLElement>(".ks-progress")!;
      const fill = row.querySelector<HTMLElement>(".ks-fill")!;

      row.classList.remove("empty", "locked", "ready", "active", "spent");

      if (slot.isEmpty || !slot.def) {
        row.classList.add("empty");
        name.textContent = "—";
        progress.textContent = "";
        fill.style.width = "0%";
        continue;
      }

      name.textContent = slot.def.shortName;
      const required = slot.def.requiredKills;

      switch (slot.state) {
        case KillstreakState.LOCKED:
          row.classList.add("locked");
          progress.textContent = `${slot.kills}/${required}`;
          fill.style.width = `${Math.min(100, (slot.kills / required) * 100)}%`;
          break;
        case KillstreakState.READY:
          row.classList.add("ready");
          progress.textContent = `PRESS ${i + 1}`;
          fill.style.width = "100%";
          break;
        case KillstreakState.ACTIVE:
          row.classList.add("active");
          progress.textContent = "ACTIVE";
          fill.style.width = "100%";
          break;
        case KillstreakState.SPENT:
          row.classList.add("spent");
          progress.textContent = "USED";
          fill.style.width = "0%";
          break;
      }
    }
  }

  /** Brief progress flash on the rows that just gained a kill. */
  notifyKill(): void {
    for (let i = 0; i < 3; i++) {
      const slot = this.manager.slots[i];
      if (slot.isEmpty || slot.state !== KillstreakState.LOCKED) continue;
      this.flashClass(this.rows[i], "flash", 260);
    }
  }

  /** Unlock pop animation on the slot that just became READY. */
  notifyReady(slotIndex: number): void {
    const row = this.rows[slotIndex];
    if (row) this.flashClass(row, "unlock", 700);
  }

  private flashClass(el: HTMLElement, cls: string, ms: number): void {
    el.classList.remove(cls);
    void el.offsetWidth; // restart the CSS animation
    el.classList.add(cls);
    window.setTimeout(() => el.classList.remove(cls), ms);
  }
}

let stylesInjected = false;

function injectStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    #killstreak-hud {
      position: absolute;
      right: 30px;
      bottom: 132px;
      z-index: 10;
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-family: "Segoe UI", system-ui, sans-serif;
      pointer-events: none;
      user-select: none;
      text-align: right;
    }
    #killstreak-hud .ks-header {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 3px;
      color: rgba(216, 180, 254, 0.55);
      margin-bottom: 2px;
    }
    #killstreak-hud .ks-row {
      display: grid;
      grid-template-columns: 16px 1fr auto;
      grid-template-rows: auto 3px;
      align-items: baseline;
      column-gap: 8px;
      row-gap: 3px;
      min-width: 178px;
      padding: 5px 9px 6px;
      border-radius: 6px;
      background: rgba(10, 6, 20, 0.55);
      border: 1px solid rgba(168, 85, 247, 0.18);
      transition: border-color 0.2s ease, background 0.2s ease, opacity 0.2s ease;
    }
    #killstreak-hud .ks-key {
      font-size: 10px;
      font-weight: 800;
      color: rgba(216, 180, 254, 0.7);
      border: 1px solid rgba(168, 85, 247, 0.35);
      border-radius: 3px;
      text-align: center;
      line-height: 14px;
      width: 14px;
      height: 14px;
    }
    #killstreak-hud .ks-name {
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 1.5px;
      color: #e9d5ff;
      text-align: left;
      white-space: nowrap;
    }
    #killstreak-hud .ks-progress {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 1px;
      color: rgba(216, 180, 254, 0.75);
      white-space: nowrap;
    }
    #killstreak-hud .ks-bar {
      grid-column: 1 / -1;
      height: 3px;
      border-radius: 2px;
      background: rgba(168, 85, 247, 0.15);
      overflow: hidden;
    }
    #killstreak-hud .ks-fill {
      height: 100%;
      width: 0%;
      border-radius: 2px;
      background: linear-gradient(90deg, #7c3aed, #c084fc);
      transition: width 0.25s ease;
    }
    /* Empty slot */
    #killstreak-hud .ks-row.empty { opacity: 0.28; }
    #killstreak-hud .ks-row.empty .ks-name { color: rgba(233, 213, 255, 0.5); }
    /* Locked: desaturated, progress visible */
    #killstreak-hud .ks-row.locked { opacity: 0.75; }
    #killstreak-hud .ks-row.locked .ks-name { color: rgba(233, 213, 255, 0.75); }
    /* Ready: violet glow + pulse */
    #killstreak-hud .ks-row.ready {
      border-color: rgba(192, 132, 252, 0.9);
      background: rgba(52, 18, 82, 0.72);
      box-shadow: 0 0 14px rgba(168, 85, 247, 0.45);
      animation: ks-ready-pulse 1.4s ease-in-out infinite;
    }
    #killstreak-hud .ks-row.ready .ks-progress { color: #f3e8ff; }
    #killstreak-hud .ks-row.ready .ks-fill {
      background: linear-gradient(90deg, #a855f7, #f0abfc);
    }
    /* Active: bright highlight */
    #killstreak-hud .ks-row.active {
      border-color: rgba(240, 171, 252, 1);
      background: rgba(88, 28, 135, 0.8);
      box-shadow: 0 0 18px rgba(216, 180, 254, 0.6);
    }
    #killstreak-hud .ks-row.active .ks-progress { color: #ffffff; }
    /* Spent */
    #killstreak-hud .ks-row.spent { opacity: 0.4; }
    #killstreak-hud .ks-row.spent .ks-name {
      text-decoration: line-through;
      color: rgba(233, 213, 255, 0.55);
    }
    /* Kill flash on locked rows */
    #killstreak-hud .ks-row.flash {
      animation: ks-kill-flash 0.26s ease-out;
    }
    /* Unlock pop when a streak becomes READY */
    #killstreak-hud .ks-row.unlock {
      animation: ks-unlock-pop 0.7s cubic-bezier(0.2, 1.6, 0.4, 1);
    }
    @keyframes ks-ready-pulse {
      0%, 100% { box-shadow: 0 0 10px rgba(168, 85, 247, 0.35); }
      50% { box-shadow: 0 0 20px rgba(192, 132, 252, 0.65); }
    }
    @keyframes ks-kill-flash {
      0% { background: rgba(168, 85, 247, 0.5); }
      100% { background: rgba(10, 6, 20, 0.55); }
    }
    @keyframes ks-unlock-pop {
      0% { transform: scale(1.12); filter: brightness(2); }
      100% { transform: scale(1); filter: brightness(1); }
    }
  `;
  document.head.appendChild(style);
}