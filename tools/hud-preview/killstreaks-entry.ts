import { advance, freeze } from "./virtual-time";
import { KillstreakManager } from "../../src/killstreaks/KillstreakManager";
import { KillstreakHUD } from "../../src/ui/KillstreakHUD";
import { PaintballRifleHUD } from "../../src/ui/PaintballRifleHUD";
import { PaintballRifleConfig } from "../../shared/combat/PaintballRifleRules";
import type { KillstreakLoadout } from "../../src/loadout/Loadout";

/**
 * Killstreak-HUD preview entry: the REAL KillstreakManager + KillstreakHUD
 * wired exactly like Game.ts (onChanged → render, onReady → notifyReady),
 * above the REAL Paintball plate. Kills / deaths / activations go through the
 * manager, never through the HUD. Exposed as window.ks for the CDP driver.
 */
const manager = new KillstreakManager();
const hud = new KillstreakHUD(manager);
manager.onChanged = () => hud.render();
manager.onReady = (i) => hud.notifyReady(i);

const plate = new PaintballRifleHUD(PaintballRifleConfig.capacity);
plate.setVisible(true);
plate.update({ ammo: PaintballRifleConfig.capacity, isReloading: false });

(window as unknown as { ks: unknown }).ks = {
  equip(ids: KillstreakLoadout): void {
    manager.setEquipped(ids);
    freeze();
  },
  kills(n: number): void {
    for (let i = 0; i < n; i++) manager.onPlayerKill();
    freeze();
  },
  death(): void {
    manager.onPlayerDeath();
    freeze();
  },
  /** Press the slot key: READY → ACTIVE (same calls as Game.handleKillstreakInput). */
  use(slot: number): boolean {
    if (!manager.peekReady(slot)) return false;
    manager.confirmActivation(slot);
    freeze();
    return true;
  },
  finish(slot: number): void {
    manager.completeActivation(slot);
    freeze();
  },
  step(ms: number): void {
    let left = ms;
    while (left > 1e-6) {
      const d = Math.min(left, 1000 / 60);
      plate.update({ ammo: PaintballRifleConfig.capacity, isReloading: false });
      advance(d);
      left -= d;
    }
  },
  /** Capsule geometry (CSS px) + text, top → bottom. */
  caps(): unknown[] {
    return [...document.querySelectorAll<HTMLElement>("#killstreak-hud .ks-cap")]
      .filter((el) => getComputedStyle(el).display !== "none")
      .map((el) => {
        const r = el.getBoundingClientRect();
        const k = el.querySelector<HTMLElement>(".ks-key")!;
        const t = el.querySelector<HTMLElement>(".ks-count")!.getBoundingClientRect();
        const kr = k.getBoundingClientRect();
        return {
          id: el.dataset.ks,
          x: Math.round(r.x * 10) / 10, y: Math.round(r.y * 10) / 10,
          w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10,
          text: el.querySelector(".ks-count")!.textContent,
          ready: el.classList.contains("ready"),
          key: getComputedStyle(k).display === "none" ? "" : k.textContent,
          bg: getComputedStyle(el).backgroundColor,
          /** Counter text box and key box, relative to the capsule's left edge. */
          textL: Math.round(t.left - r.left), textR: Math.round(t.right - r.left),
          keyL: kr.width ? Math.round(kr.left - r.left) : null, keyR: kr.width ? Math.round(kr.right - r.left) : null,
        };
      });
  },
  animations: () => document.getAnimations().filter((a) => a.playState !== "finished").length,
};
