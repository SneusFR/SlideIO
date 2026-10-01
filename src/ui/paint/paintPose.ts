import { PAINT_TAIL } from "./paintTypes";
import { clamp, ClusterState, lerp, Phase, smooth } from "./paintSimState";

/**
 * Writes the CURRENT pose of every cluster into the node / link buffers
 * uploaded to the paint shader. Pure function of the state: every output is
 * continuous in the state, so interrupting a phase never pops.
 *
 * Per cluster: the static nodes (jelly-offset), then PAINT_TAIL tail nodes,
 * then 2 nodes for the released droplet (tapered capsule = teardrop; both
 * collapse to radius 0 when no droplet exists).
 */
export function poseClusters(states: readonly ClusterState[], N: Float32Array, L: Float32Array): void {
  for (const st of states) {
    const spec = st.spec;
    let o = st.start;
    const squash = 1 + 0.045 * st.sq;
    for (let i = 0; i < st.staticCount; i++) {
      const nd = spec.nodes[i];
      const w = nd.w ?? 0.5;
      N[o * 4] = nd.x + st.wx * w;
      N[o * 4 + 1] = nd.y + st.wy * w;
      N[o * 4 + 2] = nd.z;
      N[o * 4 + 3] = nd.r * (1 + (squash - 1) * (0.4 + w));
      const last = i === st.staticCount - 1;
      L[o] = last ? (st.hasDrip ? 1 : 0) : nd.link === false ? 0 : 1;
      o++;
    }
    if (!st.hasDrip) continue;
    const d = spec.drip!;
    const a = spec.nodes[st.staticCount - 1];
    const ax = N[(o - 1) * 4];
    const ay = N[(o - 1) * 4 + 1];
    const ra = N[(o - 1) * 4 + 3];
    const e = smooth(0, 1, st.f);
    let neck: number;
    let endR: number;
    if (st.phase === Phase.ACC) {
      neck = d.neck * (1 - 0.18 * e);
      endR = lerp(st.tipR, d.bulb * (0.8 + 0.3 * e), smooth(0, 0.45, st.f));
    } else if (st.phase === Phase.STRETCH) {
      const x = st.len - st.stretchBase;
      neck = d.neck * 0.82 * Math.exp(-x / (0.3 * d.maxExtra));
      endR = d.bulb * (1.1 + 0.15 * Math.min(1, x / d.maxExtra));
    } else {
      neck = d.neck * 0.9;
      endR = st.tipR;
    }
    const length = Math.max(d.rest + st.len, 2);
    for (let k = 1; k <= PAINT_TAIL; k++) {
      const t = k / PAINT_TAIL;
      N[o * 4] = ax + st.dirX * length * t + st.wx * Math.pow(t, 1.4);
      N[o * 4 + 1] = ay + st.dirY * length * t + st.wy * 0.4 * t;
      N[o * 4 + 2] = a.z * (1 - 0.35 * t);
      N[o * 4 + 3] = t < 0.55 ? lerp(ra, neck, smooth(0, 0.55, t)) : lerp(neck, endR, smooth(0.55, 1, t));
      L[o] = k < PAINT_TAIL ? 1 : 0;
      o++;
    }
    if (st.dropOn) {
      const fade = clamp((d.killY - st.dropY) / 14, 0, 1);
      const r = st.dropR * fade;
      const s = clamp(st.dropVy / 420, 0, 1);
      N[o * 4] = st.dropX;
      N[o * 4 + 1] = st.dropY - r * (0.9 + 1.5 * s);
      N[o * 4 + 2] = a.z * 0.6;
      N[o * 4 + 3] = r * 0.28;
      L[o] = 1;
      o++;
      N[o * 4] = st.dropX;
      N[o * 4 + 1] = st.dropY;
      N[o * 4 + 2] = a.z * 0.6;
      N[o * 4 + 3] = r;
      L[o] = 0;
      o++;
    } else {
      for (let k = 0; k < 2; k++) {
        N[o * 4] = ax;
        N[o * 4 + 1] = ay;
        N[o * 4 + 2] = 0;
        N[o * 4 + 3] = 0;
        L[o] = 0;
        o++;
      }
    }
  }
}
