import type * as THREE from "three";
import type { CharacterCosmeticsSelection } from "../../../shared/combat/CharacterCosmetics";

/**
 * MATCH INTRO — "VERSUS ARCADE" player presentation (start of a match).
 *
 * Pure data contract of the cinematic. The host (Game / lobby flow) builds
 * one `MatchIntroPlayer` per participant and calls `playMatchIntro()`; the
 * cinematic sorts them (weakest first, the best player — the MVP — last),
 * presents them one by one and resolves when it is over (or skipped).
 */
export interface MatchIntroPlayer {
  /** Stable id (session id / combatant id) — used for cues and keys. */
  id: string;
  /** Display name (already sanitized / trimmed by the lobby). */
  name: string;
  /** Profile level. */
  level: number;
  /** Career K/D ratio. */
  kd: number;
  /** Optional career totals, shown when provided. */
  kills?: number;
  wins?: number;
  /** Equipped character outfit (shared cosmetic contract). */
  cosmetics?: CharacterCosmeticsSelection;
  /** True for the player watching this screen ("TOI" tag). */
  isLocal?: boolean;
  /** Optional explicit ranking score (overrides the default level + K/D score). */
  score?: number;
}

/** Sound / gameplay hooks fired while the intro plays (never during scrubbing). */
export type MatchIntroCue =
  | { type: "open" }
  | { type: "slash"; playerId: string; index: number }
  | { type: "reveal"; playerId: string; index: number }
  | { type: "slot"; playerId: string; index: number }
  | { type: "mvpCrack"; playerId: string }
  | { type: "mvpReveal"; playerId: string }
  | { type: "vs" }
  | { type: "exit" }
  | { type: "end"; skipped: boolean };

export interface MatchIntroOptions {
  /** Map name shown on the opening title (e.g. "GIVRE"). */
  mapName?: string;
  /** Target total duration (s) for a full 8-player lobby. Default 12. */
  duration?: number;
  /** Space / Escape / Enter / click skips to the exit wipe. Default true. */
  skippable?: boolean;
  /** Sound / gameplay hooks. */
  onCue?: (cue: MatchIntroCue) => void;
  /** Max device pixel ratio of the intro canvas (also capped to ≈ 1920 × 1200 pixels). Default 1.5. */
  pixelRatioCap?: number;
  /**
   * 3D quality of the character stages. "auto" (default) measures the
   * heaviest frame at load and steps down on slower GPUs.
   */
  quality?: "auto" | "high" | "medium" | "low";
  /** CSS z-index of the full-screen layer. Default 9000. */
  zIndex?: number;
  /** Parent element of the full-screen layer. Default document.body. */
  parent?: HTMLElement;
}

/**
 * One character instance prepared by the host for the intro: a CLONE the
 * cinematic may pose, re-parent and outline freely (never a shared template).
 * Convention (same as the game): feet at local y = 0, facing -Z at yaw 0,
 * height ≈ CHARACTER_HEIGHT (2.25 m).
 */
export interface IntroCharacter {
  root: THREE.Object3D;
  clips: IntroCharacterClips;
  /** Releases the host-side resources (outfit handle, clone). */
  dispose(): void;
}

export interface IntroCharacterClips {
  idle?: THREE.AnimationClip;
  run?: THREE.AnimationClip;
  jump?: THREE.AnimationClip;
  jumpLeft?: THREE.AnimationClip;
  jumpRight?: THREE.AnimationClip;
  dash?: THREE.AnimationClip;
  slide?: THREE.AnimationClip;
}

/** Builds (asynchronously) the dressed character of one player. */
export type IntroCharacterFactory = (player: MatchIntroPlayer) => Promise<IntroCharacter | null>;

/** Default ranking: career K/D weighs most, the level breaks the tie. */
export function rankScore(p: MatchIntroPlayer): number {
  if (typeof p.score === "number" && Number.isFinite(p.score)) return p.score;
  const kd = Number.isFinite(p.kd) ? Math.max(0, p.kd) : 0;
  const lvl = Number.isFinite(p.level) ? Math.max(0, p.level) : 0;
  return kd * 10 + lvl * 0.4;
}

/** Presentation order: lowest score first, the best player (MVP) last. */
export function orderForIntro(players: readonly MatchIntroPlayer[]): MatchIntroPlayer[] {
  return [...players].sort(
    (a, b) => rankScore(a) - rankScore(b) || a.level - b.level || a.name.localeCompare(b.name),
  );
}

export const MAX_INTRO_PLAYERS = 8;

/** Palette — same family as the "bean sticker arcade" HUD (hud.css :root). */
export const INTRO_INK = "#3a2814";
export const INTRO_CREAM = "#fff6e0";
export const INTRO_GOLD = "#facc15";
/** Challenger accents, in presentation order. */
export const INTRO_CHALLENGER_COLORS = [
  "#5cc8ff", // dash blue
  "#ff5a4e", // hp red
  "#a8d94a", // bean green
  "#ff8a3d", // nova orange
  "#b07cff", // grape
  "#ff7ac8", // bubblegum
  "#3fd9c0", // mint
] as const;
