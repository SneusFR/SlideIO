import { AnimationMixer, AnimationUtils, LoopOnce, LoopRepeat, Vector3,
  Quaternion, Matrix4, Group, DynamicDrawUsage, Float32BufferAttribute } from 'three';
// Vendored with the HexSniper kit (src/assets/HexSniper). Only change vs the
// shipped file: the SkeletonUtils import path uses the project's
// "three/examples/jsm/..." convention instead of "three/addons/...".
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
const additiveClips = new WeakMap();
const X = new Vector3(1, 0, 0), ONE = new Vector3(1, 1, 1);

/** Visuals only. The game owns collision, player movement and damage. */
export class HexSniperController {
  constructor(gltf, { effectsParent = null, tongueWidthScale = 1 } = {}) {
    this.object = clone(gltf.scene); this.mixer = new AnimationMixer(this.object);
    this.actions = {}; this.fading = []; this.disposed = false;
    for (const name of ['Idle', 'Fire', 'Tongue_Cast', 'Tongue_Hold', 'Tongue_Return', 'Bite']) {
      const clip = gltf.animations.find(c => c.name === name);
      if (!clip) throw new Error(`HexSniper: missing clip ${name}`);
      this.actions[name] = this.mixer.clipAction(clip);
      const loop = ['Idle', 'Tongue_Hold'].includes(name);
      this.actions[name].setLoop(loop ? LoopRepeat : LoopOnce, loop ? Infinity : 1);
      this.actions[name].clampWhenFinished = true;
    }
    const fire = gltf.animations.find(c => c.name === 'Fire');
    if (!additiveClips.has(fire)) additiveClips.set(fire, AnimationUtils.makeClipAdditive(fire.clone(), 0));
    this.actions.Fire = this.mixer.clipAction(additiveClips.get(fire)).setLoop(LoopOnce, 1);
    this.actions.Fire.clampWhenFinished = false;
    this.idleTongue = this.object.getObjectByName('Tongue_Idle');
    this.tether = this.object.getObjectByName('Tongue_Tether');
    if (!this.idleTongue || !this.tether) throw new Error('HexSniper: attack meshes required');
    this.effects = effectsParent || new Group();
    if (!effectsParent) { this.effects.name = 'HexSniper_Effects'; this.object.add(this.effects); }
    this.effects.add(this.tether);
    this.tether.geometry = this.tether.geometry.clone();
    const original = this.tether.geometry.attributes.position;
    this.templatePositions = new Float32Array(original.count * 3);
    for (let i = 0; i < original.count; i++) {
      this.templatePositions.set([original.getX(i), original.getY(i), original.getZ(i)], i * 3);
    }
    this.tether.geometry.setAttribute('position', new Float32BufferAttribute(this.templatePositions.slice(), 3).setUsage(DynamicDrawUsage));
    this.tether.matrixAutoUpdate = false; this.tether.frustumCulled = false; this.tether.visible = false;
    this.tongueWidthScale = tongueWidthScale;
    this.endpoint = new Vector3(); this.start = new Vector3(); this.direction = new Vector3();
    this.up = new Vector3(); this.side = new Vector3(); this.worldMatrix = new Matrix4(); this.inverseParent = new Matrix4();
    this.muzzle = this.object.getObjectByName('Muzzle');
    this.tongueOrigin = this.object.getObjectByName('TongueOrigin');
    this.biteOrigin = this.object.getObjectByName('BiteOrigin');
    this.grip = this.object.getObjectByName('GripSocket');
    this.offhand = this.object.getObjectByName('OffhandSocket');
    this.scope = this.object.getObjectByName('ScopeAim');
    this.state = 'Idle'; this.actions.Idle.play();
    this._finished = ({ action }) => {
      if (action === this.actions.Tongue_Cast && this.state === 'Tongue_Cast') this.beginPull();
      else if (action === this.actions.Bite && this.state === 'Bite') this.reset();
      else if (action === this.actions.Tongue_Return && this.state === 'Tongue_Return') this.reset();
      else if (action === this.actions.Fire && this.state === 'Fire') this.state = 'Idle';
    };
    this.mixer.addEventListener('finished', this._finished);
    this.mixer.update(0); this.object.updateMatrixWorld(true);
  }
  _transition(name, fade = .065) {
    const next = this.actions[name];
    for (const action of Object.values(this.actions)) {
      if (action !== next && action.isScheduled()) {
        action.fadeOut(fade); this.fading.push({ action, remaining: fade });
      }
    }
    this.fading = this.fading.filter(x => x.action !== next);
    if (name !== 'Idle') next.reset();
    next.enabled = true; next.paused = false;
    next.stopFading().setEffectiveTimeScale(1).setEffectiveWeight(1).fadeIn(fade).play();
    this.state = name;
  }
  beginTongue(point) {
    if (this.disposed) return;
    this.idleTongue.visible = false; this.tether.visible = true;
    this.object.updateWorldMatrix(true, true);
    this.endpoint.copy(point || this.tongueOrigin.getWorldPosition(this.start));
    this._transition('Tongue_Cast'); this._updateTether();
  }
  setTongueEndpoint(point) { if (!this.disposed) this.endpoint.copy(point); }
  beginPull() { if (!this.disposed) this._transition('Tongue_Hold'); }
  beginReturn() { if (!this.disposed && this.state !== 'Tongue_Hold') this._transition('Tongue_Hold'); }
  endTongue() {
    if (this.disposed) return;
    this.tether.visible = false; this.idleTongue.visible = true; this._transition('Tongue_Return', .025);
  }
  bite() {
    if (this.disposed) return;
    this.tether.visible = false; this.idleTongue.visible = false; this._transition('Bite', .025);
  }
  reset() {
    if (this.disposed) return;
    this.tether.visible = false; this.idleTongue.visible = true; this._transition('Idle', .09);
  }
  /** Legacy cosmetic reaction; gameplay uses HexSniperAttacks.tryTongue(). */
  onFire() {
    if (this.disposed || this.state !== 'Idle') return;
    this.actions.Fire.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).play(); this.state = 'Fire';
  }
  _updateTether() {
    this.object.updateWorldMatrix(true, true); this.tongueOrigin.getWorldPosition(this.start);
    this.direction.copy(this.endpoint).sub(this.start);
    const distance = this.direction.length();
    if (distance > 1e-7) this.direction.multiplyScalar(1 / distance); else this.direction.copy(X);
    // Explicit basis remains accurate even for near-antiparallel 10 km shots.
    this.up.set(0, Math.abs(this.direction.y) < .999 ? 1 : 0, Math.abs(this.direction.y) < .999 ? 0 : 1);
    this.side.crossVectors(this.direction, this.up).normalize();
    this.up.crossVectors(this.side, this.direction).normalize();
    this.worldMatrix.makeBasis(this.direction, this.up, this.side).setPosition(this.start);
    this.effects.updateWorldMatrix(true, false); this.inverseParent.copy(this.effects.matrixWorld).invert();
    this.tether.matrix.multiplyMatrices(this.inverseParent, this.worldMatrix); this.tether.matrixWorldNeedsUpdate = true;
    const pos = this.tether.geometry.attributes.position;
    const width = this.tongueWidthScale, tipLength = .12 * width;
    const shaftLength = Math.max(0, distance - tipLength), shortTip = Math.min(1, distance / tipLength);
    for (let i = 0; i < pos.count; i++) {
      const x = this.templatePositions[i * 3];
      const stretch = x <= 1 ? x * shaftLength : shaftLength + (x - 1) * width * shortTip;
      pos.setXYZ(i, stretch, this.templatePositions[i * 3 + 1] * width, this.templatePositions[i * 3 + 2] * width);
    }
    pos.needsUpdate = true;
  }
  update(dt) {
    if (this.disposed || !Number.isFinite(dt) || dt < 0) return;
    this.mixer.update(dt);
    for (let i = this.fading.length - 1; i >= 0; i--) {
      const f = this.fading[i]; f.remaining -= dt;
      if (f.remaining <= 0) { f.action.stop(); this.fading.splice(i, 1); }
    }
    if (this.state === 'Bite' && this.actions.Bite.time > .79) this.idleTongue.visible = true;
    if (this.tether.visible) this._updateTether();
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.mixer.removeEventListener('finished', this._finished);
    this.mixer.stopAllAction(); this.mixer.uncacheRoot(this.object);
    this.object.traverse(o => { if (o.isSkinnedMesh) o.skeleton.dispose(); });
    this.tether.geometry.dispose(); this.tether.removeFromParent(); this.object.removeFromParent();
  }
}
