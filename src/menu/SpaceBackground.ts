import * as THREE from "three";
import { MenuSceneConfig as cfg } from "./MenuConfig";

/**
 * Goofy "bean prairie" daytime backdrop for the Main Menu — a sunny
 * cartoon sky with a warm sun, drifting fluffy clouds, layered rolling
 * hills and floating pollen motes.
 *
 * Layered for depth (far → near):
 *   sky gradient → sun + far hills → clouds + mid hills → near hills + pollen
 *
 * Everything moves EXTREMELY slowly (cloud drift, pollen sway) and the
 * whole group reacts subtly to mouse parallax (driven by MainMenu).
 * Built from cheap primitives: canvas-gradient planes/sprites and one
 * Points cloud. No shaders, no post-processing — trivially GPU-cheap.
 *
 * NOTE: class keeps its historical name (SpaceBackground) so the menu
 * wiring stays untouched.
 */
export class SpaceBackground {
  readonly group = new THREE.Group();

  /** Layers with different parallax factors (far moves less). */
  private readonly farLayer = new THREE.Group();
  private readonly midLayer = new THREE.Group();
  private readonly nearLayer = new THREE.Group();

  private readonly clouds: THREE.Sprite[] = [];
  private readonly cloudSpeeds: number[] = [];
  private readonly cloudBaseY: number[] = [];
  private readonly pollen: THREE.Points;
  private readonly sunGlow: THREE.Sprite;

  private readonly disposables: { dispose(): void }[] = [];

  constructor() {
    this.group.add(this.farLayer, this.midLayer, this.nearLayer);

    // ---- Sky: huge vertical-gradient plane far behind everything ----
    const skyTex = makeVerticalGradientTexture(64, 256, [
      [0.0, "#4fb2ee"],
      [0.45, "#8ed3f7"],
      [0.75, "#c8ecfb"],
      [1.0, "#eaf7d8"],
    ]);
    this.disposables.push(skyTex);
    const skyMat = new THREE.MeshBasicMaterial({ map: skyTex, depthWrite: false });
    const skyGeo = new THREE.PlaneGeometry(520, 260);
    this.disposables.push(skyMat, skyGeo);
    const sky = new THREE.Mesh(skyGeo, skyMat);
    sky.position.set(0, 20, -130);
    sky.renderOrder = -10;
    this.farLayer.add(sky);

    // ---- Sun: warm disc + big soft glow, top-right like a kids' drawing ----
    const sunTex = makeGlowTexture(256, [
      [0.0, "rgba(255, 246, 200, 1)"],
      [0.18, "rgba(255, 232, 140, 0.95)"],
      [0.3, "rgba(255, 214, 100, 0.5)"],
      [0.6, "rgba(255, 200, 90, 0.14)"],
      [1.0, "rgba(255, 200, 90, 0)"],
    ]);
    this.disposables.push(sunTex);
    const sunMat = new THREE.SpriteMaterial({
      map: sunTex,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.disposables.push(sunMat);
    this.sunGlow = new THREE.Sprite(sunMat);
    this.sunGlow.position.set(38, 30, -110);
    this.sunGlow.scale.setScalar(60);
    this.farLayer.add(this.sunGlow);

    // ---- Rolling hills: three bumpy silhouettes at increasing depth ----
    const hillDefs: {
      colorTop: string;
      colorBottom: string;
      z: number;
      y: number;
      width: number;
      height: number;
      seed: number;
      layer: THREE.Group;
    }[] = [
      // far: pale sunlit green
      { colorTop: "#a9d975", colorBottom: "#8cc356", z: -100, y: -14, width: 420, height: 60, seed: 3, layer: this.farLayer },
      // mid: fresh leafy green
      { colorTop: "#7fbe48", colorBottom: "#63a232", z: -70, y: -16, width: 330, height: 55, seed: 7, layer: this.midLayer },
      // near: deeper meadow green
      { colorTop: "#5c9e2f", colorBottom: "#447c1f", z: -45, y: -18, width: 260, height: 52, seed: 11, layer: this.nearLayer },
    ];
    for (const def of hillDefs) {
      const tex = makeHillsTexture(1024, 256, def.colorTop, def.colorBottom, def.seed);
      this.disposables.push(tex);
      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
      });
      const geo = new THREE.PlaneGeometry(def.width, def.height);
      this.disposables.push(mat, geo);
      const hills = new THREE.Mesh(geo, mat);
      hills.position.set(0, def.y, def.z);
      def.layer.add(hills);
    }

    // ---- Fluffy cartoon clouds drifting slowly across the sky ----
    const cloudTex = makeCloudTexture(256);
    this.disposables.push(cloudTex);
    const cloudDefs: [number, number, number, number, number][] = [
      // x, y, z, scale, opacity
      [-55, 26, -95, 34, 0.92],
      [20, 34, -105, 42, 0.85],
      [58, 20, -90, 28, 0.9],
      [-20, 38, -110, 30, 0.75],
      [-80, 16, -85, 24, 0.8],
      [40, 42, -115, 36, 0.65],
    ];
    for (const [x, y, z, s, o] of cloudDefs) {
      const mat = new THREE.SpriteMaterial({
        map: cloudTex,
        transparent: true,
        opacity: o,
        depthWrite: false,
      });
      this.disposables.push(mat);
      const cloud = new THREE.Sprite(mat);
      cloud.position.set(x, y, z);
      cloud.scale.set(s, s * 0.55, 1);
      this.clouds.push(cloud);
      this.cloudSpeeds.push(0.25 + Math.random() * 0.35);
      this.cloudBaseY.push(y);
      this.midLayer.add(cloud);
    }

    // ---- Floating pollen / dandelion fluff (near layer, warm white) ----
    this.pollen = this.makePollen(cfg.background.dustCount);
    this.nearLayer.add(this.pollen);
  }

  private makePollen(count: number): THREE.Points {
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 40;
      positions[i * 3 + 1] = Math.random() * 14 - 2;
      positions[i * 3 + 2] = -4 - Math.random() * 26;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xfffbe8,
      size: 1.6,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
    });
    this.disposables.push(geo, mat);
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    return pts;
  }

  /**
   * @param elapsed  total seconds
   * @param parallaxX / parallaxY  smoothed -1..1 mouse offsets
   */
  update(elapsed: number, parallaxX: number, parallaxY: number): void {
    // Clouds drift right extremely slowly and wrap around; tiny bobbing.
    for (let i = 0; i < this.clouds.length; i++) {
      const c = this.clouds[i];
      c.position.x += this.cloudSpeeds[i] * 0.016;
      if (c.position.x > 110) c.position.x = -110;
      c.position.y = this.cloudBaseY[i] + Math.sin(elapsed * 0.12 + i * 1.7) * 0.6;
    }

    // Sun: barely-perceptible warm breathing.
    const sunMat = this.sunGlow.material as THREE.SpriteMaterial;
    sunMat.opacity = 0.88 + Math.sin(elapsed * 0.3) * 0.07;

    // Pollen: lazy sway, like seeds on a summer breeze.
    this.pollen.rotation.y = elapsed * 0.008;
    this.pollen.position.y = Math.sin(elapsed * 0.07) * 0.5;

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

// ---------------------------------------------------------------------
// Canvas texture helpers
// ---------------------------------------------------------------------

/** Radial-gradient canvas texture used for the sun glow. */
function makeGlowTexture(size: number, stops: [number, string][]): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [pos, color] of stops) grad.addColorStop(pos, color);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.generateMipmaps = true;
  return tex;
}

/** Vertical sky gradient. */
function makeVerticalGradientTexture(
  w: number,
  h: number,
  stops: [number, string][],
): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  for (const [pos, color] of stops) grad.addColorStop(pos, color);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  const tex = new THREE.CanvasTexture(canvas);
  tex.generateMipmaps = true;
  return tex;
}

/**
 * Bumpy cartoon hill silhouette: rounded bumps along the top edge,
 * filled with a soft vertical gradient, transparent above.
 */
function makeHillsTexture(
  w: number,
  h: number,
  colorTop: string,
  colorBottom: string,
  seed: number,
): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;

  // Deterministic pseudo-random bumps (stable across reloads per seed).
  const rand = (i: number) => {
    const x = Math.sin(seed * 127.1 + i * 311.7) * 43758.5453;
    return x - Math.floor(x);
  };

  const baseY = h * 0.45;
  ctx.beginPath();
  ctx.moveTo(0, h);
  ctx.lineTo(0, baseY);
  const bumps = 7;
  for (let i = 0; i < bumps; i++) {
    const x0 = (i / bumps) * w;
    const x1 = ((i + 1) / bumps) * w;
    const peak = baseY - (h * 0.12 + rand(i) * h * 0.22);
    ctx.quadraticCurveTo((x0 + x1) / 2, peak, x1, baseY - rand(i + 40) * h * 0.08);
  }
  ctx.lineTo(w, h);
  ctx.closePath();

  const grad = ctx.createLinearGradient(0, baseY - h * 0.3, 0, h);
  grad.addColorStop(0, colorTop);
  grad.addColorStop(1, colorBottom);
  ctx.fillStyle = grad;
  ctx.fill();

  const tex = new THREE.CanvasTexture(canvas);
  tex.generateMipmaps = true;
  return tex;
}

/** Fluffy cloud: a cluster of soft white blobs on a transparent canvas. */
function makeCloudTexture(size: number): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;

  const blobs: [number, number, number][] = [
    // x%, y%, r%
    [0.32, 0.58, 0.2],
    [0.5, 0.48, 0.26],
    [0.68, 0.58, 0.2],
    [0.42, 0.62, 0.18],
    [0.58, 0.64, 0.17],
  ];
  for (const [bx, by, br] of blobs) {
    const x = bx * size;
    const y = by * size;
    const r = br * size;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, "rgba(255, 255, 255, 0.95)");
    grad.addColorStop(0.7, "rgba(255, 255, 255, 0.85)");
    grad.addColorStop(1, "rgba(255, 255, 255, 0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.generateMipmaps = true;
  return tex;
}