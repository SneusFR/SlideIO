// Vendored with the PulseCarbine asset (src/assets/PulseCarbine/README_FR.md).
// Only change vs the shipped file: the SkeletonUtils import path uses the
// project's "three/examples/jsm/..." convention instead of "three/addons/...".
import { AnimationMixer, LoopOnce, LoopRepeat } from "three";
import { clone } from "three/examples/jsm/utils/SkeletonUtils.js";

/** Independent screen + piano animation. Geometry/materials remain shared. */
export class PulseCarbineController {
  constructor(gltf) {
    this.object = clone(gltf.scene);
    this.mixer = new AnimationMixer(this.object);
    this.musicEnabled = false;
    this.disposed = false;
    this.actions = {};
    for (const name of ["Idle", "Fire", "MusicLoop"]) {
      const clip = gltf.animations.find((c) => c.name === name);
      if (!clip) throw new Error(`PulseCarbine: missing animation ${name}`);
      this.actions[name] = this.mixer.clipAction(clip);
    }
    this.fireVariants = ["Fire"];
    for (const name of ["Fire_AltA", "Fire_AltB"]) {
      const clip = gltf.animations.find((c) => c.name === name);
      if (clip) {
        this.actions[name] = this.mixer.clipAction(clip);
        this.fireVariants.push(name);
      }
    }
    this.shotIndex = 0;
    this.actions.Idle.setLoop(LoopRepeat, Infinity);
    this.actions.MusicLoop.setLoop(LoopRepeat, Infinity);
    for (const name of this.fireVariants) {
      this.actions[name].setLoop(LoopOnce, 1);
      this.actions[name].clampWhenFinished = true;
    }
    this._onFinished = (event) => {
      if (this.fireVariants.some((name) => event.action === this.actions[name])) {
        this._play(this.musicEnabled ? "MusicLoop" : "Idle");
      }
    };
    this.mixer.addEventListener("finished", this._onFinished);
    this._play("Idle");
    this.mixer.update(0);
    this.object.updateMatrixWorld(true);
    this.muzzle = this.object.getObjectByName("Muzzle");
    this.grip = this.object.getObjectByName("GripSocket");
    this.offhand = this.object.getObjectByName("OffhandSocket");
  }

  _play(name) {
    this.mixer.stopAllAction();
    this.actions[name].reset().setEffectiveTimeScale(1).setEffectiveWeight(1).play();
    this.activeClip = name;
    this.state = this.fireVariants.includes(name) ? "Fire" : name;
  }

  /** Call once for every shot accepted by your game, including automatic fire. */
  onFire() {
    if (this.disposed) return;
    this._play(this.fireVariants[this.shotIndex++ % this.fireVariants.length]);
    // Begin immediately; subsequent frames advance the 0.7 s impulse.
    this.mixer.update(0);
  }

  /** Optional looping equalizer; Fire takes priority and then resumes it. */
  setMusic(enabled) {
    if (this.disposed) return;
    this.musicEnabled = Boolean(enabled);
    if (this.state !== "Fire") {
      this._play(this.musicEnabled ? "MusicLoop" : "Idle");
      this.mixer.update(0);
    }
  }

  /** Seconds, from your render loop. */
  update(deltaSeconds) {
    if (!this.disposed && Number.isFinite(deltaSeconds) && deltaSeconds >= 0) {
      this.mixer.update(deltaSeconds);
    }
  }

  /** Stops animation. GPU resources stay shared and belong to the asset cache. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.mixer.removeEventListener("finished", this._onFinished);
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.object);
    this.object.removeFromParent();
  }
}
