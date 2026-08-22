import { audio, LoopHandle } from "../../audio/AudioManager";
import { BassBlasterConfig as cfg } from "./BassBlasterConfig";
import auraUrl from "../../assets/AURA.mp3?url";
import aura2Url from "../../assets/Aura2.mp3?url";

/**
 * Music library + granular playback engine of the Bass Blaster.
 *
 * DESIGN
 * - A small registry of selectable tracks (add MP3s here to extend).
 * - ONE track is active at a time; each shot plays a tiny positional
 *   FRAGMENT (~0.1 s) of the active track and advances its playhead by
 *   the same order of magnitude → sustained fire "composes" the song,
 *   fragment by fragment, never a long passage at once.
 * - Stopping fire simply stops consuming fragments: the playhead stays
 *   where it is, so resuming fire resumes the track where it left off.
 * - Selecting a DIFFERENT track restarts that track from 0 (an abandoned
 *   track always restarts from the beginning when re-selected).
 * - When the playhead reaches the end of the track it wraps cleanly to 0.
 *
 * Fragments are played through AudioManager.playTracked → each one owns
 * a PannerNode whose position is updated every frame by the flying note
 * that carries it (true positional audio riding on the projectile).
 */

export interface MusicTrackDef {
  id: string;
  /** Display title (track selector UI). */
  title: string;
  /** AudioManager buffer key. */
  audioKey: string;
  url: string;
}

/** Selectable tracks — append new entries to add more music. */
export const MUSIC_TRACKS: readonly MusicTrackDef[] = [
  { id: "AURA", title: "AURA", audioKey: "bassblaster_track_aura", url: auraUrl },
  { id: "AURA2", title: "AURA II", audioKey: "bassblaster_track_aura2", url: aura2Url },
] as const;

export class MusicTrackPlayer {
  private currentIndex = 0;
  /** Per-track playhead in seconds (persists while the track stays active). */
  private readonly playheads = new Map<string, number>();
  private preloaded = false;
  /** Playhead offset (s) used by the LAST playFragmentAt call — networked
   *  with the shot so remote clients replay the exact same fragment. */
  lastFragmentOffset = 0;

  /** Kick off (or resume) decoding of every track. Safe to call often. */
  preload(): void {
    if (this.preloaded) return;
    this.preloaded = true;
    for (const t of MUSIC_TRACKS) void audio.load(t.audioKey, t.url);
  }

  get trackCount(): number {
    return MUSIC_TRACKS.length;
  }

  get currentTrack(): MusicTrackDef {
    return MUSIC_TRACKS[this.currentIndex];
  }

  get currentTrackIndex(): number {
    return this.currentIndex;
  }

  /** 0..1 progress of the ACTIVE track (selector UI readout). */
  get currentProgress(): number {
    const t = this.currentTrack;
    const dur = audio.duration(t.audioKey);
    if (dur <= 0) return 0;
    return Math.min(1, (this.playheads.get(t.id) ?? 0) / dur);
  }

  /**
   * Cycle the active track (selector arrows). Selecting a different track
   * RESTARTS it from 0 — the abandoned track will also restart from 0
   * whenever it gets re-selected later (per design).
   */
  selectByOffset(delta: number): MusicTrackDef {
    const next =
      ((this.currentIndex + delta) % MUSIC_TRACKS.length + MUSIC_TRACKS.length) %
      MUSIC_TRACKS.length;
    if (next !== this.currentIndex) {
      this.currentIndex = next;
      this.playheads.set(MUSIC_TRACKS[next].id, 0); // re-selected → from 0
    }
    return this.currentTrack;
  }

  /**
   * Play the next micro-fragment of the active track at a world position.
   * Returns the tracked handle (the projectile updates its position while
   * the grain plays) or null when the buffer isn't decoded yet.
   * The playhead advances PER SHOT, whether or not audio was ready.
   */
  playFragmentAt(pos: { x: number; y: number; z: number }): LoopHandle | null {
    const track = this.currentTrack;
    const dur = audio.duration(track.audioKey);
    if (dur <= 0) {
      this.preload(); // not decoded yet — make sure it's on the way
      return null;
    }

    let head = this.playheads.get(track.id) ?? 0;
    // Clean wrap: never start a grain that would spill past the end.
    if (head + cfg.fragmentDuration >= dur) head = 0;
    this.lastFragmentOffset = head;

    const handle = audio.playTracked(track.audioKey, pos, {
      bus: "weapons",
      volume: cfg.fragmentVolume,
      offset: head,
      duration: cfg.fragmentDuration,
      refDistance: cfg.fragmentRefDistance,
      maxDistance: cfg.fragmentMaxDistance,
      rolloff: cfg.fragmentRolloff,
      maxInstances: 8,
    });

    this.playheads.set(track.id, head + cfg.playheadAdvancePerShot);
    return handle;
  }
}