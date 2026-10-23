import type { HudCommand } from "../protocol";

/**
 * KILL CASCADE — the HUD effects of a kill start over a few frames instead of
 * all in the same one (frame mode: HudHost holds them, see PERFORMANCE.md,
 * « Les chutes au kill : l'empilement des effets du HUD »).
 *
 * Measured on the PC gamer (RTX 2080 Super, 240 Hz, Chrome's GPU process
 * shared by the game's WebGL and the HUD's iframe, 23/10): at a kill, ONE
 * batch started the medal, the BEANED! sticker and the Bean Buddy's cheer,
 * the combo tag, the killstreak slots, the leaderboard rows, the kill
 * hitmarker and the kill damage number. Their first frames (raster of the
 * new content, the group-opacity passes of the pops) landed in the GPU
 * process together, and 4 to 8 frames after the kill the game's own frame
 * waited for it: a GPU wait of 4-9 ms, 1-2 missed refreshes, on 5 kills of
 * 17 (the HUD as in production). Any ONE of those effects alone: 0 of 22.
 * The same effects started over 8 frames (this cascade, prototyped in the
 * page): 0 of 11 — the same as no kill effect at all (0 of 23).
 *
 * The kill's own feedback stays in the kill's frame (the hitmarker and the
 * damage number: they answer the shot). Then, each group at least `rank`
 * frames after the kill (so they never share a frame) and about `ms` later:
 *   240 Hz  medal +2 frames (8 ms) · sticker, combo +4 (17 ms) · killstreak +6 (25 ms) · leaderboard +8 (33 ms)
 *   144 Hz  +1 · +2 · +4 · +5 frames (7-35 ms)
 *    60 Hz  +1 · +2 · +3 · +4 frames (17-67 ms)
 * The same animations, the same states, in the same order within each
 * widget — only a few milliseconds later.
 */
export type CascadeGroup = "medal" | "sticker" | "combo" | "killstreak" | "leaderboard";

export const CASCADE: Readonly<Record<CascadeGroup, { readonly rank: number; readonly ms: number }>> = {
  medal: { rank: 1, ms: 8 },
  sticker: { rank: 2, ms: 17 },
  combo: { rank: 2, ms: 17 },
  killstreak: { rank: 3, ms: 25 },
  leaderboard: { rank: 4, ms: 33 },
};

/**
 * The cascade group of a command, or null (sent at once). A `trigger` starts
 * a group's delay; a follower (its widget's later updates: the combo's
 * per-frame state, the medal's exit / hide) is only held while its group has
 * commands waiting, so that a widget always gets its commands in order.
 */
export function cascadeOf(cmd: HudCommand): { readonly group: CascadeGroup; readonly trigger: boolean } | null {
  switch (cmd[0]) {
    case "medal.show":
      return MEDAL_TRIGGER;
    case "medal.exit":
    case "medal.hide":
      return MEDAL_FOLLOW;
    case "combat.kill":
      return STICKER_TRIGGER;
    case "combo.kill":
      return COMBO_TRIGGER;
    case "combo.update":
      return COMBO_FOLLOW;
    case "killstreak.render":
    case "killstreak.ready":
      return KILLSTREAK_TRIGGER;
    case "leaderboard.refresh":
      return LEADERBOARD_TRIGGER;
    default:
      return null;
  }
}
const MEDAL_TRIGGER = { group: "medal", trigger: true } as const;
const MEDAL_FOLLOW = { group: "medal", trigger: false } as const;
const STICKER_TRIGGER = { group: "sticker", trigger: true } as const;
const COMBO_TRIGGER = { group: "combo", trigger: true } as const;
const COMBO_FOLLOW = { group: "combo", trigger: false } as const;
const KILLSTREAK_TRIGGER = { group: "killstreak", trigger: true } as const;
const LEADERBOARD_TRIGGER = { group: "leaderboard", trigger: true } as const;

/** Frames a group's trigger waits at this frame duration (see CASCADE). */
export function cascadeFrames(group: CascadeGroup, frameMs: number): number {
  const c = CASCADE[group];
  return Math.max(c.rank, Math.round(c.ms / Math.max(1, frameMs)));
}

/**
 * No release for this long: this page is not in a frame loop (loading, a menu
 * without frames…) — there is no burst to spread, commands go at once.
 */
export const CASCADE_IDLE_MS = 100;

interface Held {
  readonly cmd: HudCommand;
  readonly group: CascadeGroup;
  /** The release (frame number) whose batch carries it. */
  readonly at: number;
}

export class KillCascade {
  private readonly held: Held[] = [];
  /** Releases so far (one per HudHost.flush: one per display frame). */
  private frame = 0;
  private lastReleaseAt = Number.NEGATIVE_INFINITY;
  /** Display frame duration, smoothed from the releases (60 Hz until measured). */
  private frameMs = 1000 / 60;

  constructor(private readonly now: () => number) {}

  /** Commands waiting (tests, debug). */
  get size(): number {
    return this.held.length;
  }

  /**
   * True when `cmd` is held for a later frame (the caller sends it later,
   * from `release`); false when it goes now.
   */
  hold(cmd: HudCommand): boolean {
    const c = cascadeOf(cmd);
    if (c === null) return false;
    let at = -1;
    for (const h of this.held) if (h.group === c.group && h.at > at) at = h.at;
    if (at < 0) {
      if (!c.trigger || this.now() - this.lastReleaseAt > CASCADE_IDLE_MS) return false;
      // This frame's batch is release `frame + 1`: `n` frames after it.
      at = this.frame + 1 + cascadeFrames(c.group, this.frameMs);
    }
    this.held.push({ cmd, group: c.group, at });
    return true;
  }

  /**
   * Once per display frame, before its batch is posted: the commands due now,
   * in the order they were held, go to `send`.
   */
  release(send: (cmd: HudCommand) => void): void {
    const now = this.now();
    const dt = now - this.lastReleaseAt;
    if (dt > 0 && dt < CASCADE_IDLE_MS) this.frameMs += (dt - this.frameMs) * 0.1;
    this.lastReleaseAt = now;
    this.frame++;
    if (this.held.length === 0) return;
    let kept = 0;
    for (let i = 0; i < this.held.length; i++) {
      const h = this.held[i];
      if (h.at <= this.frame) send(h.cmd);
      else this.held[kept++] = h;
    }
    this.held.length = kept;
  }

  /** Everything held, now, in order (the HUD changes mode, or stops being fed). */
  drain(send: (cmd: HudCommand) => void): void {
    const all = this.held.splice(0);
    for (const h of all) send(h.cmd);
  }
}
