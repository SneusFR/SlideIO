import { KillstreakDef } from "./KillstreakDefs";
import { KillstreakState } from "./KillstreakState";

/**
 * One of the three equipped killstreak slots. Pure state container —
 * transitions are driven by the KillstreakManager.
 */
export class KillstreakSlot {
  state = KillstreakState.LOCKED;
  /** Kills accumulated toward the requirement THIS life. */
  kills = 0;

  constructor(public def: KillstreakDef | null) {}

  /** Empty slots ("NONE") never charge, never activate, never render bars. */
  get isEmpty(): boolean {
    return this.def === null;
  }

  /**
   * Register one player kill. Only LOCKED slots progress (§ READY/ACTIVE/
   * SPENT never re-charge within the same life). Returns true when this
   * kill is the one that armed the killstreak (LOCKED → READY edge).
   */
  registerKill(): boolean {
    if (this.isEmpty || this.state !== KillstreakState.LOCKED) return false;
    this.kills++;
    if (this.kills >= this.def!.requiredKills) {
      this.state = KillstreakState.READY;
      return true;
    }
    return false;
  }

  /** Death (or re-equip): back to a fresh, uncharged slot. */
  resetLife(): void {
    this.state = KillstreakState.LOCKED;
    this.kills = 0;
  }

  markActive(): void {
    this.state = KillstreakState.ACTIVE;
  }

  markSpent(): void {
    this.state = KillstreakState.SPENT;
  }
}