import * as THREE from "three";
import { BassBlasterConfig as cfg } from "./BassBlasterConfig";
import { loadBassBlasterTemplate, cloneBassBlaster } from "./BassBlasterModel";
import {
  NOTE_SEQUENCE,
  NoteDef,
  getNoteGlyphTexture,
  getNoteHaloTexture,
} from "./BassBlasterNotes";
import { ParticleSystem } from "../../effects/ParticleSystem";

/** One orbiting note of the reload swirl (camera-space, pre-allocated). */
interface ReloadNote {
  sprite: THREE.Sprite;
  material: THREE.SpriteMaterial; // per-slot material (per-note color + fade)
  note: NoteDef;
  /** Random phase offsets so the swirl never looks mechanical. */
  angle0: number;
  tilt: number;
  delay: number; // staggered starts (fraction of the reload)
}

/**
 * First-person Bass Blaster viewmodel. PURELY visual: recoil kick,
 * per-note colored muzzle flash, idle groove bob and the RELOAD SWIRL
 * (musical notes orbiting into the weapon) never touch the real aim.
 *
 * The model comes from the shared cached template (loaded once); this
 * instance clones its materials so viewmodel-only render tweaks never
 * affect the template.
 */
export class BassBlasterViewmodel {
  readonly group = new THREE.Group();

  private readonly basePosition = new THREE.Vector3(
    cfg.viewmodelOffset.x,
    cfg.viewmodelOffset.y,
    cfg.viewmodelOffset.z,
  );
  private readonly muzzle = new THREE.Object3D();
  private readonly muzzleLight: THREE.PointLight;
  private readonly muzzleHalo: THREE.Sprite;
  private readonly muzzleHaloMat: THREE.SpriteMaterial;
  private readonly particles: ParticleSystem;

  // Visual recoil state, damped every frame.
  private kick = 0;
  private wrist = 0;
  private flashTimer = 0;
  /** Equalizer-style body pulse triggered by each shot (decays fast). */
  private beat = 0;

  // ---- Reload swirl state ----
  private readonly reloadNotes: ReloadNote[] = [];
  private readonly reloadLight: THREE.PointLight;
  private reloadT = -1; // -1 = inactive, else 0..1 progress
  private reloadDuration = 1;
  private reloadSparkAccum = 0;

  private readonly muzzleWorld = new THREE.Vector3();
  private readonly groupWorld = new THREE.Vector3();
  private readonly sparkColor = new THREE.Color(0xffffff);

  constructor(camera: THREE.Camera, particles: ParticleSystem) {
    this.particles = particles;
    this.group.position.copy(this.basePosition);
    camera.add(this.group);

    // Muzzle anchor: front tip of the (normalized, length = 1 → scaled) model.
    this.muzzle.position.set(0, 0.02, -(cfg.viewmodelLength * 0.5 + 0.04));
    this.group.add(this.muzzle);

    // Per-note colored muzzle flash light.
    this.muzzleLight = new THREE.PointLight(0xffffff, 0, 3.5, 2);
    this.muzzle.add(this.muzzleLight);

    // Additive halo flash at the muzzle (tinted per note on every shot).
    this.muzzleHaloMat = new THREE.SpriteMaterial({
      map: getNoteHaloTexture(),
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });
    this.muzzleHalo = new THREE.Sprite(this.muzzleHaloMat);
    this.muzzleHalo.scale.setScalar(0.22);
    this.muzzleHalo.renderOrder = 105;
    this.muzzle.add(this.muzzleHalo);

    // Reload glow (violet musical energy inside the weapon).
    this.reloadLight = new THREE.PointLight(0xc084fc, 0, 1.8, 2);
    this.group.add(this.reloadLight);

    // Pre-build the reload swirl notes (hidden until a reload starts).
    for (let i = 0; i < cfg.reloadNoteCount; i++) {
      const note = NOTE_SEQUENCE[i % NOTE_SEQUENCE.length];
      const material = new THREE.SpriteMaterial({
        map: getNoteGlyphTexture(note.glyph),
        color: note.bright,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthTest: false,
        depthWrite: false,
      });
      const sprite = new THREE.Sprite(material);
      sprite.scale.setScalar(0.085);
      sprite.renderOrder = 108;
      sprite.visible = false;
      this.group.add(sprite);
      this.reloadNotes.push({
        sprite,
        material,
        note,
        angle0: (i / cfg.reloadNoteCount) * Math.PI * 2 + Math.random() * 0.5,
        tilt: (Math.random() - 0.5) * 0.5,
        delay: (i / cfg.reloadNoteCount) * 0.25,
      });
    }

    // Shared template → per-viewmodel clone with per-instance materials.
    void loadBassBlasterTemplate().then((template) => {
      const model = cloneBassBlaster(template);
      model.scale.setScalar(cfg.viewmodelLength);
      model.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh)) return;
        obj.renderOrder = 100; // viewmodel layer
        obj.frustumCulled = false;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        obj.material = mats.length === 1 ? mats[0].clone() : mats.map((m) => m.clone());
        const cloned = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of cloned) {
          m.depthTest = false; // never clip into walls
          m.transparent = true; // draw AFTER world transparents
        }
      });
      this.group.add(model);
    });
  }

  setHidden(hidden: boolean): void {
    this.group.visible = !hidden;
  }

  /** Visual-only recoil + per-note colored muzzle flash. */
  triggerShot(note: NoteDef): void {
    this.kick += cfg.visualRecoil;
    this.wrist += 0.06;
    this.beat = 1;
    this.flashTimer = 0.05;
    this.muzzleLight.color.copy(note.color);
    this.muzzleLight.intensity = cfg.muzzleFlashIntensity;
    this.muzzleHaloMat.color.copy(note.bright);
    this.muzzleHaloMat.opacity = 0.95;
    // Colored spark spray at the muzzle.
    this.muzzle.getWorldPosition(this.muzzleWorld);
    this.particles.burst(this.muzzleWorld, 5, 2.2, 0.12, note.color, 0);
    this.particles.burst(this.muzzleWorld, 2, 1.4, 0.1, note.bright, 0);
  }

  /** Begin the musical reload swirl (notes orbit + converge into the gun). */
  startReload(duration: number): void {
    this.reloadDuration = Math.max(duration, 0.1);
    this.reloadT = 0;
    for (const n of this.reloadNotes) {
      n.sprite.visible = true;
      n.material.opacity = 0;
    }
  }

  /** Instant, silent completion (death / loadout swap). */
  cancelReload(): void {
    this.reloadT = -1;
    this.reloadLight.intensity = 0;
    for (const n of this.reloadNotes) {
      n.sprite.visible = false;
      n.material.opacity = 0;
    }
  }

  getMuzzleWorldPosition(out: THREE.Vector3): THREE.Vector3 {
    return this.muzzle.getWorldPosition(out);
  }

  update(dt: number, time: number): void {
    // Recoil recovery (fast damp — SMG rattle, not a hand cannon).
    this.kick = THREE.MathUtils.damp(this.kick, 0, 18, dt);
    this.wrist = THREE.MathUtils.damp(this.wrist, 0, 16, dt);
    this.beat = THREE.MathUtils.damp(this.beat, 0, 10, dt);

    this.group.position.copy(this.basePosition);
    this.group.position.z += this.kick;
    // Idle groove: the weapon subtly "vibes" (bob + roll) even at rest,
    // amplified by the shot beat like a speaker membrane.
    this.group.position.y += Math.sin(time * 2.1) * 0.004 + this.beat * 0.006;
    this.group.rotation.x = this.wrist;
    this.group.rotation.z = Math.sin(time * 1.4) * 0.008 + this.beat * 0.015;
    const squeeze = 1 + this.beat * 0.05;
    this.group.scale.set(squeeze, 1 / squeeze, 1);

    // Muzzle flash decay (light + halo).
    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      if (this.flashTimer <= 0) this.muzzleLight.intensity = 0;
    } else if (this.muzzleLight.intensity > 0) {
      this.muzzleLight.intensity = Math.max(0, this.muzzleLight.intensity - dt * 90);
    }
    if (this.muzzleHaloMat.opacity > 0) {
      this.muzzleHaloMat.opacity = Math.max(0, this.muzzleHaloMat.opacity - dt * 9);
    }

    this.updateReloadSwirl(dt);
  }

  // ------------------------------------------------------------------
  // Reload swirl: notes appear around the weapon, spiral inward while
  // shrinking, and "enter" the weapon — musical energy refilling the mag.
  // ------------------------------------------------------------------

  private updateReloadSwirl(dt: number): void {
    if (this.reloadT < 0) {
      if (this.reloadLight.intensity > 0) {
        this.reloadLight.intensity = Math.max(0, this.reloadLight.intensity - dt * 10);
      }
      return;
    }

    this.reloadT += dt / this.reloadDuration;
    const t = this.reloadT;

    if (t >= 1) {
      // Final snap: notes absorbed → small flash + sparkle shower.
      this.cancelReload();
      this.reloadLight.intensity = 2.2;
      this.group.getWorldPosition(this.groupWorld);
      this.sparkColor.set(0xd8b4fe);
      this.particles.burst(this.groupWorld, 10, 1.6, 0.25, this.sparkColor, 0);
      return;
    }

    // Energy glow swells with the swirl.
    this.reloadLight.intensity = 1.4 * Math.sin(Math.PI * Math.min(t * 1.05, 1));

    for (const n of this.reloadNotes) {
      // Staggered per-note progress (later notes start slightly delayed).
      const k = THREE.MathUtils.clamp((t - n.delay) / (1 - n.delay), 0, 1);
      if (k <= 0) {
        n.material.opacity = 0;
        continue;
      }
      // Spiral: angle advances, radius converges to the weapon core.
      const angle = n.angle0 + k * Math.PI * 2 * cfg.reloadSwirlTurns;
      const radius = cfg.reloadSwirlRadius * (1 - k * k);
      n.sprite.position.set(
        Math.cos(angle) * radius,
        Math.sin(angle) * radius * 0.55 + n.tilt * (1 - k) - 0.02,
        Math.sin(angle * 0.7) * radius * 0.4 - 0.1,
      );
      // Fade in fast, shrink as the note gets absorbed.
      n.material.opacity = Math.min(1, k * 5) * (1 - k * 0.35);
      n.sprite.scale.setScalar(0.085 * (1 - k * 0.55));
    }

    // Light sparkle stream while the swirl is running.
    this.reloadSparkAccum += 26 * dt;
    while (this.reloadSparkAccum >= 1) {
      this.reloadSparkAccum -= 1;
      const n = this.reloadNotes[Math.floor(Math.random() * this.reloadNotes.length)];
      this.group.getWorldPosition(this.groupWorld);
      this.particles.burst(this.groupWorld, 1, 0.8, 0.18, n.note.color, 0);
    }
  }
}