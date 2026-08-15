import * as THREE from "three";
import { SpaceConfig as cfg } from "./SpaceConfig";

/**
 * In-game deep-space backdrop: "futuristic purple deep space".
 *
 * Layered for depth (far → near):
 *   gradient dome → far stars (+ clusters) → violet nebula sprites
 *   → distant moon (+ violet rim halo) → tiny silhouette planet
 *   → occasional meteor streaks
 *
 * Design constraints (fast browser FPS):
 *  - ONE Points draw call for every star (twinkle done in a tiny shader).
 *  - Nebula / halos are a handful of additive sprites (canvas gradients).
 *  - Meteors are a fixed pool of 3 textured quads — zero runtime allocation.
 *  - The whole group follows the camera each frame so the sky reads as
 *    infinitely far and can never feel "glued" to the map.
 *  - No fog on any sky material (the haze only melts real map geometry).
 *
 * Purely visual: nothing here is raycastable, collidable or gameplay-affecting.
 */
export class SpaceSky {
  readonly group = new THREE.Group();

  /** Slow-rotating layer (stars only — the moon stays fixed so the
   *  DirectionalLight direction always matches it). */
  private readonly rotor = new THREE.Group();

  private readonly starUniforms = { uTime: { value: 0 } };
  private readonly nebulaSprites: THREE.Sprite[] = [];

  // ---- Meteor pool ----
  private readonly meteors: Meteor[] = [];
  private nextMeteorIn: number;

  // Scratch (no per-frame allocations)
  private readonly tmpX = new THREE.Vector3();
  private readonly tmpY = new THREE.Vector3();
  private readonly tmpZ = new THREE.Vector3();
  private readonly tmpM = new THREE.Matrix4();

  private readonly disposables: { dispose(): void }[] = [];

  constructor() {
    this.group.add(this.rotor);

    // Sky renders behind everything and never writes depth.
    this.buildDome();
    this.rotor.add(this.buildStars());
    this.buildNebula();
    this.buildMoon();
    if (cfg.secondPlanetEnabled) this.buildSecondPlanet();

    for (let i = 0; i < cfg.meteorPoolSize; i++) {
      const m = new Meteor(this.disposables);
      this.meteors.push(m);
      this.group.add(m.mesh);
    }
    this.nextMeteorIn = randRange(cfg.meteorMinInterval, cfg.meteorMaxInterval);
  }

  // ------------------------------------------------------------------
  // Layers
  // ------------------------------------------------------------------

  /** Inverted sphere with a vertical gradient: horizon violet → black zenith. */
  private buildDome(): void {
    const geo = new THREE.SphereGeometry(cfg.skyRadius, 32, 20);
    const pos = geo.getAttribute("position");
    const colors = new Float32Array(pos.count * 3);
    const horizon = new THREE.Color(cfg.horizonColor);
    const zenith = new THREE.Color(cfg.zenithColor);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      // 0 at/below horizon → 1 at zenith (fast falloff keeps blacks deep).
      const t = Math.pow(Math.max(pos.getY(i) / cfg.skyRadius, 0), 0.55);
      c.lerpColors(horizon, zenith, t);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.BackSide,
      fog: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.disposables.push(geo, mat);
    const dome = new THREE.Mesh(geo, mat);
    dome.renderOrder = -100; // first of the opaque pass
    dome.frustumCulled = false;
    this.group.add(dome);
  }

  /**
   * All stars in one Points draw call. A tiny shader gives each star its
   * own pseudo-random twinkle phase/speed so they never blink in sync.
   */
  private buildStars(): THREE.Points {
    const clustered = cfg.starClusterCount * cfg.starsPerCluster;
    const count = cfg.starCount + clustered;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const phases = new Float32Array(count);
    const speeds = new Float32Array(count);

    const white = new THREE.Color(cfg.starColor);
    const violet = new THREE.Color(0xc4a8ff);
    const blue = new THREE.Color(0x9ec8ff);
    const dir = new THREE.Vector3();
    const r = cfg.skyRadius * 0.965;

    const writeStar = (i: number, d: THREE.Vector3) => {
      positions[i * 3] = d.x * r;
      positions[i * 3 + 1] = d.y * r;
      positions[i * 3 + 2] = d.z * r;
      const roll = Math.random();
      const col =
        roll < cfg.starVioletFraction
          ? violet
          : roll < cfg.starVioletFraction + cfg.starBlueFraction
            ? blue
            : white;
      colors[i * 3] = col.r;
      colors[i * 3 + 1] = col.g;
      colors[i * 3 + 2] = col.b;
      // Mostly fine stars, a few bright ones.
      sizes[i] = Math.random() < 0.08 ? 2.4 + Math.random() * 1.4 : 1.0 + Math.random() * 1.2;
      phases[i] = Math.random() * Math.PI * 2;
      speeds[i] = 0.4 + Math.random() * 1.6; // desynchronized twinkle
    };

    // Scattered stars: full sky shell, slightly biased above the horizon.
    for (let i = 0; i < cfg.starCount; i++) {
      randomSkyDirection(dir, -0.08);
      writeStar(i, dir);
    }

    // A few dense stellar clusters for composition.
    const center = new THREE.Vector3();
    for (let cIdx = 0; cIdx < cfg.starClusterCount; cIdx++) {
      randomSkyDirection(center, 0.25);
      for (let j = 0; j < cfg.starsPerCluster; j++) {
        const i = cfg.starCount + cIdx * cfg.starsPerCluster + j;
        dir
          .set(gauss() * 0.09, gauss() * 0.06, gauss() * 0.09)
          .add(center)
          .normalize();
        writeStar(i, dir);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("aColor", new THREE.BufferAttribute(colors, 3));
    geo.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
    geo.setAttribute("aPhase", new THREE.BufferAttribute(phases, 1));
    geo.setAttribute("aSpeed", new THREE.BufferAttribute(speeds, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: this.starUniforms.uTime,
        uTwinkle: { value: cfg.starTwinkleIntensity },
        uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
      },
      vertexShader: /* glsl */ `
        attribute vec3 aColor;
        attribute float aSize;
        attribute float aPhase;
        attribute float aSpeed;
        uniform float uTime;
        uniform float uTwinkle;
        uniform float uPixelRatio;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vColor = aColor;
          // Per-star slow twinkle, never synchronized.
          float tw = 0.5 + 0.5 * sin(uTime * aSpeed + aPhase);
          vAlpha = 1.0 - uTwinkle * tw;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * uPixelRatio;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          // Soft round point (no texture fetch).
          float d = length(gl_PointCoord - vec2(0.5));
          float a = smoothstep(0.5, 0.12, d) * vAlpha;
          if (a < 0.01) discard;
          gl_FragColor = vec4(vColor, a);
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    this.disposables.push(geo, mat);
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false; // full-sky shell
    return pts;
  }

  /** A handful of soft additive violet clouds — most of the sky stays black. */
  private buildNebula(): void {
    const tex = makeGlowTexture(256, [
      [0.0, "rgba(168, 85, 247, 0.50)"],
      [0.35, "rgba(109, 40, 217, 0.26)"],
      [0.7, "rgba(49, 20, 100, 0.09)"],
      [1.0, "rgba(12, 6, 28, 0)"],
    ]);
    this.disposables.push(tex);

    // Directions concentrated in two sky regions (kept away from the moon).
    const placements: { dir: THREE.Vector3; scale: number; opacity: number }[] = [
      { dir: new THREE.Vector3(-0.6, 0.32, -0.5), scale: 240, opacity: 1.0 },
      { dir: new THREE.Vector3(-0.75, 0.5, -0.2), scale: 190, opacity: 0.7 },
      { dir: new THREE.Vector3(0.55, 0.25, 0.72), scale: 210, opacity: 0.8 },
      { dir: new THREE.Vector3(0.75, 0.5, 0.5), scale: 150, opacity: 0.55 },
    ];
    const r = cfg.skyRadius * 0.9;
    for (let i = 0; i < Math.min(cfg.nebulaSprites, placements.length); i++) {
      const p = placements[i];
      const mat = new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        opacity: p.opacity * cfg.nebulaIntensity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      });
      this.disposables.push(mat);
      const sprite = new THREE.Sprite(mat);
      sprite.position.copy(p.dir).normalize().multiplyScalar(r);
      sprite.scale.setScalar(p.scale);
      this.nebulaSprites.push(sprite);
      this.rotor.add(sprite);
    }
  }

  /**
   * Distant rocky moon. Lighting is BAKED into a canvas texture (lit from
   * the upper-left, violet-tinted shadow side) so it needs no real light,
   * always reads as "very far away" and costs one small textured sphere.
   */
  private buildMoon(): void {
    const tex = makeMoonTexture(256);
    this.disposables.push(tex);

    const geo = new THREE.SphereGeometry(1, 32, 24);
    const mat = new THREE.MeshBasicMaterial({ map: tex, fog: false });
    this.disposables.push(geo, mat);
    const moon = new THREE.Mesh(geo, mat);
    moon.scale.setScalar(cfg.moonScale);
    moon.position
      .set(cfg.moonPosition.x, cfg.moonPosition.y, cfg.moonPosition.z)
      .normalize()
      .multiplyScalar(cfg.skyRadius * 0.92);
    // Face the baked-light texture toward the play area.
    moon.lookAt(0, 0, 0);
    this.group.add(moon);

    // Very light violet rim halo behind the moon.
    if (cfg.moonHaloOpacity > 0) {
      const haloTex = makeGlowTexture(128, [
        [0.0, "rgba(196, 168, 255, 0.0)"],
        [0.56, "rgba(196, 168, 255, 0.0)"],
        [0.68, "rgba(168, 85, 247, 0.30)"],
        [0.82, "rgba(124, 58, 237, 0.10)"],
        [1.0, "rgba(20, 8, 40, 0)"],
      ]);
      this.disposables.push(haloTex);
      const haloMat = new THREE.SpriteMaterial({
        map: haloTex,
        transparent: true,
        opacity: cfg.moonHaloOpacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      });
      this.disposables.push(haloMat);
      const halo = new THREE.Sprite(haloMat);
      halo.position.copy(moon.position);
      halo.scale.setScalar(cfg.moonScale * 2.9);
      this.group.add(halo);
    }
  }

  /** Tiny, almost-silhouette second planet on the opposite side — sober. */
  private buildSecondPlanet(): void {
    const geo = new THREE.SphereGeometry(1, 20, 14);
    const mat = new THREE.MeshBasicMaterial({ color: 0x120c22, fog: false });
    this.disposables.push(geo, mat);
    const planet = new THREE.Mesh(geo, mat);
    planet.scale.setScalar(cfg.secondPlanetScale);
    planet.position
      .set(cfg.secondPlanetPosition.x, cfg.secondPlanetPosition.y, cfg.secondPlanetPosition.z)
      .normalize()
      .multiplyScalar(cfg.skyRadius * 0.9);
    this.group.add(planet);

    // Whisper-thin edge glow so the silhouette reads against the black.
    const rimTex = makeGlowTexture(64, [
      [0.0, "rgba(157, 92, 255, 0.0)"],
      [0.6, "rgba(157, 92, 255, 0.0)"],
      [0.74, "rgba(157, 92, 255, 0.16)"],
      [1.0, "rgba(20, 8, 40, 0)"],
    ]);
    this.disposables.push(rimTex);
    const rimMat = new THREE.SpriteMaterial({
      map: rimTex,
      transparent: true,
      opacity: 0.6,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    this.disposables.push(rimMat);
    const rim = new THREE.Sprite(rimMat);
    rim.position.copy(planet.position);
    rim.scale.setScalar(cfg.secondPlanetScale * 2.5);
    this.group.add(rim);
  }

  // ------------------------------------------------------------------
  // Per-frame update
  // ------------------------------------------------------------------

  /**
   * @param dt       frame delta (seconds) — meteors keep moving only in-game
   * @param elapsed  total seconds (twinkle / slow drift)
   * @param camera   the sky follows the camera so it reads as infinitely far
   */
  update(dt: number, elapsed: number, camera: THREE.Camera): void {
    // Sky glued to the camera position (never to the map).
    this.group.position.copy(camera.position);

    // Almost imperceptible star drift — the sky feels alive, not spinning.
    this.rotor.rotation.y = elapsed * cfg.skyRotationSpeed;
    this.starUniforms.uTime.value = elapsed;

    // Nebula: barely-perceptible breathing via sprite rotation.
    for (let i = 0; i < this.nebulaSprites.length; i++) {
      const mat = this.nebulaSprites[i].material as THREE.SpriteMaterial;
      mat.rotation = elapsed * 0.0015 * (i % 2 === 0 ? 1 : -1);
    }

    // ---- Meteors ----
    this.nextMeteorIn -= dt;
    if (this.nextMeteorIn <= 0) {
      this.nextMeteorIn = randRange(cfg.meteorMinInterval, cfg.meteorMaxInterval);
      for (const m of this.meteors) {
        if (!m.alive) {
          m.spawn();
          break; // one meteor per trigger — rare, decorative
        }
      }
    }
    for (const m of this.meteors) {
      if (!m.alive) continue;
      m.update(dt);
      // Billboard the streak: X axis = travel dir, normal faces the camera.
      this.tmpX.copy(m.dir);
      this.tmpZ.copy(camera.position).sub(this.group.position).sub(m.mesh.position).normalize();
      this.tmpY.crossVectors(this.tmpZ, this.tmpX).normalize();
      this.tmpZ.crossVectors(this.tmpX, this.tmpY);
      this.tmpM.makeBasis(this.tmpX, this.tmpY, this.tmpZ);
      m.mesh.quaternion.setFromRotationMatrix(this.tmpM);
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.group.removeFromParent();
  }
}

// ---------------------------------------------------------------------
// Meteor: one pooled additive quad (bright head → violet tail gradient)
// ---------------------------------------------------------------------

/** Shared trail texture: white-hot core → violet → transparent tail. */
let meteorTexture: THREE.CanvasTexture | null = null;
function getMeteorTexture(): THREE.CanvasTexture {
  if (meteorTexture) return meteorTexture;
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 16;
  const ctx = canvas.getContext("2d")!;
  // Along the streak: head (right) bright white → violet → nothing (left).
  const grad = ctx.createLinearGradient(0, 0, 128, 0);
  grad.addColorStop(0.0, "rgba(124, 58, 237, 0)");
  grad.addColorStop(0.55, "rgba(168, 85, 247, 0.35)");
  grad.addColorStop(0.85, "rgba(216, 180, 254, 0.8)");
  grad.addColorStop(1.0, "rgba(255, 255, 255, 1)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 16);
  // Soften vertical edges (fake glow falloff).
  const fade = ctx.createLinearGradient(0, 0, 0, 16);
  fade.addColorStop(0, "rgba(0,0,0,1)");
  fade.addColorStop(0.5, "rgba(0,0,0,0)");
  fade.addColorStop(1, "rgba(0,0,0,1)");
  ctx.globalCompositeOperation = "destination-out";
  ctx.fillStyle = fade;
  ctx.fillRect(0, 0, 128, 16);
  meteorTexture = new THREE.CanvasTexture(canvas);
  return meteorTexture;
}

class Meteor {
  readonly mesh: THREE.Mesh;
  readonly dir = new THREE.Vector3();
  alive = false;

  private readonly mat: THREE.MeshBasicMaterial;
  private life = 0;
  private maxLife = 1;
  private speed = 1;
  private brightness = 1;
  private readonly tangent = new THREE.Vector3();
  private static readonly UP = new THREE.Vector3(0, 1, 0);

  constructor(disposables: { dispose(): void }[]) {
    const geo = new THREE.PlaneGeometry(1, 1);
    this.mat = new THREE.MeshBasicMaterial({
      map: getMeteorTexture(),
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    disposables.push(geo, this.mat);
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.visible = false;
    this.mesh.frustumCulled = false; // tiny pool — skip culling math
  }

  /** Random start point / direction / speed / length / brightness. */
  spawn(): void {
    // Start somewhere in the upper sky, never straight overhead-center.
    const pos = this.mesh.position;
    randomSkyDirection(pos, 0.25);
    pos.y = Math.min(pos.y, 0.8); // keep off the exact zenith
    pos.normalize().multiplyScalar(cfg.skyRadius * 0.82);

    // Travel roughly tangent to the sky shell: horizontal sweep + slight dip.
    this.tangent.crossVectors(Meteor.UP, pos).normalize();
    if (Math.random() < 0.5) this.tangent.negate();
    this.dir
      .copy(this.tangent)
      .addScaledVector(Meteor.UP, -(0.15 + Math.random() * 0.35))
      .normalize();

    this.speed = cfg.meteorSpeed * (0.6 + Math.random() * 0.8);
    this.maxLife = cfg.meteorLifetime * (0.7 + Math.random() * 0.6);
    this.life = this.maxLife;
    this.brightness = 0.55 + Math.random() * 0.45;

    const len = cfg.meteorLength * (0.6 + Math.random() * 0.9);
    this.mesh.scale.set(len, len * 0.05 + 0.6, 1);
    this.mesh.visible = true;
    this.alive = true;
  }

  update(dt: number): void {
    this.life -= dt;
    if (this.life <= 0) {
      this.alive = false;
      this.mesh.visible = false;
      this.mat.opacity = 0;
      return;
    }
    this.mesh.position.addScaledVector(this.dir, this.speed * dt);
    // Quick fade-in, smooth fade-out.
    const t = 1 - this.life / this.maxLife;
    const fadeIn = Math.min(t / 0.12, 1);
    const fadeOut = Math.min((1 - t) / 0.45, 1);
    this.mat.opacity = fadeIn * fadeOut * this.brightness;
  }
}

// ---------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------

function randRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** Cheap gaussian-ish sample (sum of two uniforms, centered). */
function gauss(): number {
  return Math.random() + Math.random() - 1;
}

/** Random unit direction on the sky, with y >= minY (biased above horizon). */
function randomSkyDirection(out: THREE.Vector3, minY: number): THREE.Vector3 {
  const y = minY + Math.random() * (1 - minY);
  const theta = Math.random() * Math.PI * 2;
  const s = Math.sqrt(Math.max(1 - y * y, 0));
  return out.set(s * Math.cos(theta), y, s * Math.sin(theta));
}

/** Radial-gradient canvas texture used for nebulas / halos. */
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

/**
 * Rocky moon texture with BAKED lighting: lit from the upper-left,
 * lavender-grey surface, darker craters, violet-tinted shadow side.
 */
function makeMoonTexture(size: number): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;

  // Base surface: pale lavender-grey.
  ctx.fillStyle = "#b6aec6";
  ctx.fillRect(0, 0, size, size);

  // Craters: darker discs with a faint lighter rim (deterministic-ish noise).
  for (let i = 0; i < 46; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 2 + Math.random() * (size * 0.05);
    ctx.fillStyle = `rgba(90, 80, 118, ${0.12 + Math.random() * 0.22})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(226, 220, 240, 0.10)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Large-scale mottling (maria).
  for (let i = 0; i < 10; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = size * (0.08 + Math.random() * 0.14);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, "rgba(96, 86, 128, 0.16)");
    g.addColorStop(1, "rgba(96, 86, 128, 0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }

  // Baked lighting: bright upper-left → violet-dark lower-right terminator.
  const lit = ctx.createRadialGradient(
    size * 0.32,
    size * 0.3,
    size * 0.08,
    size * 0.45,
    size * 0.45,
    size * 0.85,
  );
  lit.addColorStop(0, "rgba(255, 252, 255, 0.32)");
  lit.addColorStop(0.45, "rgba(255, 252, 255, 0)");
  lit.addColorStop(0.75, "rgba(24, 14, 48, 0.45)");
  lit.addColorStop(1, "rgba(12, 6, 30, 0.78)");
  ctx.fillStyle = lit;
  ctx.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}