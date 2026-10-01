import { PAINT_MAX_CLUSTERS, PAINT_MAX_NODES, PAINT_TAIL, type PaintProfile } from "./paintTypes";
import { clamp, type ClusterState, mulberry32, Phase, smooth } from "./paintSimState";
import { poseClusters } from "./paintPose";

/**
 * PaintDripSim — pure model of the viscous paint masses on a weapon plate
 * (no DOM, no Three.js: unit-tested in Node, see scripts/test-paint-drip.mts).
 *
 * A drip lives through a real cycle:
 *   ACCUMULATE  the bulb slowly fills (volume flows down the neck)
 *   STRETCH     gravity wins: the drip lengthens, the neck thins (exp. decay)
 *   SNAP        the neck pinches → a droplet is released with the tail speed
 *   RECOIL      the tail springs back (one visible overshoot), then rests
 * Weapon events call impact(): every cluster gets a damped jelly response
 * (underdamped spring: one overshoot) and a drip fills a little faster.
 * Every pose is continuous in the state → interruptions never pop.
 */
const SUBSTEP = 1 / 120;
const SPRING_K = 240;
const SPRING_C = 15; // zeta ~0.48: ~17 % first overshoot, ~3 % second (invisible)
const MAX_WX = 3.5;
const MAX_WY = 3;
const MAX_SQ = 1.2;
const GRAVITY = 600;

export class PaintDripSim {
  /** x, y, z, r per node (PAINT_MAX_NODES entries). */
  readonly nodes = new Float32Array(PAINT_MAX_NODES * 4);
  readonly links = new Float32Array(PAINT_MAX_NODES);
  readonly clusterCount: number;
  nodeCount = 0;
  /** Ambient creep (slow accumulation). Off = frozen drips, impacts still work. */
  ambient = true;

  private readonly states: ClusterState[] = [];
  private readonly rng: () => number;
  private acc = 0;
  private flip = 1;

  constructor(readonly profile: PaintProfile) {
    this.rng = mulberry32(profile.seed);
    let n = 0;
    for (const spec of profile.clusters) {
      const staticCount = spec.nodes.length;
      const st: ClusterState = {
        spec,
        start: n,
        staticCount,
        wx: 0, wv: 0, wy: 0, wvy: 0, sq: 0, sqv: 0,
        hasDrip: !!spec.drip,
        phase: Phase.ACC,
        f: spec.drip?.startFill ?? 0,
        len: 0, lv: 0, vel: 0, stretchBase: 0,
        tipR: spec.drip ? spec.drip.bulb * 0.5 : 0,
        timer: 0,
        dirX: 0, dirY: 1,
        dropOn: false, dropX: 0, dropY: 0, dropVy: 0, dropR: 0,
      };
      if (spec.drip) {
        const l = Math.hypot(spec.drip.dx, spec.drip.dy) || 1;
        st.dirX = spec.drip.dx / l;
        st.dirY = spec.drip.dy / l;
        // Same length the ACC phase computes, so the first frame doesn't jump.
        st.len = 0.22 * spec.drip.maxExtra * smooth(0, 1, st.f);
      }
      n += staticCount + (spec.drip ? PAINT_TAIL + 2 : 0);
      this.states.push(st);
    }
    if (n > PAINT_MAX_NODES) throw new Error(`paint profile ${profile.id}: ${n} nodes > ${PAINT_MAX_NODES}`);
    if (this.states.length > PAINT_MAX_CLUSTERS) throw new Error(`paint profile ${profile.id}: too many clusters`);
    this.clusterCount = this.states.length;
    this.nodeCount = n;
    poseClusters(this.states, this.nodes, this.links);
  }

  /** Node range [start, end) of a cluster (for the renderer). */
  range(i: number): [number, number] {
    const st = this.states[i];
    const end = i + 1 < this.states.length ? this.states[i + 1].start : this.nodeCount;
    return [st.start, end];
  }

  dripPhase(i: number): number {
    return this.states[i].phase;
  }
  dripLength(i: number): number {
    return this.states[i].len;
  }
  hasDroplet(i: number): boolean {
    return this.states[i].dropOn;
  }

  /**
   * 0 = frozen, 1 = slow creep (render at a low cadence), 2 = fast motion
   * (jelly / stretch / recoil / falling droplet → render every frame).
   */
  get activity(): 0 | 1 | 2 {
    for (const st of this.states) {
      if (Math.abs(st.wv) > 0.4 || Math.abs(st.wx) > 0.05 || Math.abs(st.sqv) > 0.4 || Math.abs(st.sq) > 0.02) return 2;
      if (st.dropOn) return 2;
      if (st.hasDrip && (st.phase === Phase.STRETCH || st.phase === Phase.RECOIL)) return 2;
    }
    return this.ambient ? 1 : 0;
  }

  /** Weapon event: shot, hit, reload… strength ~0.3 (light) .. 1 (heavy). */
  impact(strength: number): void {
    const s = clamp(strength, 0, 2);
    this.flip = -this.flip;
    for (const st of this.states) {
      const j = (st.spec.jelly ?? 1) * s;
      st.wv += this.flip * 38 * j;
      st.wvy += 55 * j;
      st.sqv += 14 * j;
      if (st.hasDrip) {
        if (st.phase === Phase.ACC) st.f = Math.min(0.98, st.f + 0.035 * s);
        else if (st.phase === Phase.STRETCH) st.vel += 1.5 * s;
      }
    }
  }

  /** Weapon (re)equipped: drips caught right after a release, then they refill. */
  enter(): void {
    for (const st of this.states) {
      st.wx = st.wv = st.wy = st.wvy = st.sq = st.sqv = 0;
      if (!st.hasDrip) continue;
      const d = st.spec.drip!;
      st.phase = Phase.RECOIL;
      st.len = d.maxExtra * 0.2;
      st.lv = -d.maxExtra * 0.5;
      st.tipR = d.bulb * 0.45;
      st.f = 0;
      this.release(st, 8);
    }
    poseClusters(this.states, this.nodes, this.links);
  }

  step(dt: number): void {
    this.acc += Math.min(Math.max(dt, 0), 0.1);
    while (this.acc >= SUBSTEP) {
      this.acc -= SUBSTEP;
      this.substep(SUBSTEP);
    }
    poseClusters(this.states, this.nodes, this.links);
  }

  private release(st: ClusterState, vy: number): void {
    const d = st.spec.drip!;
    const a = st.spec.nodes[st.staticCount - 1];
    const L = d.rest + st.len;
    st.dropOn = true;
    st.dropX = a.x + st.dirX * L + st.wx * 0.9;
    st.dropY = a.y + st.dirY * L + 2;
    st.dropVy = Math.max(vy, 8);
    st.dropR = d.dropRadius;
  }

  private substep(h: number): void {
    for (const st of this.states) {
      st.wv += (-SPRING_K * st.wx - SPRING_C * st.wv) * h;
      st.wx = clamp(st.wx + st.wv * h, -MAX_WX, MAX_WX);
      st.wvy += (-SPRING_K * st.wy - SPRING_C * st.wvy) * h;
      st.wy = clamp(st.wy + st.wvy * h, -MAX_WY, MAX_WY);
      st.sqv += (-SPRING_K * st.sq - SPRING_C * st.sqv) * h;
      st.sq = clamp(st.sq + st.sqv * h, -MAX_SQ, MAX_SQ);
      if (!st.hasDrip) continue;
      const d = st.spec.drip!;

      if (st.dropOn) {
        st.dropVy += GRAVITY * h;
        st.dropY += st.dropVy * h;
        if (st.dropY > d.killY) st.dropOn = false;
      }

      if (st.phase === Phase.ACC) {
        if (this.ambient) st.f += h / d.accSeconds;
        st.len = 0.22 * d.maxExtra * smooth(0, 1, st.f);
        if (st.f >= 1) {
          st.phase = Phase.STRETCH;
          st.vel = 2.5;
          st.stretchBase = st.len;
        }
      } else if (st.phase === Phase.STRETCH) {
        st.vel += 11 * h;
        st.len += st.vel * h;
        const x = st.len - st.stretchBase;
        const neck = d.neck * 0.82 * Math.exp(-x / (0.3 * d.maxExtra));
        if (neck < 1.25) {
          this.release(st, st.vel * 0.6);
          st.phase = Phase.RECOIL;
          st.lv = -0.55 * st.vel;
          st.tipR = 1.7;
        }
      } else if (st.phase === Phase.RECOIL) {
        st.lv += (-140 * st.len - 9 * st.lv) * h;
        st.len = Math.max(st.len + st.lv * h, -d.rest * 0.5);
        st.tipR = Math.min(st.tipR + 0.6 * h, d.bulb * 0.5);
        if (Math.abs(st.len) < 0.15 && Math.abs(st.lv) < 2) {
          st.len = 0;
          st.lv = 0;
          st.phase = Phase.REST;
          st.timer = d.restSeconds * (0.8 + 0.4 * this.rng());
        }
      } else {
        st.tipR = Math.min(st.tipR + 0.6 * h, d.bulb * 0.5);
        if (this.ambient) st.timer -= h;
        if (st.timer <= 0) {
          st.phase = Phase.ACC;
          st.f = 0;
        }
      }
    }
  }
}
