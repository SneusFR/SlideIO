import * as THREE from "three";

/**
 * The musical scale fired by the Bass Blaster. Shots cycle through this
 * sequence forever: Do → Ré → Mi → Fa → Sol → La → Si → Do' → Do → …
 *
 * Each note owns:
 *   - a NAME (display / debugging),
 *   - a strong signature COLOR (projectile, trail, muzzle flash),
 *   - a brighter accent color (glyph core / sparkles),
 *   - a PITCH ratio on the equal-tempered scale (audio blip per shot).
 */
export interface NoteDef {
  name: string;
  /** Main saturated color. */
  color: THREE.Color;
  /** Brighter accent (core / sparkles). */
  bright: THREE.Color;
  /** Equal-tempered pitch ratio relative to Do (C). */
  pitch: number;
  /** Display glyph (alternating for visual variety). */
  glyph: "single" | "double";
}

const semitone = (n: number) => Math.pow(2, n / 12);

export const NOTE_SEQUENCE: readonly NoteDef[] = [
  { name: "DO", color: new THREE.Color(0xff3b30), bright: new THREE.Color(0xff8a80), pitch: semitone(0), glyph: "single" },
  { name: "RÉ", color: new THREE.Color(0xff9500), bright: new THREE.Color(0xffc966), pitch: semitone(2), glyph: "double" },
  { name: "MI", color: new THREE.Color(0xffe135), bright: new THREE.Color(0xfff59d), pitch: semitone(4), glyph: "single" },
  { name: "FA", color: new THREE.Color(0x34e04a), bright: new THREE.Color(0x9dff9d), pitch: semitone(5), glyph: "double" },
  { name: "SOL", color: new THREE.Color(0x22d3ee), bright: new THREE.Color(0xa5f3fc), pitch: semitone(7), glyph: "single" },
  { name: "LA", color: new THREE.Color(0x3b82f6), bright: new THREE.Color(0x93c5fd), pitch: semitone(9), glyph: "double" },
  { name: "SI", color: new THREE.Color(0xa855f7), bright: new THREE.Color(0xd8b4fe), pitch: semitone(11), glyph: "single" },
  { name: "DO'", color: new THREE.Color(0xff2d92), bright: new THREE.Color(0xff9ecb), pitch: semitone(12), glyph: "double" },
] as const;

export const NOTE_COUNT = NOTE_SEQUENCE.length;

/** Wraps any shot counter into the cyclic note sequence. */
export function noteForShot(shotIndex: number): NoteDef {
  return NOTE_SEQUENCE[((shotIndex % NOTE_COUNT) + NOTE_COUNT) % NOTE_COUNT];
}

// ---------------------------------------------------------------------
// Shared sprite textures (canvas-generated once, reused everywhere)
// ---------------------------------------------------------------------

let glyphSingleTex: THREE.Texture | null = null;
let glyphDoubleTex: THREE.Texture | null = null;
let haloTex: THREE.Texture | null = null;

function makeGlyphTexture(glyph: string): THREE.Texture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, size, size);
  // Soft outer glow + crisp white glyph (tinted by the sprite material).
  ctx.font = "bold 92px 'Segoe UI Symbol','Arial Unicode MS',sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(255,255,255,0.95)";
  ctx.shadowBlur = 22;
  ctx.fillStyle = "#ffffff";
  ctx.fillText(glyph, size / 2, size / 2 + 4);
  ctx.shadowBlur = 8;
  ctx.fillText(glyph, size / 2, size / 2 + 4);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeHaloTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,0.9)");
  g.addColorStop(0.35, "rgba(255,255,255,0.35)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Note glyph texture ("♪" or "♫") — created once, shared by every sprite. */
export function getNoteGlyphTexture(glyph: "single" | "double"): THREE.Texture {
  if (glyph === "single") {
    if (!glyphSingleTex) glyphSingleTex = makeGlyphTexture("\u266A"); // ♪
    return glyphSingleTex;
  }
  if (!glyphDoubleTex) glyphDoubleTex = makeGlyphTexture("\u266B"); // ♫
  return glyphDoubleTex;
}

/** Soft radial halo texture — created once, shared by every sprite. */
export function getNoteHaloTexture(): THREE.Texture {
  if (!haloTex) haloTex = makeHaloTexture();
  return haloTex;
}