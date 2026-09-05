import { Vector3 } from 'three';

const EPS = 1e-6;
const finiteVector = v => v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

/** Gameplay state machine. Run on the authority (server for multiplayer).
 * Callbacks use world-space meters and synchronous physics queries.
 * No maximum tongue distance or flight timeout is imposed.
 */
export class HexSniperAttacks {
  constructor({ world, pose, visuals = null, ownerId, onEvent = () => {},
    projectileSpeed = 35, returnSpeed = 45, pullSpeed = 12, tongueRadius = .04,
    pullStopDistance = 1.2, biteRange = .75, biteRadius = .38,
    biteDuration = 29 / 30, recoverDuration = 10 / 30 } = {}) {
    for (const name of ['distanceToMapExit', 'sweepTongue', 'getPlayerPosition', 'movePlayerToward', 'queryBite']) {
      if (typeof world?.[name] !== 'function') throw new Error(`HexSniper: world.${name} required`);
    }
    for (const name of ['origin', 'direction', 'pullDestination']) {
      if (typeof pose?.[name] !== 'function') throw new Error(`HexSniper: pose.${name}(out) required`);
    }
    for (const [name, value] of Object.entries({ projectileSpeed, returnSpeed, pullSpeed, tongueRadius, pullStopDistance, biteRange, biteRadius, biteDuration, recoverDuration })) {
      if (!Number.isFinite(value) || value <= 0) throw new Error(`HexSniper: invalid ${name}`);
    }
    Object.assign(this, { world, pose, visuals, ownerId, onEvent, projectileSpeed,
      returnSpeed, pullSpeed, tongueRadius, pullStopDistance, biteRange, biteRadius,
      biteDuration, recoverDuration });
    this.state = 'Idle'; this.attackId = 0; this.elapsed = 0; this.disposed = false;
    this.tip = new Vector3(); this.direction = new Vector3(); this.origin = new Vector3();
    this.next = new Vector3(); this.targetPosition = new Vector3(); this.targetOffset = new Vector3();
    this.destination = new Vector3(); this.step = new Vector3(); this.hit = null;
    this.biteWindows = [[.14, .24], [.36, .70]];
    this.biteSeen = this.biteWindows.map(() => new Set());
  }
  _event(type, extra = {}) { this.onEvent({ type, attackId: this.attackId, state: this.state, ...extra }); }
  _readPose() {
    this.pose.origin(this.origin); this.pose.direction(this.direction);
    if (!finiteVector(this.origin) || !finiteVector(this.direction) || this.direction.lengthSq() < EPS) throw new Error('HexSniper: invalid shot origin or direction');
    this.direction.normalize();
  }
  /** Left click, once per accepted attack. Returns false when busy. */
  tryTongue() {
    if (this.disposed || this.state !== 'Idle') return false;
    this._readPose(); this.tip.copy(this.origin); this.hit = null;
    this.attackId++; this.elapsed = 0; this.state = 'Extending';
    this.visuals?.beginTongue(this.tip); this._event('tongue-start'); return true;
  }
  /** Right click. Two contact windows, not frame-based damage. */
  tryBite() {
    if (this.disposed || this.state !== 'Idle') return false;
    this._readPose(); this.attackId++; this.elapsed = 0; this.state = 'Biting';
    for (const seen of this.biteSeen) seen.clear();
    this.visuals?.bite(); this._event('bite-start'); return true;
  }
  _retract(reason) {
    this.state = 'Retracting'; this.hit = null;
    this.visuals?.beginReturn(); this._event('tongue-return', { reason });
  }
  _recover() {
    this.state = 'Recovering'; this.elapsed = 0;
    this.visuals?.endTongue(); this._event('tongue-recovered');
  }
  /** Delta in seconds; use a gameplay fixed step. Sweeps prevent tunneling. */
  update(dt) {
    if (this.disposed || this.state === 'Idle' || !Number.isFinite(dt) || dt <= 0) return;
    if (this.state === 'Extending') {
      const exit = this.world.distanceToMapExit(this.tip, this.direction, this.tongueRadius);
      if (Number.isNaN(exit) || exit < 0) throw new Error('distanceToMapExit must return >= 0 or Infinity');
      const distance = Math.min(this.projectileSpeed * dt, exit);
      this.next.copy(this.tip).addScaledVector(this.direction, distance);
      const hit = this.world.sweepTongue(this.tip, this.next, { ownerId: this.ownerId, radius: this.tongueRadius });
      if (hit) {
        if (!finiteVector(hit.point)) throw new Error('sweepTongue must return a finite hit.point');
        const along = this.step.copy(hit.point).sub(this.tip).dot(this.direction);
        if (along < -EPS || along > distance + EPS) throw new Error('sweepTongue returned a hit outside its segment');
        this.tip.copy(hit.point);
        if (hit.kind === 'player' && hit.playerId !== this.ownerId && hit.playerId != null && this.world.getPlayerPosition(hit.playerId, this.targetPosition)) {
          this.hit = hit; this.targetOffset.copy(hit.point).sub(this.targetPosition);
          this.state = 'Pulling'; this.visuals?.beginPull();
          this._event('tongue-player', { playerId: hit.playerId, point: this.tip.clone() });
        } else {
          this._event('tongue-world', { point: this.tip.clone() }); this._retract('world');
        }
      } else {
        this.tip.copy(this.next);
        if (exit <= this.projectileSpeed * dt + EPS) this._retract('map-boundary');
      }
      this.visuals?.setTongueEndpoint(this.tip); return;
    }
    if (this.state === 'Pulling') {
      const id = this.hit.playerId;
      if (!this.world.getPlayerPosition(id, this.targetPosition)) { this._retract('target-lost'); return; }
      this.pose.pullDestination(this.destination);
      // Adapter must sweep the player collider, never teleport through walls.
      const result = this.world.movePlayerToward(id, this.destination, {
        maxDistance: this.pullSpeed * dt, stopDistance: this.pullStopDistance, ownerId: this.ownerId
      });
      if (!result || result.valid === false || !this.world.getPlayerPosition(id, this.targetPosition)) { this._retract('target-lost'); return; }
      this.tip.copy(this.targetPosition).add(this.targetOffset);
      this.visuals?.setTongueEndpoint(this.tip);
      if (result.blocked) this._retract('pull-blocked');
      else if (result.reached || this.targetPosition.distanceTo(this.destination) <= this.pullStopDistance + EPS) {
        this._event('player-arrived', { playerId: id }); this._retract('player-arrived');
      }
      return;
    }
    if (this.state === 'Retracting') {
      this.pose.origin(this.origin);
      const distance = this.tip.distanceTo(this.origin);
      if (distance <= this.returnSpeed * dt + EPS) { this.tip.copy(this.origin); this._recover(); }
      else {
        this.step.copy(this.origin).sub(this.tip).multiplyScalar(1 / distance);
        this.tip.addScaledVector(this.step, this.returnSpeed * dt); this.visuals?.setTongueEndpoint(this.tip);
      }
      return;
    }
    if (this.state === 'Recovering') {
      this.elapsed += dt;
      if (this.elapsed >= this.recoverDuration) { this.state = 'Idle'; this._event('ready'); }
      return;
    }
    if (this.state === 'Biting') {
      const before = this.elapsed; this.elapsed += dt; this._readPose();
      this.biteWindows.forEach(([start, end], pulse) => {
        if (before > end || this.elapsed < start) return;
        const hits = this.world.queryBite({ origin: this.origin, direction: this.direction,
          range: this.biteRange, radius: this.biteRadius, ownerId: this.ownerId, attackId: this.attackId, pulse });
        for (const hit of hits || []) {
          if (hit.id == null || hit.id === this.ownerId || this.biteSeen[pulse].has(hit.id)) continue;
          this.biteSeen[pulse].add(hit.id); this._event('bite-hit', { hit, pulse });
        }
      });
      if (this.elapsed >= this.biteDuration) { this.state = 'Idle'; this._event('ready'); }
    }
  }
  /** Death, unequip, stun or disconnect: release without moving the target. */
  cancel(reason = 'cancelled') {
    if (this.disposed || this.state === 'Idle') return;
    this.hit = null; this.state = 'Idle'; this.elapsed = 0;
    this.visuals?.reset(); this._event('cancel', { reason });
  }
  dispose() { this.cancel('disposed'); this.disposed = true; }
}

/** Ray exit from an axis-aligned map box, reduced by the tongue radius. */
export function distanceToBoxExit(point, direction, box, radius = 0) {
  let exit = Infinity;
  for (const axis of ['x', 'y', 'z']) {
    const lo = box.min[axis] + radius, hi = box.max[axis] - radius;
    if (lo > hi || point[axis] < lo || point[axis] > hi) return 0;
    const d = direction[axis];
    if (d > EPS) exit = Math.min(exit, (hi - point[axis]) / d);
    else if (d < -EPS) exit = Math.min(exit, (lo - point[axis]) / d);
  }
  return Math.max(0, exit);
}
