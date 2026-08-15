import * as THREE from "three";

/**
 * One force-field segment. Coordinates mirror the physics collider:
 * `x/z` is the center, `baseY` its bottom (or plane height for a roof).
 *  - Vertical wall: `length` = horizontal extent, `height` = vertical
 *    extent, `alongX` = which axis the wall runs along.
 *  - Roof (`horizontal: true`): flat ceiling plane at y = baseY with
 *    `length` = X extent and `height` = Z extent.
 */
export interface ForceFieldSegment {
  x: number;
  baseY: number;
  z: number;
  length: number;
  height: number;
  alongX: boolean;
  horizontal?: boolean;
}

/** Tunables for the violet force-field look (no magic numbers below). */
const FIELD = {
  /** Deep violet body of the field. */
  baseColor: 0x7c3aed,
  /** Bright violet used by hot spots (grid lines, scan pulse, edges). */
  hotColor: 0xc084fc,
  /** Grid cell size in meters (world-space UVs). */
  cellSize: 2.2,
  /** Energy particles per square meter of wall (vertical walls only). */
  particleDensity: 0.16,
  /** Max particles per segment (safety cap for the huge walls). */
  maxParticlesPerSegment: 320,
  /** Violet light emitted by each wall segment. */
  lightColor: 0x9d5cff,
  lightIntensity: 1.6,
  /** Light range scales with segment length, clamped to this window. */
  lightMinDistance: 18,
  lightMaxDistance: 42,
  /** Segments longer than this get two lights instead of one. */
  twoLightsAbove: 40,

  // ---- Meteor impacts on the dome ----
  /** Seconds between meteor strikes (random in [min, max]). */
  meteorMinInterval: 4,
  meteorMaxInterval: 11,
  /** Simultaneous meteors (pooled — no runtime allocation). */
  meteorPool: 3,
  /** Meteor fall speed in world units/s (randomized ±30%). */
  meteorSpeed: 95,
  /** Spawn height above the impact point. */
  meteorSpawnHeight: 150,
  /** Trail points per meteor + spacing between them (meters). */
  meteorTrailPoints: 14,
  meteorTrailSpacing: 2.6,
  /** Sparks emitted per impact (drawn from a shared pool). */
  impactSparks: 42,
  sparkPool: 220,
  /** Spark lifetime in seconds (randomized ±40%). */
  sparkLife: 0.9,
  /** Expanding ripple rings available at once + their lifetime. */
  ripplePool: 3,
  rippleLife: 0.8,
  rippleMaxScale: 14,
  /** Impact flash light. */
  flashIntensity: 26,
  flashDistance: 36,
} as const;

// ----------------------------------------------------------------------
// Shaders
// ----------------------------------------------------------------------

const fieldVertexShader = /* glsl */ `
  varying vec2 vUvM;      // UVs in METERS (baked into the geometry)
  varying vec3 vWorldPos;
  varying vec3 vNormal;

  void main() {
    vUvM = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const fieldFragmentShader = /* glsl */ `
  uniform float uTime;
  uniform vec3 uColor;
  uniform vec3 uHotColor;
  uniform float uHeight;   // plane extent along V, in meters
  uniform float uLength;   // plane extent along U, in meters
  uniform float uCell;     // grid cell size in meters

  varying vec2 vUvM;
  varying vec3 vWorldPos;
  varying vec3 vNormal;

  void main() {
    // --- Energy grid: thin bright lines every uCell meters ---
    vec2 cell = abs(fract(vUvM / uCell) - 0.5);
    float gridDist = max(cell.x, cell.y);
    float grid = smoothstep(0.44, 0.5, gridDist);

    // --- Slow energy bands drifting across the field ---
    float band = 0.5 + 0.5 * sin(vUvM.y * 1.8 - uTime * 1.6);
    band = pow(band, 3.0);

    // --- Bright scan pulse sweeping along the field ---
    float scanPos = fract(uTime * 0.06) * (uLength + 20.0) - 10.0;
    float scan = exp(-abs(vUvM.x - scanPos) * 0.55);

    // --- Fresnel: stronger glow at grazing angles ---
    vec3 V = normalize(cameraPosition - vWorldPos);
    float fres = pow(1.0 - abs(dot(V, normalize(vNormal))), 2.0);

    // --- Edge glow along the V extremities (energy emitters feel) ---
    float distToEdge = min(vUvM.y, uHeight - vUvM.y);
    float edge = 1.0 - smoothstep(0.0, 0.9, distToEdge);

    // --- Subtle animated shimmer so the field never looks static ---
    float shimmer = 0.5 + 0.5 * sin(vUvM.x * 0.9 + vUvM.y * 1.3 + uTime * 2.4);

    float intensity =
      0.10 +                    // faint veil (still see-through)
      grid * 0.45 +
      band * 0.16 +
      scan * 0.85 +
      fres * 0.45 +
      edge * 0.85 +
      shimmer * 0.06;

    vec3 col = mix(uColor, uHotColor, clamp(grid * 0.6 + scan * 0.8 + edge * 0.5, 0.0, 1.0));

    // Additive blending: rgb IS the emitted light; alpha only feathers it.
    gl_FragColor = vec4(col * intensity, clamp(intensity, 0.0, 1.0));
  }
`;

const particleVertexShader = /* glsl */ `
  uniform float uTime;

  attribute float aSeed;    // 0..1 random per particle
  attribute float aHeight;  // wall height for this particle's segment

  varying float vFade;

  void main() {
    float speed = 0.5 + aSeed * 1.1;
    float y = mod(position.y + uTime * speed, aHeight);

    // Gentle horizontal wobble so particles feel like drifting energy.
    float wobble = sin(uTime * (0.8 + aSeed * 1.5) + aSeed * 40.0) * 0.3;
    vec3 p = vec3(position.x + wobble, y, position.z);

    // Fade in near the bottom, fade out near the top.
    vFade = smoothstep(0.0, 1.2, y) * (1.0 - smoothstep(aHeight - 2.0, aHeight, y));

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = (46.0 * (0.5 + aSeed * 0.9)) / max(1.0, -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const particleFragmentShader = /* glsl */ `
  uniform vec3 uColor;
  varying float vFade;

  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, d) * vFade;
    gl_FragColor = vec4(uColor * a, a);
  }
`;

/** Meteor streak: head is bright/white, tail fades to violet. */
const meteorVertexShader = /* glsl */ `
  uniform float uAlpha;
  attribute float aT;       // 0 = head … 1 = tail
  varying float vA;
  varying float vT;

  void main() {
    vT = aT;
    vA = (1.0 - aT) * uAlpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = mix(1.0, 0.3, aT) * (2600.0 / max(1.0, -mv.z));
    gl_Position = projectionMatrix * mv;
  }
`;

const meteorFragmentShader = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uHotColor;
  varying float vA;
  varying float vT;

  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, d) * vA;
    vec3 col = mix(vec3(1.0, 0.96, 1.0), mix(uHotColor, uColor, vT), vT);
    gl_FragColor = vec4(col * a, a);
  }
`;

/** Impact sparks: CPU-simulated positions, GPU size/fade from aLife. */
const sparkVertexShader = /* glsl */ `
  attribute float aLife;    // 0 dead … 1 fresh
  attribute float aSeed;
  varying float vLife;

  void main() {
    vLife = aLife;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aLife * (0.6 + aSeed * 0.9) * (900.0 / max(1.0, -mv.z));
    gl_Position = projectionMatrix * mv;
  }
`;

const sparkFragmentShader = /* glsl */ `
  uniform vec3 uColor;
  varying float vLife;

  void main() {
    if (vLife <= 0.001) discard;
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, d) * vLife;
    vec3 col = mix(uColor, vec3(1.0, 0.95, 1.0), vLife * 0.5);
    gl_FragColor = vec4(col * a, a);
  }
`;

// ----------------------------------------------------------------------
// Internal effect state
// ----------------------------------------------------------------------

interface MeteorState {
  points: THREE.Points;
  material: THREE.ShaderMaterial;
  positions: Float32Array;
  head: THREE.Vector3;
  vel: THREE.Vector3;
  impactY: number;
  active: boolean;
}

interface SparkState {
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
}

interface RippleState {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  t: number;
  active: boolean;
}

interface RoofArea {
  x: number;
  y: number;
  z: number;
  sx: number;
  sz: number;
}

/**
 * Violet force-field dome: see-through animated energy planes on the
 * perimeter AND a flat ceiling (grid + scan pulse + fresnel), rising
 * energy particles, violet point lights — plus decorative meteors that
 * occasionally slam into the dome, bursting into sparks, an expanding
 * ripple ring and a brief violet flash.
 *
 * Purely visual — the solid colliders are added separately by the map
 * (same boxes as before), so gameplay is untouched.
 *
 * Self-animating: field planes update their `uTime` in `onBeforeRender`,
 * and the meteor system is driven by a never-culled proxy object.
 */
export class ForceFieldWalls {
  readonly group = new THREE.Group();

  private readonly startTime = performance.now();

  // Meteor / impact effect state
  private readonly roofs: RoofArea[] = [];
  private readonly meteors: MeteorState[] = [];
  private sparkGeometry: THREE.BufferGeometry | null = null;
  private sparkPositions: Float32Array | null = null;
  private sparkLives: Float32Array | null = null;
  private readonly sparkStates: SparkState[] = [];
  private nextSparkIndex = 0;
  private readonly ripples: RippleState[] = [];
  private impactLight: THREE.PointLight | null = null;
  private meteorTimer = 2.5; // first strike shortly after spawn
  private lastEffectsTime = performance.now();

  constructor(segments: ForceFieldSegment[]) {
    for (const seg of segments) this.buildSegment(seg);
    if (this.roofs.length > 0) this.buildMeteorSystem();
  }

  private now(): number {
    return (performance.now() - this.startTime) / 1000;
  }

  // ------------------------------------------------------------------
  // Field planes
  // ------------------------------------------------------------------

  private buildSegment(seg: ForceFieldSegment): void {
    const isRoof = seg.horizontal === true;

    const segGroup = new THREE.Group();
    segGroup.position.set(seg.x, seg.baseY, seg.z);
    // Local +X runs along the wall; rotate 90° for walls running along Z.
    segGroup.rotation.y = seg.alongX || isRoof ? 0 : Math.PI / 2;
    this.group.add(segGroup);

    // ---- Field plane (world-meter UVs so the grid density is uniform) ----
    const geo = new THREE.PlaneGeometry(seg.length, seg.height, 1, 1);
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, uv.getX(i) * seg.length, uv.getY(i) * seg.height);
    }
    uv.needsUpdate = true;

    const fieldMat = new THREE.ShaderMaterial({
      vertexShader: fieldVertexShader,
      fragmentShader: fieldFragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new THREE.Color(FIELD.baseColor) },
        uHotColor: { value: new THREE.Color(FIELD.hotColor) },
        uHeight: { value: seg.height },
        uLength: { value: seg.length },
        uCell: { value: FIELD.cellSize },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });

    const plane = new THREE.Mesh(geo, fieldMat);
    if (isRoof) {
      plane.rotation.x = -Math.PI / 2; // lie flat, ceiling at y = baseY
      this.roofs.push({
        x: seg.x,
        y: seg.baseY,
        z: seg.z,
        sx: seg.length,
        sz: seg.height,
      });
    } else {
      plane.position.y = seg.height / 2;
    }
    plane.castShadow = false;
    plane.receiveShadow = false;

    // ---- Energy particles rising along the wall (vertical walls only) ----
    let pMat: THREE.ShaderMaterial | null = null;
    if (!isRoof) {
      const area = seg.length * seg.height;
      const count = Math.min(
        FIELD.maxParticlesPerSegment,
        Math.max(24, Math.round(area * FIELD.particleDensity)),
      );
      const positions = new Float32Array(count * 3);
      const seeds = new Float32Array(count);
      const heights = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        positions[i * 3 + 0] = (Math.random() - 0.5) * seg.length;
        positions[i * 3 + 1] = Math.random() * seg.height;
        positions[i * 3 + 2] = (Math.random() - 0.5) * 0.6; // slight depth jitter
        seeds[i] = Math.random();
        heights[i] = seg.height;
      }
      const pGeo = new THREE.BufferGeometry();
      pGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      pGeo.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
      pGeo.setAttribute("aHeight", new THREE.BufferAttribute(heights, 1));
      // Static bounds (animation is GPU-side) — avoids per-frame recompute.
      pGeo.boundingSphere = new THREE.Sphere(
        new THREE.Vector3(0, seg.height / 2, 0),
        Math.hypot(seg.length / 2, seg.height / 2) + 1,
      );

      pMat = new THREE.ShaderMaterial({
        vertexShader: particleVertexShader,
        fragmentShader: particleFragmentShader,
        uniforms: {
          uTime: { value: 0 },
          uColor: { value: new THREE.Color(FIELD.hotColor) },
        },
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      });

      segGroup.add(new THREE.Points(pGeo, pMat));
    }

    // Drive the materials from the plane's render callback (called every
    // frame the plane is visible — exactly when the animation matters).
    plane.onBeforeRender = () => {
      const t = this.now();
      fieldMat.uniforms.uTime.value = t;
      if (pMat) pMat.uniforms.uTime.value = t;
    };
    segGroup.add(plane);

    // ---- Violet light emitted by the field ----
    const distance = THREE.MathUtils.clamp(
      seg.length * 0.55,
      FIELD.lightMinDistance,
      FIELD.lightMaxDistance,
    );
    const lightY = isRoof ? -1.5 : seg.height * 0.5;
    const offsets =
      seg.length > FIELD.twoLightsAbove
        ? [-seg.length / 4, seg.length / 4]
        : [0];
    for (const off of offsets) {
      const l = new THREE.PointLight(FIELD.lightColor, FIELD.lightIntensity, distance, 1.8);
      l.position.set(off, lightY, 0);
      segGroup.add(l);
    }
  }

  // ------------------------------------------------------------------
  // Meteor impacts (decorative)
  // ------------------------------------------------------------------

  private buildMeteorSystem(): void {
    // ---- Meteor streak pool ----
    for (let m = 0; m < FIELD.meteorPool; m++) {
      const n = FIELD.meteorTrailPoints;
      const positions = new Float32Array(n * 3);
      const ts = new Float32Array(n);
      for (let i = 0; i < n; i++) ts[i] = i / (n - 1);

      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geo.setAttribute("aT", new THREE.BufferAttribute(ts, 1));

      const mat = new THREE.ShaderMaterial({
        vertexShader: meteorVertexShader,
        fragmentShader: meteorFragmentShader,
        uniforms: {
          uAlpha: { value: 0 },
          uColor: { value: new THREE.Color(FIELD.baseColor) },
          uHotColor: { value: new THREE.Color(FIELD.hotColor) },
        },
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      });

      const points = new THREE.Points(geo, mat);
      points.frustumCulled = false; // tiny cost, always correct
      points.visible = false;
      this.group.add(points);

      this.meteors.push({
        points,
        material: mat,
        positions,
        head: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        impactY: 0,
        active: false,
      });
    }

    // ---- Shared spark pool ----
    const sparkCount = FIELD.sparkPool;
    this.sparkPositions = new Float32Array(sparkCount * 3);
    this.sparkLives = new Float32Array(sparkCount);
    const sparkSeeds = new Float32Array(sparkCount);
    for (let i = 0; i < sparkCount; i++) {
      sparkSeeds[i] = Math.random();
      this.sparkStates.push({ vel: new THREE.Vector3(), life: 0, maxLife: 1 });
    }
    this.sparkGeometry = new THREE.BufferGeometry();
    this.sparkGeometry.setAttribute(
      "position",
      new THREE.BufferAttribute(this.sparkPositions, 3),
    );
    this.sparkGeometry.setAttribute("aLife", new THREE.BufferAttribute(this.sparkLives, 1));
    this.sparkGeometry.setAttribute("aSeed", new THREE.BufferAttribute(sparkSeeds, 1));

    const sparkMat = new THREE.ShaderMaterial({
      vertexShader: sparkVertexShader,
      fragmentShader: sparkFragmentShader,
      uniforms: { uColor: { value: new THREE.Color(FIELD.hotColor) } },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });

    const sparks = new THREE.Points(this.sparkGeometry, sparkMat);
    sparks.frustumCulled = false;
    // The never-culled sparks object drives the whole meteor simulation.
    sparks.onBeforeRender = () => this.updateEffects();
    this.group.add(sparks);

    // ---- Ripple ring pool (expanding circles on the dome surface) ----
    const ringGeo = new THREE.RingGeometry(0.82, 1, 40);
    for (let i = 0; i < FIELD.ripplePool; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: FIELD.hotColor,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      });
      const mesh = new THREE.Mesh(ringGeo, mat);
      mesh.rotation.x = -Math.PI / 2; // lies on the ceiling plane
      mesh.visible = false;
      this.group.add(mesh);
      this.ripples.push({ mesh, material: mat, t: 0, active: false });
    }

    // ---- Reusable impact flash light ----
    this.impactLight = new THREE.PointLight(
      FIELD.hotColor,
      0,
      FIELD.flashDistance,
      2,
    );
    this.group.add(this.impactLight);
  }

  /** Per-frame effect simulation (driven from onBeforeRender). */
  private updateEffects(): void {
    const nowMs = performance.now();
    const dt = Math.min((nowMs - this.lastEffectsTime) / 1000, 0.05);
    this.lastEffectsTime = nowMs;
    if (dt <= 0) return;

    // ---- Spawn timer ----
    this.meteorTimer -= dt;
    if (this.meteorTimer <= 0) {
      this.meteorTimer =
        FIELD.meteorMinInterval +
        Math.random() * (FIELD.meteorMaxInterval - FIELD.meteorMinInterval);
      this.spawnMeteor();
    }

    // ---- Meteors ----
    for (const m of this.meteors) {
      if (!m.active) continue;
      m.head.addScaledVector(m.vel, dt);
      if (m.head.y <= m.impactY) {
        m.head.y = m.impactY;
        this.impact(m.head);
        m.active = false;
        m.points.visible = false;
        continue;
      }
      this.writeMeteorTrail(m);
    }

    // ---- Sparks ----
    if (this.sparkPositions && this.sparkLives && this.sparkGeometry) {
      let any = false;
      for (let i = 0; i < this.sparkStates.length; i++) {
        const s = this.sparkStates[i];
        if (s.life <= 0) continue;
        any = true;
        s.life -= dt;
        const k = i * 3;
        this.sparkPositions[k] += s.vel.x * dt;
        this.sparkPositions[k + 1] += s.vel.y * dt;
        this.sparkPositions[k + 2] += s.vel.z * dt;
        // Drag + slight gravity: energy sparks slow down and sag.
        const drag = Math.max(0, 1 - 2.2 * dt);
        s.vel.multiplyScalar(drag);
        s.vel.y -= 6 * dt;
        this.sparkLives[i] = Math.max(0, s.life / s.maxLife);
      }
      if (any) {
        (this.sparkGeometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
        (this.sparkGeometry.attributes.aLife as THREE.BufferAttribute).needsUpdate = true;
      }
    }

    // ---- Ripples ----
    for (const r of this.ripples) {
      if (!r.active) continue;
      r.t += dt / FIELD.rippleLife;
      if (r.t >= 1) {
        r.active = false;
        r.mesh.visible = false;
        continue;
      }
      const s = 1 + r.t * FIELD.rippleMaxScale;
      r.mesh.scale.set(s, s, s);
      r.material.opacity = (1 - r.t) * 0.9;
    }

    // ---- Flash light decay ----
    if (this.impactLight && this.impactLight.intensity > 0.01) {
      this.impactLight.intensity *= Math.max(0, 1 - 7 * dt);
    }
  }

  private spawnMeteor(): void {
    const m = this.meteors.find((mm) => !mm.active);
    if (!m || this.roofs.length === 0) return;

    // Pick a roof weighted by area, then a random point inside (margin 4).
    const total = this.roofs.reduce((a, r) => a + r.sx * r.sz, 0);
    let pick = Math.random() * total;
    let roof = this.roofs[0];
    for (const r of this.roofs) {
      pick -= r.sx * r.sz;
      if (pick <= 0) {
        roof = r;
        break;
      }
    }
    const tx = roof.x + (Math.random() - 0.5) * (roof.sx - 8);
    const tz = roof.z + (Math.random() - 0.5) * (roof.sz - 8);
    const target = new THREE.Vector3(tx, roof.y, tz);

    // Spawn high above with a lateral offset → oblique, natural-looking dive.
    const ang = Math.random() * Math.PI * 2;
    const lateral = 40 + Math.random() * 70;
    const start = new THREE.Vector3(
      tx + Math.cos(ang) * lateral,
      roof.y + FIELD.meteorSpawnHeight,
      tz + Math.sin(ang) * lateral,
    );

    const speed = FIELD.meteorSpeed * (0.7 + Math.random() * 0.6);
    m.vel.copy(target).sub(start).normalize().multiplyScalar(speed);
    m.head.copy(start);
    m.impactY = roof.y;
    m.active = true;
    m.points.visible = true;
    m.material.uniforms.uAlpha.value = 0.9;
    this.writeMeteorTrail(m);
  }

  private static readonly tmpDir = new THREE.Vector3();

  private writeMeteorTrail(m: MeteorState): void {
    const dir = ForceFieldWalls.tmpDir.copy(m.vel).normalize();
    const n = FIELD.meteorTrailPoints;
    for (let i = 0; i < n; i++) {
      const d = i * FIELD.meteorTrailSpacing;
      m.positions[i * 3] = m.head.x - dir.x * d;
      m.positions[i * 3 + 1] = m.head.y - dir.y * d;
      m.positions[i * 3 + 2] = m.head.z - dir.z * d;
    }
    (m.points.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }

  private impact(at: THREE.Vector3): void {
    // ---- Sparks: horizontal splash hugging the field + a few falling ----
    if (this.sparkPositions && this.sparkLives) {
      for (let n = 0; n < FIELD.impactSparks; n++) {
        const i = this.nextSparkIndex;
        this.nextSparkIndex = (this.nextSparkIndex + 1) % this.sparkStates.length;
        const s = this.sparkStates[i];
        const ang = Math.random() * Math.PI * 2;
        const speed = 5 + Math.random() * 14;
        s.vel.set(
          Math.cos(ang) * speed,
          -(0.5 + Math.random() * 3.5),
          Math.sin(ang) * speed,
        );
        s.maxLife = FIELD.sparkLife * (0.6 + Math.random() * 0.8);
        s.life = s.maxLife;
        const k = i * 3;
        this.sparkPositions[k] = at.x;
        this.sparkPositions[k + 1] = at.y - 0.2;
        this.sparkPositions[k + 2] = at.z;
        this.sparkLives[i] = 1;
      }
    }

    // ---- Expanding ripple ring on the dome surface ----
    const ripple = this.ripples.find((r) => !r.active);
    if (ripple) {
      ripple.active = true;
      ripple.t = 0;
      ripple.mesh.position.set(at.x, at.y - 0.12, at.z);
      ripple.mesh.scale.set(1, 1, 1);
      ripple.material.opacity = 0.9;
      ripple.mesh.visible = true;
    }

    // ---- Brief violet flash lighting the arena below ----
    if (this.impactLight) {
      this.impactLight.position.set(at.x, at.y - 1.5, at.z);
      this.impactLight.intensity = FIELD.flashIntensity;
    }
  }
}