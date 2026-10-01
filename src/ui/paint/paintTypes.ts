/**
 * Shared types / limits of the weapon-plate PAINT layer (pure data, no DOM,
 * no Three.js). A paint profile describes, in plate pixels, the viscous
 * masses of one weapon: chains of capsule nodes (x, y, z, radius) that the
 * PaintDripSim animates and the PaintRenderer raymarches as ONE continuous
 * signed-distance surface (smooth union → no visible spheres).
 */
export const PAINT_MAX_NODES = 48;
export const PAINT_MAX_CLUSTERS = 6;
/** Hanging nodes per drip (excluding the anchor, a static node). */
export const PAINT_TAIL = 6;

export interface PaintNodeSpec {
  x: number;
  y: number;
  z: number;
  r: number;
  /** Jelly weight: how much the node follows the cluster wobble (0..1). */
  w?: number;
  /** false = no segment to the next node (ends a sub-chain). */
  link?: boolean;
}

export interface PaintDripSpec {
  /** Hanging direction (normalised internally). */
  dx: number;
  dy: number;
  /** Rest length (px) of the hanging tail. */
  rest: number;
  /** Neck / bulb radius (px). */
  neck: number;
  bulb: number;
  /** Extra length (px) reachable while stretching. */
  maxExtra: number;
  accSeconds: number;
  restSeconds: number;
  /** Initial fill 0..1 of the accumulate phase. */
  startFill: number;
  dropRadius: number;
  /** Droplets die when they fall below this y (plate px). */
  killY: number;
}

export interface PaintMaterial {
  /** 0..1 tightness of the reflections. */
  gloss: number;
  /** Reflection strength. */
  spec: number;
  /** Pigment glow on grazing edges. */
  sss: number;
  /** Final opacity (1 = opaque pigment). */
  opacity: number;
}

export interface PaintClusterSpec {
  id: string;
  color: readonly [number, number, number];
  material: PaintMaterial;
  nodes: PaintNodeSpec[];
  drip?: PaintDripSpec;
  /** Reaction multiplier to impacts (default 1). */
  jelly?: number;
}

/** x, y, w, h in plate px. */
export type PaintRect = readonly [number, number, number, number];

export interface PaintProfile {
  id: string;
  seed: number;
  /** Canvas rectangle relative to the plate box (CSS px). */
  canvas: { x: number; y: number; w: number; h: number };
  /** The plate rects the paint rests on (shading only) + corner radii. */
  frame: { rects: readonly [PaintRect, PaintRect]; radii: readonly [number, number] };
  clusters: PaintClusterSpec[];
}
