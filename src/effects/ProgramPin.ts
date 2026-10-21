import type * as THREE from "three";
import { watchProgram } from "./UniformCacheKinds";

/**
 * PERF — a compiled shader program is NEVER released during a session.
 *
 * three.js destroys a program as soon as the LAST material using it is
 * disposed; the next material with the same cache key compiles it again —
 * on Windows (ANGLE / D3D11) a 10–300 ms freeze, mid-fight. Several effects
 * clone and dispose materials as they come and go (disc impact rings, the
 * paint / wet skins of a hit character, corpse fades, outfit pieces, ball
 * skins), and the GPU warm-up itself disposes the clones it compiled with:
 * every one of those programs used to be compiled again in play.
 *
 * Pinning adds ONE use to each program: three keeps it in its cache, the
 * next material with the same key reuses it at no cost. Memory: a few KB of
 * driver memory per program (a few hundred programs at most).
 */
const pinned = new WeakSet<object>();
const lastCount = new WeakMap<THREE.WebGLRenderer, number>();

/**
 * Pins every program compiled since the previous call (cheap when none) —
 * and gives its float uniforms raw-double caches (see UniformCacheKinds).
 */
export function pinNewPrograms(renderer: THREE.WebGLRenderer): void {
  const programs = renderer.info.programs;
  if (!programs || programs.length === lastCount.get(renderer)) return;
  for (const program of programs) {
    if (pinned.has(program)) continue;
    pinned.add(program);
    (program as unknown as { usedTimes: number }).usedTimes++;
    watchProgram(program);
  }
  lastCount.set(renderer, programs.length);
}
