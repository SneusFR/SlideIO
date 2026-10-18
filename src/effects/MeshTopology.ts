import * as THREE from "three";

/**
 * Vertex topology of a character mesh for the hit-spread effects (paint
 * splats, wet marks): UV-seam duplicates welded on their bind position,
 * the duplicates of each welded vertex, and the welded neighbours.
 *
 * PERF: it only depends on the SOURCE geometry, which every clone of a
 * character shares (same position attribute + index) — computed ONCE per
 * geometry and shared by every bot / corpse / remote. It used to be rebuilt
 * on the first hit of EVERY character (string-keyed weld of ~10 000 vertices
 * + one Set per vertex): a several-millisecond hitch plus a burst of garbage
 * at each first paint / water hit.
 */
export interface MeshTopology {
  /** vertex → welded representative */
  readonly weld: Int32Array;
  /** representative → its duplicate vertices (undefined for non-representatives) */
  readonly members: ReadonlyArray<Int32Array | undefined>;
  /** representative → neighbour representatives */
  readonly nbr: ReadonlyArray<Int32Array | undefined>;
}

type PositionAttribute = THREE.BufferAttribute | THREE.InterleavedBufferAttribute;

const cache = new WeakMap<PositionAttribute, { index: THREE.BufferAttribute | null; topology: MeshTopology }>();

/** Topology of `geometry` (cached on its position attribute + index). */
export function meshTopology(geometry: THREE.BufferGeometry): MeshTopology {
  const pos = geometry.getAttribute("position") as PositionAttribute;
  const index = geometry.index;
  const hit = cache.get(pos);
  if (hit && hit.index === index) return hit.topology;

  const n = pos.count;
  const key = new Map<string, number>();
  const weld = new Int32Array(n);
  const mem: number[][] = [];
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(pos.getX(i) * 1e4)},${Math.round(pos.getY(i) * 1e4)},${Math.round(pos.getZ(i) * 1e4)}`;
    let r = key.get(k);
    if (r === undefined) {
      r = i;
      key.set(k, i);
    }
    weld[i] = r;
    (mem[r] ??= []).push(i);
  }
  const members: (Int32Array | undefined)[] = [];
  for (let i = 0; i < n; i++) if (mem[i]) members[i] = Int32Array.from(mem[i]);
  const nb: (Set<number> | undefined)[] = [];
  const tri = index ? index.count : n;
  for (let t = 0; t < tri; t += 3) {
    const v0 = weld[index ? index.getX(t) : t];
    const v1 = weld[index ? index.getX(t + 1) : t + 1];
    const v2 = weld[index ? index.getX(t + 2) : t + 2];
    (nb[v0] ??= new Set()).add(v1).add(v2);
    (nb[v1] ??= new Set()).add(v0).add(v2);
    (nb[v2] ??= new Set()).add(v0).add(v1);
  }
  const nbr: (Int32Array | undefined)[] = [];
  for (let i = 0; i < n; i++) if (nb[i]) nbr[i] = Int32Array.from(nb[i]!);

  const topology: MeshTopology = { weld, members, nbr };
  cache.set(pos, { index, topology });
  return topology;
}
