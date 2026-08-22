import * as THREE from "three";
import { MenuSceneConfig as cfg } from "./MenuConfig";

/**
 * Animated "prairie night" backdrop for the Main Menu — a starry meadow
 * sky full of fireflies with soft leafy-green glows and a big mossy moon.
 *
 * Layered for depth (far → near):
 *   far fireflies → green glow sprites → mossy moon → drifting pollen
 *
 * Everything moves EXTREMELY slowly (drift + slow rotation) and the whole
 * group reacts subtly to mouse parallax (driven by MainMenu). Built from
 * cheap primitives: two Points clouds, a handful of additive sprites with
 * canvas-generated radial gradients and one low-poly sphere. No shaders,
 * no post-processing — the menu stays trivially GPU-cheap.
 */
export class SpaceBackground {
  readonly group = new THREE.Group();

  /** Layers with different parallax factors (far moves less). */
  private readonly farLayer = new THREE.Group();
  private readonly midLayer = new THREE.Group();
  private readonly nearLayer = new THREE.Group();

  private readonly starsFar: THREE.Points;
  private readonly starsNear: THREE.Points;
  private readonly dust: THREE.Points;
  private readonly nebulaSprites: THREE.Sprite[] = [];
  private readonly planet: THREE.Mesh;

  private readonly disposables: { dispose(): void }[] = [];

  constructor() {
    this.group.add(this.farLayer, this.midLayer, this.nearLayer);

    // ---- Stars (two depths for parallax) ----
    this.starsFar = this.makeStars(cfg.background.starCountFar, 60, 110, 0.9, 0.55);
    this.farLayer.add(this.starsFar);
    this.starsNear = this.makeStars(cfg.background.starCountNear, 35, 60, 1.6, 0.8);
    this.midLayer.add(this.starsNear);

    // ---- Meadow glow: big soft green gradient sprites, additive ----
    const nebulaTex = makeGlowTexture(256, [
      [0.0, "rgba(74, 222, 128, 0.55)"],
      [0.35, "rgba(22, 163, 74, 0.28)"],
      [0.7, "rgba(16, 90, 40, 0.10)"],
      [1.0, "rgba(6, 30, 14, 0)"],
    ]);
    this.disposables.push(nebulaTex);
    const nebulaPositions: [number, number, number, number, number][] = [
      // x, y, z, scale, opacity
      [-34, 6, -70, 62, 0.5],
      [28, -10, -80, 75, 0.42],
      [8, 16, -90, 55, 0.3],
      [-15, -18, -75, 48, 0.32],
      [42, 14, -95, 60, 0.25],
    ];
    for (let i = 0; i < Math.min(cfg.background.nebulaSprites, nebulaPositions.length); i++) {
      const [x, y, z, s, o] = nebulaPositions[i];
      const mat = new THREE.SpriteMaterial({
        map: nebulaTex,
        transparent: true,
        opacity: o,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      this.disposables.push(mat);
      const sprite = new THREE.Sprite(mat);
      sprite.position.set(x, y, z);
      sprite.scale.setScalar(s);
      this.nebulaSprites.push(sprite);
      this.farLayer.add(sprite);
    }

    // ---- Big mossy bean-moon, bottom-left like the reference ----
    const planetGeo = new THREE.SphereGeometry(11, 40, 28);
    const planetMat = new THREE.MeshStandardMaterial({
      color: 0x143520,
      roughness: 0.92,
      metalness: 0.1,
      emissive: 0x0e2e16,
      emissiveIntensity: 0.35,
    });
    this.disposables.push(planetGeo, planetMat);
    this.planet = new THREE.Mesh(planetGeo, planetMat);
    this.planet.position.set(-16, -8, -46);
    this.planet.frustumCulled = true;
    this.midLayer.add(this.planet);

    // Thin atmospheric halo behind the moon.
    const haloTex = makeGlowTexture(128, [
      [0.0, "rgba(74, 222, 128, 0.0)"],
      [0.62, "rgba(74, 222, 128, 0.0)"],
      [0.74, "rgba(74, 222, 128, 0.28)"],
      [0.85, "rgba(22, 163, 74, 0.10)"],
      [1.0, "rgba(6, 30, 14, 0)"],
    ]);
    this.disposables.push(haloTex);
    const haloMat = new THREE.SpriteMaterial({
      map: haloTex,
      transparent: true,
      opacity: 0.8,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.disposables.push(haloMat);
    const halo = new THREE.Sprite(haloMat);
    halo.position.copy(this.planet.position);
    halo.position.z -= 0.5;
    halo.scale.setScalar(26);
    this.midLayer.add(halo);

    // ---- Drifting pollen / fireflies (near layer) ----
    this.dust = this.makeStars(cfg.background.dustCount, 8, 25, 0.9, 0.28);
    this.nearLayer.add(this.dust);
  }

  private makeStars(
    count: number,
    minR: number,
    maxR: number,
    size: number,
    opacity: number,
  ): THREE.Points {
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      // Random points on a shell behind/around the scene (z pushed back).
      const r = minR + Math.random() * (maxR - minR);
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta) * 0.6;
      positions[i * 3 + 2] = -Math.abs(r * Math.cos(phi)) - minR * 0.5;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xdcf5cd,
      size,
      sizeAttenuation: false,
      transparent: true,
      opacity,
      depthWrite: false,
    });
    this.disposables.push(geo, mat);
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false; // full-sky shells — skip per-frame culling math
    return pts;
  }

  /**
   * @param elapsed  total seconds
   * @param parallaxX / parallaxY  smoothed -1..1 mouse offsets
   */
  update(elapsed: number, parallaxX: number, parallaxY: number): void {
    // Ultra-slow star drift — the sky feels alive, never like a GIF.
    this.starsFar.rotation.y = elapsed * 0.0016;
    this.starsNear.rotation.y = elapsed * 0.003;
    this.dust.rotation.y = elapsed * 0.006;
    this.dust.position.y = Math.sin(elapsed * 0.05) * 0.4;

    // Nebula: barely-perceptible breathing.
    for (let i = 0; i < this.nebulaSprites.length; i++) {
      const s = this.nebulaSprites[i];
      const mat = s.material as THREE.SpriteMaterial;
      mat.rotation = elapsed * 0.002 * (i % 2 === 0 ? 1 : -1);
    }

    // Planet: quasi-static rotation.
    this.planet.rotation.y = elapsed * 0.004;

    // Parallax: far layer moves least, near layer the most.
    const p = cfg.parallax.backgroundShift;
    this.farLayer.position.set(parallaxX * p * 4, -parallaxY * p * 3, 0);
    this.midLayer.position.set(parallaxX * p * 9, -parallaxY * p * 6, 0);
    this.nearLayer.position.set(parallaxX * p * 16, -parallaxY * p * 10, 0);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.group.removeFromParent();
  }
}

/** Radial-gradient canvas texture used for nebulas / halos / glows. */
function makeGlowTexture(
  size: number,
  stops: [number, string][],
): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const grad = ctx.createRadialGradient(
    size / 2, size / 2, 0,
    size / 2, size / 2, size / 2,
  );
  for (const [pos, color] of stops) grad.addColorStop(pos, color);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.generateMipmaps = true;
  return tex;
}