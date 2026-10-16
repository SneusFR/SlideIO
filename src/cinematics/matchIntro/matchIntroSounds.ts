import { audio } from "../../audio/AudioManager";
import type { MatchIntroCue } from "./MatchIntroTypes";

/**
 * MATCH INTRO — default sound design, built only from SFX the game already
 * ships (public/assets/audio). Optional: plug it as the intro's `onCue`.
 *
 *   await preloadMatchIntroSounds(); // no-op for keys already loaded by GameAudio
 *   await playMatchIntro(players, factory, { onCue: playMatchIntroCueSound });
 *
 * Keys reuse the AUDIO_MANIFEST names when the file is the same, so nothing
 * is decoded twice. Sounds only play once the AudioContext is unlocked
 * (the game's CLICK TO PLAY gesture) — before that they are silently skipped.
 */
const A = "/assets/audio";
const INTRO_SOUNDS: Record<string, string> = {
  ready_ping: `${A}/ui/ready_ping_01.mp3`,
  ui_click_plop: `${A}/ui/ui_click_plop_01.mp3`,
  dash_whoosh: `${A}/dash/dash_whoosh_01.mp3`,
  dash_energy: `${A}/dash/dash_energy_01.mp3`,
  hit_body_punch: `${A}/hits/hit_body_02.mp3`,
  hammer_slam_impact: `${A}/hammer/hammer_slam_impact_01.mp3`,
  hammer_slam_sub: `${A}/hammer/hammer_slam_sub_01.mp3`,
  medal_unlock: `${A}/medals/medal_unlock_01.mp3`,
  kill_confirm: `${A}/kills/kill_confirm_01.mp3`,
};

export function preloadMatchIntroSounds(): Promise<void> {
  return audio.preload(INTRO_SOUNDS);
}

/** One cue → its SFX (timed on the visual beats of the timeline). */
export function playMatchIntroCueSound(cue: MatchIntroCue): void {
  switch (cue.type) {
    case "open": // title stamp
      audio.play("ready_ping", { bus: "ui", volume: 0.8 });
      audio.play("hammer_slam_sub", { bus: "impacts", volume: 0.5, delay: 0.1 });
      break;
    case "slash": // blade streak — pitched up as the challengers get stronger
      audio.play("dash_whoosh", { bus: "ui", volume: 0.9, rate: 1 + 0.05 * cue.index, rateVar: 0.03 });
      break;
    case "reveal": // name slam
      audio.play("hit_body_punch", { bus: "impacts", volume: 0.85, rateVar: 0.06 });
      break;
    case "slot": // tile locks in place
      audio.play("ui_click_plop", { bus: "ui", volume: 0.5, rate: 1.1, rateVar: 0.05 });
      break;
    case "mvpCrack": // screen cracks open on the champion
      audio.play("hammer_slam_impact", { bus: "impacts", volume: 1 });
      audio.play("hammer_slam_sub", { bus: "impacts", volume: 0.9 });
      break;
    case "mvpReveal": // "MEILLEUR JOUEUR" + name land ~0.5 s after the reveal cue
      audio.play("medal_unlock", { bus: "ui", volume: 0.9, delay: 0.5 });
      break;
    case "vs":
      audio.play("kill_confirm", { bus: "ui", volume: 1 });
      audio.play("hammer_slam_impact", { bus: "impacts", volume: 0.7 });
      break;
    case "exit": // wipe back to the game
      audio.play("dash_energy", { bus: "ui", volume: 0.75 });
      break;
    case "end":
      break;
  }
}
