import * as THREE from "three";
import { ObliterreurConfig as oc } from "./ObliterreurConfig";

/**
 * The two mini black-hole anchor markers of the OBLITERREUR.
 *
 * Each marker is a surface-aligned group containing:
 *  - a swirling black-hole disc (custom shader, violet accretion rim);
 *  - a through-wall additive glow disc (depthTest off, high renderOrder)
 *    so anchors stay elegantly visible through geometry;
 *  - a small cloud of particles spiraling into the hole;
 *  - a discreet "I" / "II" label sprite.
 *
 * All markers share the same uTime/uIntensity uniforms so the beam can
 * boost their glow/spin while it is active.
 */

const DISC_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/** Swirling black-hole disc. uThroughWall = 1 → additive silhouette variant. */
const DISC_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uIntensity;
  uniform float uThroughWall;
  varying vec2 vUv;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  void main() {
    vec2 c = vUv - 0.5;
    float r = length(c) * 2.0; // 0 center → 1 rim
    if (r > 1.0) discard;
    float ang = atan(c.y, c.x);

    // Swirl: angle twisted by radius + time, plus a touch of noise.
    float swirl = ang + (1.0 - r) * 6.0 - uTime * (2.2 + uIntensity * 2.5);
    float bands = 0.5 + 0.5 * sin(swirl * 3.0 + r * 9.0);
    bands *= 0.6 + 0.4 * hash(vec2(floor(swirl * 2.0), floor(r * 8.0)));

    // Near-black core, violet swirl, bright accretion edge.
    vec3 deepViolet = vec3(0.165, 0.032, 0.271);  // #2a0845
    vec3 violet     = vec3(0.486, 0.227, 0.929);  // #7c3aed
    vec3 hotViolet  = vec3(0.659, 0.333, 0.969);  // #a855f7

    float core = smoothstep(0.5, 0.15, r); // 1 at center
    float rim  = smoothstep(0.72, 0.97, r) * (1.0 - smoothstep(0.97, 1.0, r));

    vec3 col = mix(deepViolet * bands * 0.5, vec3(0.0), core);
    col += violet * bands * (1.0 - core) * (0.35 + uIntensity * 0.6);
    col += hotViolet * rim * (0.9 + uIntensity * 1.4);

    float alpha = 1.0 - smoothstep(0.93, 1.0, r);

    if (uThroughWall > 0.5) {
      // Additive silhouette: keep only the rim + faint swirl.
      col = violet * (rim * 1.2 + bands * (1.0 - core) * 0.25) * (0.8 + uIntensity);
      alpha *= 0.35;
    }

    gl_FragColor = vec4(col, alpha);
  }
`;

/** Orbiting suction particles spiraling into the hole. */
const POINTS_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uIntensity;
  attribute float aSeed;
  varying float vFade;
  void main() {
    float speed = 1.4 + aSeed * 1.2 + uIntensity * 2.0;
    float t = fract(uTime * 0.35 * speed + aSeed);      // 0 → 1 lifetime
    float radius = mix(1.15, 0.08, t);                   // spiral inward
    float ang = aSeed * 40.0 + uTime * speed * 3.0 + t * 7.0;
    vec3 p = vec3(cos(ang) * radius, sin(ang) * radius, 0.03 + aSeed * 0.04);
    vFade = sin(t * 3.14159); // fade in/out over the lifetime
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = (2.5 + aSeed * 2.0) * (1.0 + uIntensity) * (60.0 / max(1.0, -mv.z));
    gl_Position = projectionMatrix * mv;
  }
`;

const POINTS_FRAG = /* glsl */ `
  varying float vFade;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float a = smoothstep(0.5, 0.0, length(d)) * vFade * 0.85;
    gl_FragColor = vec4(0.659, 0.333, 0.969, a); // #a855f7
  }
`;

interface Marker {
  group: THREE.Group;
  placed: boolean;
  pos: THREE.Vector3;
  normal: THREE.Vector3;
}

export class ObliterreurMarkers {
  private readonly markers: Marker[] = [];
  private readonly uTime = { value: 0 };
  private readonly uIntensity = { value: 0 };
  private intensityTarget = 0;
  private readonly tmpQuat = new THREE.Quaternion();
  private static readonly Z_AXIS = new THREE.Vector3(0, 0, 1);

  constructor(private readonly scene: THREE.Scene) {
    for (let i = 0; i < 2; i++) {
      this.markers.push(this.buildMarker(i));
    }
  }

  private buildMarker(index: number): Marker {
    const group = new THREE.Group();
    group.visible = false;

    const r = oc.obliterreurMarkerRadius;

    // (a) Main swirling disc.
    const discMat = new THREE.ShaderMaterial({
      vertexShader: DISC_VERT,
      fragmentShader: DISC_FRAG,
      uniforms: {
        uTime: this.uTime,
        uIntensity: this.uIntensity,
        uThroughWall: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const disc = new THREE.Mesh(new THREE.CircleGeometry(r, 48), discMat);
    disc.renderOrder = 60;
    disc.frustumCulled = false;
    group.add(disc);

    // (b) Through-wall glow silhouette (always visible, additive, faint).
    const glowMat = new THREE.ShaderMaterial({
      vertexShader: DISC_VERT,
      fragmentShader: DISC_FRAG,
      uniforms: {
        uTime: this.uTime,
        uIntensity: this.uIntensity,
        uThroughWall: { value: 1 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const glow = new THREE.Mesh(new THREE.CircleGeometry(r * 1.18, 48), glowMat);
    glow.renderOrder = 995;
    glow.frustumCulled = false;
    glow.position.z = 0.001;
    group.add(glow);

    // (c) Orbiting particles spiraling into the hole.
    const count = 24;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    const seeds = new Float32Array(count);
    for (let i = 0; i < count; i++) seeds[i] = Math.random();
    geom.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
    const pointsMat = new THREE.ShaderMaterial({
      vertexShader: POINTS_VERT,
      fragmentShader: POINTS_FRAG,
      uniforms: { uTime: this.uTime, uIntensity: this.uIntensity },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const points = new THREE.Points(geom, pointsMat);
    points.scale.setScalar(r);
    points.renderOrder = 61;
    points.frustumCulled = false;
    group.add(points);

    // (d) Discreet "I" / "II" label above the disc.
    const label = ObliterreurMarkers.makeLabel(index === 0 ? "I" : "II");
    label.position.set(0, r * 1.55, 0.05);
    group.add(label);

    this.scene.add(group);
    return {
      group,
      placed: false,
      pos: new THREE.Vector3(),
      normal: new THREE.Vector3(0, 1, 0),
    };
  }

  private static makeLabel(text: string): THREE.Sprite {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d")!;
    ctx.font = "bold 42px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#c4b5fd";
    ctx.shadowColor = "#7c3aed";
    ctx.shadowBlur = 10;
    ctx.fillText(text, 32, 34);
    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      opacity: 0.55,
      depthTest: false,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.setScalar(0.2);
    sprite.renderOrder = 996;
    return sprite;
  }

  /** Place (or re-place) an anchor point on a surface. */
  setPoint(index: number, pos: THREE.Vector3, normal: THREE.Vector3): void {
    const m = this.markers[index];
    m.placed = true;
    m.pos.copy(pos).addScaledVector(normal, oc.obliterreurPointSurfaceOffset);
    m.normal.copy(normal);
    m.group.position.copy(m.pos);
    this.tmpQuat.setFromUnitVectors(ObliterreurMarkers.Z_AXIS, normal);
    m.group.quaternion.copy(this.tmpQuat);
    m.group.visible = true;
  }

  hasPoint(index: number): boolean {
    return this.markers[index].placed;
  }

  /** Read a placed point (offset position + surface normal). */
  getPoint(index: number, outPos: THREE.Vector3, outNormal: THREE.Vector3): void {
    outPos.copy(this.markers[index].pos);
    outNormal.copy(this.markers[index].normal);
  }

  clearAll(): void {
    for (const m of this.markers) {
      m.placed = false;
      m.group.visible = false;
    }
  }

  /** 0 = idle glow, 1 = full beam-active boost (smoothed in update). */
  setBeamIntensity(k: number): void {
    this.intensityTarget = k;
  }

  update(dt: number, time: number): void {
    this.uTime.value = time;
    this.uIntensity.value = THREE.MathUtils.damp(
      this.uIntensity.value,
      this.intensityTarget,
      8,
      dt,
    );
  }
}