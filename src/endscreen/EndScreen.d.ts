/**
 * Type declarations for the end-of-match screen (plain JS modules in this
 * folder — see README.md). Only the API used by the game is typed.
 */
import type * as THREE from "three";

export interface EndScreenPlayer {
  id: string;
  name: string;
  kills: number;
  deaths: number;
  assists?: number;
  /** Optional imposed placement (1 = first) — overrides the score sort. */
  rank?: number;
  score?: number;
  damage?: number | null;
  shotsFired?: number | null;
  shotsHit?: number | null;
  bestStreak?: number;
  color?: string;
  avatar?: string;
}

export interface EndScreenKill {
  t: number;
  killer: string | null;
  victim: string;
  assisters?: string[];
}

export interface EndScreenMap {
  id: string;
  name: string;
  subtitle?: string;
  image?: string;
}

export interface EndScreenMatchData {
  outcome?: "victory" | "defeat";
  mode?: string;
  mapName?: string;
  duration: number;
  localPlayerId: string;
  players: EndScreenPlayer[];
  killFeed?: EndScreenKill[];
  maps?: EndScreenMap[];
}

export interface EndScreenOptions {
  container?: HTMLElement;
  locale?: string;
  strings?: Record<string, unknown>;
  sfx?: boolean | ((name: string, opts: unknown) => void);
  volume?: number;
  voteDuration?: number;
  autoEndVote?: boolean;
  quality?: "high" | "low";
  pixelRatio?: number;
  reducedMotion?: boolean;
  fonts?: boolean | { display: string; body: string };
  zIndex?: number;
  releasePointerLock?: boolean;
  onVote?: ((mapId: string) => void) | null;
  onVoteEnd?: ((mapId: string) => void) | null;
  onQuit?: (() => void) | null;
  onIntroEnd?: (() => void) | null;
  /** PERF: use the 3D intro prepared by EndScreen.prewarm() (kept for the next screen). */
  warmIntro?: boolean;
  /** PERF: leave out of each 3D frame the draws that cannot change a pixel. */
  skipEmptyDraws?: boolean;
  /** PERF: the snapshot is not copied whole to test 64 of its pixels, its glass built into typed arrays. */
  fastSnapshot?: boolean;
  /** PERF: the results' unit (--u) set before their content is built: one style + layout of it, not two. */
  earlyLayout?: boolean;
  /**
   * PERF: called once the snapshot (the game's last frame, behind the overlay) is known to be
   * opaque everywhere — read in bands over the first frames of the intro. Not called if a
   * single pixel is translucent.
   */
  onBackdropOpaque?: (() => void) | null;
}

export interface EndScreenPrewarmOptions {
  fonts?: boolean | { display: string; body: string };
  strings?: Record<string, unknown>;
  quality?: "high" | "low";
  pixelRatio?: number;
}

export declare class EndScreen {
  constructor(options?: EndScreenOptions);
  readonly root: HTMLDivElement;
  /** Styles, fonts and the 3D intro (WebGL context, programs, title) prepared in idle slots. */
  static prewarm(options?: EndScreenPrewarmOptions): Promise<void>;
  /** Finishes the warm-up at once. */
  static flushPrewarm(): void;
  static captureFrame(
    renderer: THREE.WebGLRenderer | HTMLCanvasElement,
    scene?: THREE.Scene,
    camera?: THREE.Camera,
  ): HTMLCanvasElement | null;
  show(data: EndScreenMatchData, opts?: { snapshot?: CanvasImageSource | null }): Promise<void>;
  skip(): void;
  /** { mapId: [playerIds] } or { mapId: count } */
  setVotes(votes: Record<string, string[] | number>): void;
  endVote(mapId?: string): void;
  vote(mapId: string): void;
  setSfxEnabled(on: boolean): void;
  hide(): Promise<void>;
  dispose(): void;
}

export declare const DEFAULT_STRINGS: Record<string, unknown>;
