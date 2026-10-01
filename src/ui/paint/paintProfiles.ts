import type { PaintProfile } from "./paintTypes";

/**
 * Paint profiles — geometry of the viscous masses of a weapon plate, in PLATE
 * pixels (origin = top-left of the 170 × 72 plate box, y down). Measured on
 * the close-up reference (≈ 4.26 close-up px per plate px):
 *
 *   badge  0..49 × 12..55      tab   46..132 × 0..22 (hangs over the face)
 *   face   49..169 × 20..50    rail  30..164 × 50..72 (ball magazine)
 *
 * Node z = height above the frame (z = 0 is the frame top). Low-z wide nodes
 * are the fillets where the paint spreads onto the frame at its attachments.
 * Radii are generous on purpose: the mass must read as a fat, wet lump.
 */
const FRAME = {
  rects: [
    [49, 20, 120, 30],
    [30, 50, 134, 22],
  ],
  radii: [11, 11],
} as const;

const CANVAS = { x: -12, y: -14, w: 226, h: 126 };

const PAINTBALL: PaintProfile = {
  id: "paintball",
  seed: 7,
  canvas: CANVAS,
  frame: FRAME,
  clusters: [
    {
      // PINK — heavy lump hooked over the right end of the face, then a neck
      // and a lower lobe that keeps filling (the drip).
      id: "pink",
      color: [1.0, 0.27, 0.58],
      material: { gloss: 0.95, spec: 1.0, sss: 0.35, opacity: 1 },
      jelly: 1,
      nodes: [
        { x: 187, y: 35, z: 7, r: 5.5, w: 0.6, link: false },
        { x: 165, y: 17.5, z: 5, r: 4.5, w: 0.15 },
        { x: 172, y: 22, z: 8.5, r: 8, w: 0.3 },
        { x: 177, y: 29, z: 10.5, r: 10.5, w: 0.5 },
        { x: 175, y: 37.5, z: 8, r: 6.4, w: 0.7 },
        { x: 181, y: 44, z: 7.5, r: 5.4, w: 0.85 },
      ],
      drip: {
        dx: 0.02, dy: 1, rest: 7, neck: 3.6, bulb: 5.4,
        maxExtra: 22, accSeconds: 7.5, restSeconds: 2.5, startFill: 0.55,
        dropRadius: 4.4, killY: 100,
      },
    },
    {
      // YELLOW — thin smear along the top rim, thickening into the pink lump.
      id: "yellow",
      color: [1.0, 0.8, 0.12],
      material: { gloss: 0.9, spec: 0.9, sss: 0.3, opacity: 1 },
      jelly: 0.6,
      nodes: [
        { x: 146, y: 20.4, z: 2.4, r: 2.6, w: 0.1 },
        { x: 153, y: 19.8, z: 3.2, r: 3.6, w: 0.12 },
        { x: 160, y: 20.2, z: 3.8, r: 4.4, w: 0.15 },
        { x: 166, y: 21, z: 4.6, r: 5, w: 0.2 },
        { x: 171, y: 22.5, z: 5.6, r: 5.6, w: 0.3 },
      ],
    },
    {
      // CYAN — fat head on the left end of the rail, long drip with a bulb.
      id: "cyan",
      color: [0.13, 0.82, 0.93],
      material: { gloss: 0.95, spec: 1.0, sss: 0.35, opacity: 1 },
      jelly: 0.9,
      nodes: [
        { x: 44, y: 51, z: 3, r: 3, w: 0.1 },
        { x: 37, y: 54, z: 6.5, r: 6, w: 0.3 },
        { x: 30, y: 57, z: 7.5, r: 6.6, w: 0.5 },
        { x: 28, y: 61, z: 6.5, r: 4.6, w: 0.8 },
      ],
      drip: {
        dx: 0.02, dy: 1, rest: 7, neck: 3.4, bulb: 5.6,
        maxExtra: 12, accSeconds: 11, restSeconds: 3, startFill: 0.5,
        dropRadius: 3.8, killY: 100,
      },
    },
  ],
};

/** POISON — toxic-green ooze: a bead on the top edge + a slow drip off the rail. */
const POISON: PaintProfile = {
  id: "poison",
  seed: 21,
  canvas: CANVAS,
  frame: FRAME,
  clusters: [
    {
      id: "ooze",
      color: [0.45, 0.95, 0.18],
      material: { gloss: 0.8, spec: 0.8, sss: 0.6, opacity: 1 },
      jelly: 0.8,
      nodes: [
        { x: 140, y: 17, z: 3, r: 3, w: 0.1 },
        { x: 149, y: 18.5, z: 5.5, r: 5.5, w: 0.2 },
        { x: 157, y: 22, z: 7.5, r: 8, w: 0.35 },
        { x: 160, y: 29, z: 6.5, r: 6, w: 0.4 },
        { x: 160, y: 35, z: 5.5, r: 4, w: 0.4 },
      ],
      drip: {
        dx: 0.02, dy: 1, rest: 8, neck: 3, bulb: 4.6,
        maxExtra: 20, accSeconds: 9, restSeconds: 3, startFill: 0.4,
        dropRadius: 3.4, killY: 100,
      },
    },
    {
      id: "puddle",
      color: [0.45, 0.95, 0.18],
      material: { gloss: 0.8, spec: 0.8, sss: 0.6, opacity: 1 },
      jelly: 0.6,
      nodes: [
        { x: 60, y: 69, z: 2, r: 2.6, w: 0.1 },
        { x: 68, y: 70, z: 3.5, r: 3.8, w: 0.2 },
        { x: 76, y: 71.5, z: 4.5, r: 4.8, w: 0.3 },
      ],
      drip: {
        dx: 0, dy: 1, rest: 6, neck: 2.6, bulb: 4,
        maxExtra: 16, accSeconds: 12, restSeconds: 3, startFill: 0.1,
        dropRadius: 3, killY: 100,
      },
    },
  ],
};

export const PAINT_PROFILES: Readonly<Record<string, PaintProfile>> = {
  paintball: PAINTBALL,
  poison: POISON,
};
