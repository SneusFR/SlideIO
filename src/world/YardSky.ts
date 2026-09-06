import * as THREE from "three";
import { YardConfig as cfg } from "./YardConfig";

/**
 * YARD 01 backdrop: "clear industrial early afternoon (~14h)" — the map's
 * OWN skybox, deliberately distinct from the Jungle map's violet space sky.
 *
 * Layered for depth (far → near):
 *   gradient dome (pale sunlit horizon → summer blue → saturated zenith)
 *   → high white sun disk (canvas sprite, matches the DirectionalLight)
 *   → faint acid-green sheen over the west wing (the pool's "halo")
 *   → a few slowly-drifting white cloud sprites
 *
 * Design constraints (fast browser FPS — same rules as SpaceSky):
 *  - No real lights, no textures fetched: everything is canvas gradients.
 *  - A handful of additive sprites + one dome mesh — tiny draw-call cost.
 *  - The whole group follows the camera each frame so the sky reads as
 *    infinitely far and can never feel "glued" to the map.
 *  - No fog on any sky material (the haze only melts real map geometry).
 *
 * Purely visual: nothing here is raycastable, collidable or gameplay-affecting.
 */
export class YardSky {
  readonly group = new THREE.Group();

  private readonly smogSprites: THREE.Sprite[] = [];
  private readonly disposables: { dispose(): void }[] = [];

  constructor() {
    this.buildDome();
    this.buildSun();
    this.buildAcidGlow();
    this.buildSmog();
  }

  /** Inverted sphere with the 3-stop midday gradient. */
  private buildDome(): void {
    const geo = new THREE.SphereGeometry(cfg.skyRadius, 32, 20);
    const pos = geo.getAttribute("position");
    const colors = new Float32Array(pos.count * 3);
    const horizon = new THREE.Color(cfg.horizonColor);
    const mid = new THREE.Color(cfg.horizonMidColor);
    const zenith = new THREE.Color(cfg.zenithColor);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      // 0 at/below horizon → 1 at zenith. The pale haze band stays thin at
      // the horizon; the sky turns blue quickly like a clear summer day.
      const t = Math.pow(Math.max(pos.getY(i) / cfg.skyRadius, 0), 0.6);
      if (t < 0.25) c.lerpColors(horizon, mid, t / 0.25);
      else c.lerpColors(mid, zenith, (t - 0.25) / 0.75);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.disposables.push(geo, mat);
    const dome = new THREE.Mesh(geo, mat);
    dome.renderOrder = -10; // behind everything
    dome.frustumCulled = false;
    this.group.add(dome);
  }

  /** High midday sun: one bright additive sprite matching the light direction. */
  private buildSun(): void {
    const tex = makeGlowTexture(128, [
      [0.0, "rgba(255, 255, 250, 1.0)"],
      [0.12, "rgba(255, 250, 230, 0.9)"],
      [0.35, "rgba(255, 240, 200, 0.35)"],
      [1.0, "rgba(200, 220, 255, 0)"],
    ]);
    this.disposables.push(tex);
    const mat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    this.disposables.push(mat);
    const sun = new THREE.Sprite(mat);
    sun.position
      .set(cfg.sunPosition.x, cfg.sunPosition.y, cfg.sunPosition.z)
      .normalize()
      .multiplyScalar(cfg.skyRadius * 0.92);
    sun.scale.setScalar(cfg.sunScale);
    this.group.add(sun);
  }

  /** Faint acid-green sheen low over the west wing (the pool's halo) —
   *  much subtler in full daylight, but it keeps the map's identity. */
  private buildAcidGlow(): void {
    const tex = makeGlowTexture(128, [
      [0.0, "rgba(154, 230, 90, 0.4)"],
      [0.4, "rgba(120, 190, 80, 0.16)"],
      [1.0, "rgba(90, 140, 70, 0)"],
    ]);
    this.disposables.push(tex);
    const mat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      opacity: cfg.acidGlowOpacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    this.disposables.push(mat);
    const glow = new THREE.Sprite(mat);
    glow.position
      .set(cfg.acidGlowPosition.x, cfg.acidGlowPosition.y, cfg.acidGlowPosition.z)
      .normalize()
      .multiplyScalar(cfg.skyRadius * 0.9);
    glow.scale.setScalar(cfg.acidGlowScale);
    this.group.add(glow);
  }

  /** A few big drifting white cloud sprites — barely-perceptible motion. */
  private buildSmog(): void {
    const tex = makeGlowTexture(256, [
      [0.0, "rgba(255, 255, 255, 0.55)"],
      [0.4, "rgba(250, 252, 255, 0.3)"],
      [1.0, "rgba(235, 242, 250, 0)"],
    ]);
    this.disposables.push(tex);
    const placements: { dir: THREE.Vector3; scale: number; opacity: number }[] = [
      { dir: new THREE.Vector3(-0.7, 0.35, -0.55), scale: 240, opacity: 1.0 },
      { dir: new THREE.Vector3(0.6, 0.25, -0.65), scale: 190, opacity: 0.75 },
      { dir: new THREE.Vector3(0.2, 0.4, 0.85), scale: 210, opacity: 0.65 },
    ];
    const r = cfg.skyRadius * 0.88;
    for (let i = 0; i < Math.min(cfg.smogSprites, placements.length); i++) {
      const p = placements[i];
      const mat = new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        opacity: p.opacity * cfg.smogIntensity,
        blending: THREE.NormalBlending,
        depthWrite: false,
        fog: false,
      });
      this.disposables.push(mat);
      const sprite = new THREE.Sprite(mat);
      sprite.position.copy(p.dir).normalize().multiplyScalar(r);
      sprite.scale.setScalar(p.scale);
      this.smogSprites.push(sprite);
      this.group.add(sprite);
    }
  }

  /**
   * Same signature as SpaceSky.update so the Game can hold either sky.
   * @param _dt      unused (no transient effects like meteors here)
   * @param elapsed  total seconds (slow smog rotation)
   * @param camera   the sky follows the camera so it reads as infinitely far
   */
  update(_dt: number, elapsed: number, camera: THREE.Camera): void {
    this.group.position.copy(camera.position);
    for (let i = 0; i < this.smogSprites.length; i++) {
      const mat = this.smogSprites[i].material as THREE.SpriteMaterial;
      mat.rotation = elapsed * 0.002 * (i % 2 === 0 ? 1 : -1);
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.group.removeFromParent();
  }
}

/** Radial-gradient canvas texture (same helper pattern as SpaceSky). */
function makeGlowTexture(size: number, stops: [number, string][]): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const grad = ctx.createRadialGradient(
    size / 2,
    size / 2,
    0,
    size / 2,
    size / 2,
    size / 2,
  );
  for (const [offset, color] of stops) grad.addColorStop(offset, color);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
