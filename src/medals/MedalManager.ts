import { MedalType } from "./MedalType";
import { MedalQueue } from "./MedalQueue";
import {
  MedalConfig as mc,
  ComboMedalRegistry,
  SpecialMedalRegistry,
} from "./MedalConfig";
import { KillMethod } from "../combat/KillMethod";

/** Minimal display contract implemented by the DOM MedalHUD. */
export interface MedalDisplay {
  /** Pop the medal in (enter animation). `chainIndex` scales the aura. */
  show(medal: MedalType, chainIndex: number): void;
  /** Start the exit animation (fade + drift). */
  beginExit(): void;
  /** Fully hide the display (after the exit animation). */
  hide(): void;
}

type Phase = "IDLE" | "ENTER" | "HOLD" | "EXIT" | "GAP";

/**
 * Owns the medal queue and its presentation state machine.
 *
 * Per local-player kill:
 *   1. combo medal first (registry: 1→KILL, 2→DOUBLE_KILL, 3→TRIPLE_KILL;
 *      higher counts keep the combo but produce no fake medal),
 *   2. THEN the kill-method medal (HAMMER_SWING→HOMERUN, GROUND_SLAM→SMASHED).
 *
 * Special medals are flushed at the START of the next update so a Ground
 * Slam killing 3 bots in one impact reads as:
 *   KILL → DOUBLE KILL → TRIPLE KILL → SMASHED   (SMASHED shown once)
 * — every kill still counts individually in the combo.
 *
 * Audio: each medal shown bumps the chain pitch slightly (arcade
 * "DING ↑ DING ↑↑" escalation), capped at `medalMaxPitch`. The chain
 * resets when the combo ends.
 */
export class MedalManager {
  /** Play the medal sting (wired to GameAudio — never `new Audio()`). */
  onMedalPop: ((pitch: number) => void) | null = null;

  private readonly queue = new MedalQueue();
  private phase: Phase = "IDLE";
  private phaseTimer = 0;

  /** Medals already shown during the CURRENT combo (drives the pitch). */
  private chainIndex = 0;

  /** Internal clock (seconds) — pause-safe merge-window bookkeeping. */
  private clock = 0;
  /** Specials awaiting the end-of-frame flush (ordered, deduped). */
  private readonly pendingSpecials: MedalType[] = [];
  /** Last enqueue clock per special medal (AoE merge window). */
  private readonly lastSpecialAt = new Map<MedalType, number>();

  constructor(private readonly display: MedalDisplay) {}

  /**
   * A confirmed LOCAL PLAYER kill (Game verifies killer === localPlayer).
   * @param comboCount combo count AFTER this kill (1 = combo start)
   * @param method     explicit cause of death from the damage system
   * @param isHeadshot true when the KILLING blow landed on the head
   */
  onPlayerKill(comboCount: number, method: KillMethod, isHeadshot = false): void {
    // 1) Combo medal (registry lookup — extensible, no if-chains).
    const comboMedal = ComboMedalRegistry[comboCount];
    if (comboMedal !== undefined) this.queue.push(comboMedal);

    // 2) HEADSHOT right after the combo medal of the SAME kill. Only the
    //    Plasma Rifle can headshot and it has no special method medal, so
    //    this never competes with SMASHED/OBLITERATED/etc.
    if (isHeadshot) this.queue.push(MedalType.HEADSHOT);

    // 3) Special medal, deferred + merged (one SMASHED per slam impact).
    const special = SpecialMedalRegistry[method];
    if (special !== undefined) {
      const last = this.lastSpecialAt.get(special);
      const merge = mc.specialMedalMergeMs / 1000;
      if (last === undefined || this.clock - last > merge) {
        this.pendingSpecials.push(special);
        this.lastSpecialAt.set(special, this.clock);
      }
    }
  }

  /** Combo ended (timeout or death): next combo restarts at base pitch. */
  resetChain(): void {
    this.chainIndex = 0;
  }

  update(dt: number): void {
    this.clock += dt;

    // Flush specials AFTER all kill events of the frame — this is what
    // orders a multi-kill slam as KILL/DOUBLE/TRIPLE… then SMASHED.
    if (this.pendingSpecials.length > 0) {
      for (const medal of this.pendingSpecials) this.queue.push(medal);
      this.pendingSpecials.length = 0;
    }

    this.phaseTimer -= dt;

    switch (this.phase) {
      case "IDLE":
        this.tryShowNext();
        break;

      case "ENTER":
        if (this.phaseTimer <= 0) {
          this.phase = "HOLD";
          this.phaseTimer = mc.medalDisplayDuration;
        }
        break;

      case "HOLD":
        // A waiting queue shortens the hold — the game is nervous, the
        // next reward must not lag 1s behind.
        if (this.phaseTimer <= 0 || (!this.queue.isEmpty && this.phaseTimer < mc.medalDisplayDuration * 0.55)) {
          this.display.beginExit();
          this.phase = "EXIT";
          this.phaseTimer = mc.medalExitDuration;
        }
        break;

      case "EXIT":
        if (this.phaseTimer <= 0) {
          this.display.hide();
          this.phase = "GAP";
          this.phaseTimer = mc.medalQueueDelay;
        }
        break;

      case "GAP":
        if (this.phaseTimer <= 0) {
          this.phase = "IDLE";
          this.tryShowNext();
        }
        break;
    }
  }

  private tryShowNext(): void {
    const medal = this.queue.shift();
    if (medal === undefined) return;

    const pitch = Math.min(
      mc.medalBasePitch + this.chainIndex * mc.medalPitchStep,
      mc.medalMaxPitch,
    );
    this.display.show(medal, this.chainIndex);
    this.onMedalPop?.(pitch);
    this.chainIndex++;

    this.phase = "ENTER";
    this.phaseTimer = mc.medalEnterDuration;
  }
}