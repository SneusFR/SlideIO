import { SpearWeapon } from "../weapons/SpearWeapon";
import { SpearConfig as sc } from "../weapons/SpearConfig";
import { AbilityChip } from "./hudKit";

const ACCENT = "#facc15"; // bean-prairie gold (same as the menu --mm-gold)

/**
 * SPEAR RUSH availability — a round ABILITY CHIP next to the weapon plate
 * (key cap "A", hold = charged rush): a gold conic sweep refills during
 * the cooldown, the chip pops + glows when READY, flashes while rushing.
 * Only touches the DOM when the displayed state actually changes.
 */
export class SpearHUD {
  private readonly chip: AbilityChip;
  private visible = false;

  constructor() {
    this.chip = new AbilityChip("spear-hud", "RUSH", "A", "spear", ACCENT);
  }

  /** Show/hide the chip (hidden when the lance is not equipped). */
  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    this.chip.setVisible(visible);
  }

  update(spear: SpearWeapon): void {
    if (!this.visible) return;

    const remaining = spear.rushCooldownRemaining;
    const rushing = spear.isRushing;
    const ready = remaining <= 0 && !rushing;
    const progress = rushing || ready ? 1 : 1 - remaining / sc.spearRushCooldown;
    const text = rushing || ready ? "" : remaining.toFixed(1);
    this.chip.set(progress, text, ready, rushing);
  }
}
