import * as THREE from "three";

/**
 * PERF — every bot's enemy UI (dark bar background + red fill + "BOT"
 * nameplate) in TWO instanced draw calls for the whole scene.
 *
 * It used to be three meshes per bot (two of them transparent, two private
 * materials per bot): 24 draw calls with 8 bots in view, each with a full
 * material setup. Now:
 *  - the red FILL is one OPAQUE instanced quad per bot (depth written, drawn
 *    in the opaque pass — exactly like the former opaque fill plane, so
 *    smoke / steam / glass in front of a bot still cover its bar), its width
 *    following the per-instance health ratio;
 *  - the translucent background + the nameplate are one transparent quad
 *    per bot drawn by a tiny shader (same layout, colours, opacity and
 *    texture as the former planes: bar 1.15 × 0.16, fill 1.09 × 0.115 in
 *    front of it, label 0.52 × 0.195 centred 0.19 above).
 *
 * Instance matrices are WORLD matrices (the batch lives at the scene root),
 * shared by both meshes: a bot updates its slot (position + camera-facing
 * rotation + health) every frame in BotModel.updateUI; the shown slots are
 * written right before each render, sorted back to front (see publish).
 */
const BAR_HALF = new THREE.Vector2(0.575, 0.08);
const FILL_LEFT = -0.545;
const FILL_WIDTH = 1.09;
const FILL_HALF_HEIGHT = 0.0575;
/** The former fill plane sat 2 mm in front of the background. */
const FILL_Z = 0.002;
const LABEL_CENTER_Y = 0.19;
const LABEL_HALF = new THREE.Vector2(0.26, 0.0975);
/** One quad covering the bar and the label above it. */
const QUAD_BOTTOM = -BAR_HALF.y;
const QUAD_TOP = LABEL_CENTER_Y + LABEL_HALF.y;

const VERTEX = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
varying vec2 vLocal;
void main() {
  vLocal = position.xy;
  vec4 p = vec4(position, 1.0);
  #ifdef USE_INSTANCING
    p = instanceMatrix * p;
  #endif
  vec4 mvPosition = modelViewMatrix * p;
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;

const FRAGMENT = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
uniform sampler2D uLabel;
uniform float uShowName;
uniform vec3 uBgColor;
uniform float uBgAlpha;
varying vec2 vLocal;
// 1 inside the rectangle (centre c, half size h), anti-aliased edge.
float rectMask(vec2 p, vec2 c, vec2 h) {
  vec2 d = abs(p - c) - h;
  vec2 w = max(fwidth(p), vec2(1e-5));
  return clamp(0.5 - max(d.x / w.x, d.y / w.y), 0.0, 1.0);
}
void main() {
  #include <logdepthbuf_fragment>
  vec2 p = vLocal;
  vec4 col;
  if (p.y < ${((BAR_HALF.y + LABEL_CENTER_Y - LABEL_HALF.y) / 2).toFixed(5)}) {
    // Health bar background (translucent dark). The red fill is the opaque
    // instanced quad drawn in front of it (FILL_* shaders).
    float bg = rectMask(p, vec2(0.0), vec2(${BAR_HALF.x}, ${BAR_HALF.y}));
    col = vec4(uBgColor, uBgAlpha * bg);
  } else {
    // Nameplate (same texture / mapping as the former label plane).
    float m = uShowName * rectMask(p, vec2(0.0, ${LABEL_CENTER_Y}), vec2(${LABEL_HALF.x}, ${LABEL_HALF.y}));
    vec2 uv = vec2((p.x + ${LABEL_HALF.x}) / ${(2 * LABEL_HALF.x).toFixed(5)}, (p.y - ${(LABEL_CENTER_Y - LABEL_HALF.y).toFixed(5)}) / ${(2 * LABEL_HALF.y).toFixed(5)});
    col = texture2D(uLabel, uv);
    col.a *= m;
  }
  if (col.a < 0.004) discard;
  gl_FragColor = col;
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

/** Opaque red fill: the quad's right edge follows the health ratio. */
const FILL_VERTEX = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
attribute float aHp;
void main() {
  vec3 q = position;
  q.x = ${FILL_LEFT} + (q.x - ${FILL_LEFT}) * clamp(aHp, 0.0, 1.0);
  vec4 p = vec4(q, 1.0);
  #ifdef USE_INSTANCING
    p = instanceMatrix * p;
  #endif
  vec4 mvPosition = modelViewMatrix * p;
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;

const FILL_FRAGMENT = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
uniform vec3 uFillColor;
void main() {
  #include <logdepthbuf_fragment>
  gl_FragColor = vec4(uFillColor, 1.0);
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

const ONE = new THREE.Vector3(1, 1, 1);
const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();

const batches = new WeakMap<THREE.Object3D, EnemyHealthBars>();

export interface EnemyHealthBarOptions {
  label: THREE.Texture;
  bgColor: THREE.ColorRepresentation;
  bgOpacity: number;
  fillColor: THREE.ColorRepresentation;
  showName: () => boolean;
}

export class EnemyHealthBars {
  /** The shared batch of a scene (created and added to it on first use). */
  static for(scene: THREE.Object3D, options: EnemyHealthBarOptions): EnemyHealthBars {
    let batch = batches.get(scene);
    if (!batch) {
      batch = new EnemyHealthBars(scene, options);
      batches.set(scene, batch);
    }
    return batch;
  }

  /** Background + label quad (transparent pass). */
  private readonly geometry: THREE.PlaneGeometry;
  private readonly material: THREE.ShaderMaterial;
  /** Red fill quad (opaque pass), in front of the background. */
  private readonly fillGeometry: THREE.PlaneGeometry;
  private readonly fillMaterial: THREE.ShaderMaterial;
  private mesh: THREE.InstancedMesh;
  private fill: THREE.InstancedMesh;
  private hp: THREE.InstancedBufferAttribute;
  private capacity = 0;
  /** Every acquired (not released) slot. */
  private readonly slots: EnemyHealthBarSlot[] = [];
  /** Shown slots of the last publish, back to front (scratch, reused). */
  private readonly order: EnemyHealthBarSlot[] = [];
  /**
   * The instances are (re)written right before each render of the scene
   * (scene.onBeforeRender — three calls it before uploading the buffers),
   * SORTED back to front for the camera actually rendered: overlapping bars
   * of two bots blend in the right order, exactly like the former per-bot
   * transparent planes sorted by three. Without a Scene to hook (tests),
   * the slots are written immediately in acquisition order.
   */
  private readonly hooked: boolean;
  private dirty = true;
  /** Camera world matrix of the last publish (re-sort only when it moved). */
  private readonly lastCamera = new Float32Array(16);

  private constructor(
    private readonly scene: THREE.Object3D,
    private readonly options: EnemyHealthBarOptions,
  ) {
    this.geometry = new THREE.PlaneGeometry(2 * BAR_HALF.x, QUAD_TOP - QUAD_BOTTOM);
    this.geometry.translate(0, (QUAD_TOP + QUAD_BOTTOM) / 2, 0);
    // Scene fog applies like on the former MeshBasicMaterial planes.
    this.material = new THREE.ShaderMaterial({
      name: "EnemyHealthBars",
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uLabel: { value: null },
          uShowName: { value: options.showName() ? 1 : 0 },
          uBgColor: { value: new THREE.Color(options.bgColor) },
          uBgAlpha: { value: options.bgOpacity },
        },
      ]),
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      toneMapped: false,
      fog: true,
    });
    this.material.uniforms.uLabel.value = options.label; // shared texture (merge would clone it)
    // Full-width fill rectangle (left edge FILL_LEFT); the vertex shader
    // pulls its right edge in with the health ratio.
    this.fillGeometry = new THREE.PlaneGeometry(FILL_WIDTH, 2 * FILL_HALF_HEIGHT);
    this.fillGeometry.translate(FILL_LEFT + FILL_WIDTH / 2, 0, FILL_Z);
    this.fillMaterial = new THREE.ShaderMaterial({
      name: "EnemyHealthBars.fill",
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        { uFillColor: { value: new THREE.Color(options.fillColor) } },
      ]),
      vertexShader: FILL_VERTEX,
      fragmentShader: FILL_FRAGMENT,
      toneMapped: false,
      fog: true,
    });
    const built = this.build(16);
    this.mesh = built.mesh;
    this.fill = built.fill;
    this.hp = built.hp;

    const sceneRoot = scene as THREE.Scene;
    this.hooked = sceneRoot.isScene === true;
    if (this.hooked) {
      const previous = sceneRoot.onBeforeRender;
      sceneRoot.onBeforeRender = (...args: Parameters<THREE.Scene["onBeforeRender"]>) => {
        previous.apply(sceneRoot, args);
        this.publish(args[2]);
      };
    }
  }

  acquire(): EnemyHealthBarSlot {
    const slot = new EnemyHealthBarSlot(this);
    this.slots.push(slot);
    if (this.slots.length > this.capacity) this.grow(this.capacity * 2);
    return slot;
  }

  /** @internal slot API — a slot's state changed. */
  touch(): void {
    this.dirty = true;
    if (!this.hooked) this.publish(null);
  }

  /** @internal slot API */
  release(slot: EnemyHealthBarSlot): void {
    const i = this.slots.indexOf(slot);
    if (i < 0) return;
    this.slots[i] = this.slots[this.slots.length - 1];
    this.slots.pop();
    this.touch();
  }

  /**
   * Write the shown slots into the instance buffers, back to front for
   * `camera` (null = acquisition order). Skipped when neither a slot nor
   * the camera changed since the last write.
   */
  private publish(camera: THREE.Camera | null): void {
    if (camera) {
      const e = camera.matrixWorld.elements;
      let moved = false;
      for (let i = 0; i < 16; i++) {
        if (this.lastCamera[i] !== e[i]) {
          moved = true;
          break;
        }
      }
      if (!moved && !this.dirty) return;
      this.lastCamera.set(e);
    }
    this.dirty = false;
    const order = this.order;
    order.length = 0;
    for (const slot of this.slots) {
      if (!slot.shown) continue;
      // View-space depth (the camera looks down -Z: more negative = farther).
      slot.depth = camera ? _v.copy(slot.position).applyMatrix4(camera.matrixWorldInverse).z : 0;
      // Insertion sort (≤ a few dozen bars, no allocation): farthest first.
      let j = order.length;
      order.push(slot);
      while (j > 0 && order[j - 1].depth > slot.depth) {
        order[j] = order[j - 1];
        j--;
      }
      order[j] = slot;
    }
    const n = order.length;
    const hp = this.hp.array as Float32Array;
    for (let i = 0; i < n; i++) {
      const slot = order[i];
      _m.compose(slot.position, slot.rotation, ONE);
      this.mesh.setMatrixAt(i, _m); // instanceMatrix shared by both meshes
      hp[i] = slot.hp;
    }
    this.mesh.count = this.fill.count = n;
    this.mesh.visible = this.fill.visible = n > 0;
    if (n > 0) {
      const im = this.mesh.instanceMatrix;
      im.clearUpdateRanges();
      im.addUpdateRange(0, n * 16);
      im.needsUpdate = true;
      this.hp.clearUpdateRanges();
      this.hp.addUpdateRange(0, n);
      this.hp.needsUpdate = true;
    }
    this.material.uniforms.uShowName.value = this.options.showName() ? 1 : 0;
  }

  private build(capacity: number): {
    mesh: THREE.InstancedMesh;
    fill: THREE.InstancedMesh;
    hp: THREE.InstancedBufferAttribute;
  } {
    const hp = new THREE.InstancedBufferAttribute(new Float32Array(capacity).fill(1), 1);
    hp.setUsage(THREE.DynamicDrawUsage);
    const mesh = new THREE.InstancedMesh(this.geometry.clone(), this.material, capacity);
    mesh.name = "EnemyHealthBars";
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const fillGeometry = this.fillGeometry.clone();
    fillGeometry.setAttribute("aHp", hp);
    const fill = new THREE.InstancedMesh(fillGeometry, this.fillMaterial, capacity);
    fill.name = "EnemyHealthBars.fill";
    // ONE instance buffer for both meshes (uploaded once per frame).
    fill.instanceMatrix = mesh.instanceMatrix;
    for (const m of [mesh, fill]) {
      m.count = 0;
      m.visible = false;
      m.frustumCulled = false; // world-space instances all over the map
      m.castShadow = false;
      m.receiveShadow = false;
      m.matrixAutoUpdate = false;
      m.userData.noOutline = true;
      m.raycast = () => {};
      this.scene.add(m);
    }
    this.capacity = capacity;
    this.dirty = true;
    return { mesh, fill, hp };
  }

  private grow(capacity: number): void {
    const old = this.mesh;
    const oldFill = this.fill;
    const built = this.build(capacity);
    for (const m of [old, oldFill]) {
      m.removeFromParent();
      m.geometry.dispose();
    }
    old.dispose(); // (the fill shares the instance buffer — disposed once)
    this.mesh = built.mesh;
    this.fill = built.fill;
    this.hp = built.hp;
    if (!this.hooked) this.publish(null);
  }
}

/** One bot's bar in the shared batch. */
export class EnemyHealthBarSlot {
  private released = false;
  /** @internal batch state */
  shown = false;
  /** @internal batch state: view depth of the last sort. */
  depth = 0;
  /** @internal batch state */
  readonly position = new THREE.Vector3();
  /** @internal batch state */
  readonly rotation = new THREE.Quaternion();
  /** @internal batch state */
  hp = 1;

  constructor(private readonly owner: EnemyHealthBars) {}

  /** World position (bar centre), camera-facing world rotation, health 0..1. */
  set(position: THREE.Vector3, rotation: THREE.Quaternion, hp: number): void {
    if (this.released) return;
    this.position.copy(position);
    this.rotation.copy(rotation);
    this.hp = hp;
    if (this.shown) this.owner.touch();
  }

  setVisible(visible: boolean): void {
    if (this.released || visible === this.shown) return;
    this.shown = visible;
    this.owner.touch();
  }

  release(): void {
    if (this.released) return;
    this.shown = false;
    this.released = true;
    this.owner.release(this);
  }
}
