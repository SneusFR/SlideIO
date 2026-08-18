import * as THREE from "three";
import { BassBlasterConfig as cfg } from "./BassBlasterConfig";
import {
  NOTE_SEQUENCE,
  NoteDef,
  getNoteGlyphTexture,
  getNoteHaloTexture,
} from "./BassBlasterNotes";
import { Combatant } from "../../combat/Combatant";
import { KillMethod } from "../../combat/KillMethod";
import { HitZone } from "../../combat/HitZone";
import { HitFeedbackManager } from "../../combat/HitFeedbackManager";
import { castBeam, BeamCastResult } from "../BeamCombat";
import { ParticleSystem } from "../../effects/ParticleSystem";
import { LoopHandle } from "../../audio/AudioManager";

interface NoteProjectile {
  root: THREE.Group;
  glyph: THREE.Sprite;
  halo: THREE.Sprite;
  velocity: THREE.Vector3;
  prev: THREE.Vector3;
  life: number;
  note: NoteDef;
  /** Positional music grain riding on this note (position updated per frame). */
  audio: LoopHandle | null;
  /** Remaining seconds of the audio grain (handle released afterwards). */
  audioTimer: number;
  /** Trail emission accumulator. */
  trailAccum: number;
  /** Per-note pulse phase (scale "beat"). */
  pulsePhase: number;
}

/**
 * Flying musical notes fired by the Bass Blaster.
 *
 * Each note is a pair of additive sprites (bright ♪/♫ glyph + soft halo)
 * tinted with the note's signature color, leaving a colored particle
 * trail. A swept segment raycast every frame (prev → next position, CCD)
 * means even at 70 m/s a note can never tunnel through a bot or a wall.
 *
 * The note also CARRIES its music grain: while the fragment plays, its
 * PannerNode position is snapped to the projectile every frame, so the
 * music literally flies away with the notes.
 *
 * Sprite materials are shared per note of the scale (8 glyph + 8 halo
 * materials total) — projectiles never allocate GPU resources.
 */
export class BassBlasterProjectileSystem {
  /** Shooter — the sweep never collides with their own capsule. */
  owner: Combatant | null = null;
  /** Hit-confirmation sink (hitmarkers / sounds / medals — local player). */
  feedback: HitFeedbackManager | null = null;
  /** World-impact observer (small musical "plink" SFX — wired by the Game). */
  onWorldImpact: ((pos: THREE.Vector3, note: NoteDef) => void) | null = null;

  private readonly scene: THREE.Scene;
  private readonly particles: ParticleSystem;
  private readonly active: NoteProjectile[] = [];

  /** Shared per-note sprite materials (created once). */
  private readonly glyphMats: THREE.SpriteMaterial[] = [];
  private readonly haloMats: THREE.SpriteMaterial[] = [];

  private readonly raycaster = new THREE.Raycaster();
  private readonly sweepResult = new BeamCastResult();
  private readonly segDir = new THREE.Vector3();
  private readonly trailVel = new THREE.Vector3();
  private readonly white = new THREE.Color(0xffffff);

  constructor(scene: THREE.Scene, particles: ParticleSystem) {
    this.scene = scene;
    this.particles = particles;

    for (const note of NOTE_SEQUENCE) {
      this.glyphMats.push(
        new THREE.SpriteMaterial({
          map: getNoteGlyphTexture(note.glyph),
          color: note.bright,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      this.haloMats.push(
        new THREE.SpriteMaterial({
          map: getNoteHaloTexture(),
          color: note.color,
          transparent: true,
          opacity: 0.8,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
    }
  }

  get count(): number {
    return this.active.length;
  }

  /**
   * Launch one note. `noteIndex` selects the scale entry (cyclic),
   * `audioHandle` is the positional music grain the note carries.
   */
  spawn(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    noteIndex: number,
    audioHandle: LoopHandle | null,
  ): void {
    const idx = noteIndex % NOTE_SEQUENCE.length;
    const note = NOTE_SEQUENCE[idx];

    const root = new THREE.Group();
    root.position.copy(origin);

    const halo = new THREE.Sprite(this.haloMats[idx]);
    halo.scale.setScalar(cfg.noteHaloScale);
    halo.renderOrder = 7;
    root.add(halo);

    const glyph = new THREE.Sprite(this.glyphMats[idx]);
    glyph.scale.setScalar(cfg.noteGlyphScale);
    glyph.renderOrder = 8;
    root.add(glyph);

    this.scene.add(root);

    this.active.push({
      root,
      glyph,
      halo,
      velocity: dir.clone().multiplyScalar(cfg.projectileSpeed),
      prev: origin.clone(),
      life: cfg.projectileLifetime,
      note,
      audio: audioHandle,
      audioTimer: audioHandle ? cfg.fragmentDuration + 0.05 : 0,
      trailAccum: 0,
      pulsePhase: Math.random() * Math.PI * 2,
    });
  }

  update(dt: number, hittables: THREE.Object3D[]): void {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const p = this.active[i];

      // Integrate (straight energy flight — no gravity on music).
      p.prev.copy(p.root.position);
      p.root.position.addScaledVector(p.velocity, dt);

      // Musical pulse: the note "beats" while flying.
      p.pulsePhase += dt * 14;
      const pulse = 1 + 0.16 * Math.sin(p.pulsePhase);
      p.glyph.scale.setScalar(cfg.noteGlyphScale * pulse);
      p.halo.scale.setScalar(cfg.noteHaloScale * (2 - pulse) * 0.75);

      // The music grain rides on the note.
      if (p.audio) {
        p.audio.setPosition(p.root.position.x, p.root.position.y, p.root.position.z);
        p.audioTimer -= dt;
        if (p.audioTimer <= 0) p.audio = null; // grain finished — release
      }

      // Colored trail (emission budget capped by config).
      p.trailAccum += cfg.trailParticlesPerSecond * dt;
      while (p.trailAccum >= 1) {
        p.trailAccum -= 1;
        this.trailVel.set(
          (Math.random() - 0.5) * 1.6,
          (Math.random() - 0.5) * 1.6 + 0.4,
          (Math.random() - 0.5) * 1.6,
        );
        this.particles.spawn(
          p.root.position,
          this.trailVel,
          cfg.trailParticleLife * (0.7 + Math.random() * 0.6),
          p.note.color,
          0,
          1.2,
        );
      }

      // Continuous collision: sweep the full segment traveled this frame.
      this.segDir.subVectors(p.root.position, p.prev);
      const dist = this.segDir.length();
      if (dist > 1e-6) {
        this.segDir.multiplyScalar(1 / dist);
        castBeam(
          this.raycaster,
          p.prev,
          this.segDir,
          dist,
          hittables,
          this.owner,
          this.sweepResult,
        );
        if (this.sweepResult.hit) {
          this.onHit(p);
          this.remove(i);
          continue;
        }
      }

      p.life -= dt;
      if (p.life <= 0) {
        // Note fizzles out at max range: tiny sparkle, no impact.
        this.particles.burst(p.root.position, 4, 1.5, 0.25, p.note.color, 0);
        this.remove(i);
      }
    }
  }

  /** Drop every in-flight note silently (death / loadout swap cleanup). */
  clear(): void {
    for (const p of this.active) {
      p.audio?.stop(0.05);
      this.scene.remove(p.root);
    }
    this.active.length = 0;
  }

  // ------------------------------------------------------------------

  private onHit(p: NoteProjectile): void {
    const r = this.sweepResult;

    // Impact FX: colored burst + brighter core + surface ring.
    this.particles.burst(r.point, cfg.impactBurstCount, 4, 0.35, p.note.color, 2);
    this.particles.burst(r.point, 5, 2.5, 0.22, p.note.bright, 0);
    this.particles.burst(r.point, 3, 1.5, 0.15, this.white, 0);
    this.particles.ring(r.point, r.normal, cfg.impactRingCount, 0.16, 2.6, 0.3, p.note.color);

    if (r.combatant) {
      const target = r.combatant;
      const zone = r.hitZone;
      const damage = zone === HitZone.HEAD ? cfg.headDamage : cfg.bodyDamage;
      const applied = target.health.applyDamage(
        damage,
        this.owner,
        KillMethod.BASS_BLASTER,
        zone,
      );
      if (applied) {
        this.feedback?.registerHit({
          attacker: this.owner,
          target,
          hitZone: zone,
          damage,
          position: r.point,
          weapon: KillMethod.BASS_BLASTER,
          isKill: !target.health.alive,
        });
      }
    } else if (r.trainingTarget) {
      r.trainingTarget.applyDamage(cfg.bodyDamage);
    } else {
      // Structure hit: a musical "plink" observer (Game wires the audio).
      this.onWorldImpact?.(r.point, p.note);
    }

    // The grain dies with the note (short fade — no click).
    p.audio?.stop(0.04);
    p.audio = null;
  }

  private remove(index: number): void {
    const p = this.active[index];
    // Sprites use SHARED materials/textures — nothing to dispose.
    this.scene.remove(p.root);
    this.active.splice(index, 1);
  }
}