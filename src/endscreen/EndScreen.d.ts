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
}

export declare class EndScreen {
  constructor(options?: EndScreenOptions);
  readonly root: HTMLDivElement;
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
