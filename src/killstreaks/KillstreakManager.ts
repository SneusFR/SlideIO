import { KillstreakId } from "../loadout/Loadout";
import { getKillstreakDef, KillstreakDef } from "./KillstreakDefs";
import { KillstreakSlot } from "./KillstreakSlot";
import { KillstreakState } from "./KillstreakState";

/**
 * Owns the three equipped killstreak slots and their per-life lifecycle.
 * Pure state machine — no rendering, no audio, no ability logic: the Game
 * wires HUD/SFX through the callbacks and drives the actual abilities.
 *
 * Guarantees:
 * - Only LOCKED slots accumulate kills (single use per life is structural).
 * - Death resets EVERY slot (progress, ready, spent) to LOCKED/0.
 * - Only one killstreak can be ACTIVE at a time.
 * - Re-applying an unchanged loadout never resets in-flight progress.
 */
export class KillstreakManager {
  readonly slots: [KillstreakSlot, KillstreakSlot, KillstreakSlot] = [
    new KillstreakSlot(null),
    new KillstreakSlot(null),
    new KillstreakSlot(null),
  ];

  /** Any slot state/progress change (HUD re-render). */
  onChanged: (() => void) | null = null;
  /** A slot just became READY (unlock banner + sting). */
  onReady: ((slotIndex: number, def: KillstreakDef) => void) | null = null;

  private equippedIds: [KillstreakId, KillstreakId, KillstreakId] = ["NONE", "NONE", "NONE"];

  /**
   * Apply the loadout selection. Slots whose id did NOT change keep their
   * current progress (re-locking the pointer mid-life is harmless).
   */
  setEquipped(ids: readonly [KillstreakId, KillstreakId, KillstreakId]): void {
    let changed = false;
    for (let i = 0; i < 3; i++) {
      if (this.equippedIds[i] === ids[i]) continue;
      this.equippedIds[i] = ids[i];
      this.slots[i].def = getKillstreakDef(ids[i]);
      this.slots[i].resetLife();
      changed = true;
    }
    if (changed) this.onChanged?.();
  }

  /** One confirmed player kill → every LOCKED slot advances. */
  onPlayerKill(): void {
    let any = false;
    for (let i = 0; i < 3; i++) {
      const slot = this.slots[i];
      if (slot.isEmpty || slot.state !== KillstreakState.LOCKED) continue;
      any = true;
      if (slot.registerKill()) this.onReady?.(i, slot.def!);
    }
    if (any) this.onChanged?.();
  }

  /** Player death: everything resets — including SPENT slots (§ per life). */
  onPlayerDeath(): void {
    let any = false;
    for (const slot of this.slots) {
      if (slot.isEmpty) continue;
      slot.resetLife();
      any = true;
    }
    if (any) this.onChanged?.();
  }

  /**
   * Def of the slot IF it can be activated right now (READY, and no other
   * killstreak currently ACTIVE). Does NOT consume anything — the caller
   * checks the ability's own preconditions before confirmActivation().
   */
  peekReady(slotIndex: number): KillstreakDef | null {
    const slot = this.slots[slotIndex];
    if (!slot || slot.isEmpty || slot.state !== KillstreakState.READY) return null;
    if (this.slots.some((s) => s.state === KillstreakState.ACTIVE)) return null;
    return slot.def;
  }

  /** READY → ACTIVE (call only after the ability's preconditions passed). */
  confirmActivation(slotIndex: number): void {
    const slot = this.slots[slotIndex];
    if (!slot || slot.state !== KillstreakState.READY) return;
    slot.markActive();
    this.onChanged?.();
  }

  /** ACTIVE → SPENT (the ability finished — used up for this life). */
  completeActivation(slotIndex: number): void {
    const slot = this.slots[slotIndex];
    if (!slot || slot.state !== KillstreakState.ACTIVE) return;
    slot.markSpent();
    this.onChanged?.();
  }
}