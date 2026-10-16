import * as THREE from "three";
import type { IntroCharacter, IntroCharacterClips } from "./MatchIntroTypes";
import type { BladeFrame } from "./MatchIntroTimeline";

/**
 * MATCH INTRO — one player's 3D "photo booth": the dressed character
 * clone, its own lights (accent-colored rims) and camera. The compositor
 * renders it into the blade's screen rectangle; the camera uses a lens
 * shift so the character's chest lands exactly on the blade focus point,
 * whatever the blade shape.
 */

export interface PoseProgram {
  clip: keyof IntroCharacterClips;
  /** Clip time at the entrance (s). */
  t0: number;
  /** Slow-motion playback speed during the reveal. */
  speed: number;
  /** Near-frozen drift once the player sits in its slot. */
  slotSpeed: number;
  /** Seconds of reveal slow-motion before the slot drift takes over. */
  hold: number;
  /** Clip segment that reads as a strong pose (the playhead ping-pongs inside). */
  range: [number, number];
}

/** Action poses of the challengers (presentation order), slow-mo frozen. */
export const CHALLENGER_POSES: readonly PoseProgram[] = [
  { clip: "dash", t0: 0.3, speed: 0.2, slotSpeed: 0.02, hold: 0.6, range: [0.3, 0.46] },
  { clip: "slide", t0: 0.45, speed: 0.25, slotSpeed: 0.03, hold: 0.6, range: [0.35, 1.15] },
  { clip: "run", t0: 0.12, speed: 0.22, slotSpeed: 0.03, hold: 0.6, range: [0.1, 0.32] },
  { clip: "dash", t0: 0.34, speed: 0.18, slotSpeed: 0.02, hold: 0.6, range: [0.3, 0.46] },
  { clip: "slide", t0: 0.8, speed: 0.25, slotSpeed: 0.03, hold: 0.6, range: [0.35, 1.15] },
  { clip: "jump", t0: 0.1, speed: 0.12, slotSpeed: 0.015, hold: 0.6, range: [0.08, 0.2] },
  { clip: "run", t0: 0.2, speed: 0.22, slotSpeed: 0.03, hold: 0.6, range: [0.1, 0.32] },
];
/** The champion: low fighting stance (slide crouch), camera low and close. */
export const MVP_POSE: PoseProgram = { clip: "slide", t0: 0.4, speed: 0.16, slotSpeed: 0.03, hold: 1.2, range: [0.35, 1.1] };

const FOV = 26;
/** Ink contour thickness on the 2.25 m character (world meters). */
const OUTLINE_WORLD = 0.065;
/**
 * View-space push of the contour hull (m). The hull only survives where
 * the depth jumps by more than this (silhouette, arm over body…): its back
 * faces never poke through the creases of tight clothes in close-ups.
 */
const OUTLINE_PUSH = 0.14;

const inkMaterials = new Map<string, THREE.MeshBasicMaterial>();
/** Sticker contour: inverted hull in the HUD "ink" (dark wood), intro-only materials. */
function getInkOutlineMaterial(localThickness: number): THREE.MeshBasicMaterial {
  const key = localThickness.toFixed(5);
  let mat = inkMaterials.get(key);
  if (!mat) {
    mat = new THREE.MeshBasicMaterial({ color: 0x2a1b0c, side: THREE.BackSide, toneMapped: false });
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace("#include <begin_vertex>", `#include <begin_vertex>\n\ttransformed += normal * ${key};`)
        .replace(
          "#include <project_vertex>",
          `#include <project_vertex>\n\tmvPosition.z -= ${OUTLINE_PUSH.toFixed(3)};\n\tgl_Position = projectionMatrix * mvPosition;`,
        );
    };
    // The inflation is baked in the shader text: one program per thickness.
    mat.customProgramCacheKey = () => `matchIntroInk:${key}`;
    inkMaterials.set(key, mat);
  }
  return mat;
}

const hullGeometries = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>();
/**
 * Contour geometry of a skinned part: SAME attribute buffers as the source
 * (no copy, the game geometry is never modified) but SMOOTHED normals —
 * hard-edged clothes (boots) would otherwise crack open when inflated.
 */
function getHullGeometry(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const cached = hullGeometries.get(src);
  if (cached) return cached;
  const geometry = new THREE.BufferGeometry();
  for (const [name, attribute] of Object.entries(src.attributes)) {
    if (name !== "normal") geometry.setAttribute(name, attribute);
  }
  if (src.index) geometry.setIndex(src.index);
  geometry.setDrawRange(src.drawRange.start, src.drawRange.count);
  const pos = src.getAttribute("position");
  const nrm = src.getAttribute("normal");
  const count = pos.count;
  const sums = new Map<string, number[]>();
  const keys: string[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const key = `${Math.round(pos.getX(i) * 1e4)},${Math.round(pos.getY(i) * 1e4)},${Math.round(pos.getZ(i) * 1e4)}`;
    keys[i] = key;
    let acc = sums.get(key);
    if (!acc) sums.set(key, (acc = [0, 0, 0]));
    acc[0] += nrm.getX(i);
    acc[1] += nrm.getY(i);
    acc[2] += nrm.getZ(i);
  }
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const acc = sums.get(keys[i])!;
    const len = Math.hypot(acc[0], acc[1], acc[2]);
    if (len > 1e-6) {
      out[i * 3] = acc[0] / len;
      out[i * 3 + 1] = acc[1] / len;
      out[i * 3 + 2] = acc[2] / len;
    } else {
      out[i * 3] = nrm.getX(i);
      out[i * 3 + 1] = nrm.getY(i);
      out[i * 3 + 2] = nrm.getZ(i);
    }
  }
  geometry.setAttribute("normal", new THREE.BufferAttribute(out, 3));
  geometry.name = `${src.name || "part"}_IntroInk`;
  hullGeometries.set(src, geometry);
  return geometry;
}

export class IntroStage {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 80);
  readonly hasCharacter: boolean;
  private readonly holder = new THREE.Group();
  private readonly mixer: THREE.AnimationMixer | null = null;
  private readonly action: THREE.AnimationAction | null = null;
  private readonly clipDuration: number = 1;
  private readonly hulls: THREE.Object3D[] = [];
  private readonly character: IntroCharacter | null;
  private readonly program: PoseProgram;
  private readonly target = new THREE.Vector3();
  /** Head bone (rig convention "Head") for the slot portrait framing. */
  private readonly head: THREE.Object3D | null = null;
  private readonly restHeadY: number = 0;
  private readonly headPos = new THREE.Vector3();

  constructor(character: IntroCharacter | null, accent: THREE.ColorRepresentation, program: PoseProgram) {
    this.character = character;
    this.program = program;
    this.hasCharacter = !!character;
    const accentColor = new THREE.Color(accent);

    // Lights: warm key, cool fill, two accent rims (the "versus" backlight).
    this.scene.add(new THREE.HemisphereLight(0xfff1d6, 0x3a2814, 0.95));
    const key = new THREE.DirectionalLight(0xfff4e2, 2.5);
    key.position.set(-2.2, 3.2, 4.0);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xbfe0ff, 0.55);
    fill.position.set(3.0, 1.0, 2.5);
    this.scene.add(fill);
    const rimA = new THREE.DirectionalLight(accentColor, 5.0);
    rimA.position.set(3.5, 2.6, -3.0);
    this.scene.add(rimA);
    const rimB = new THREE.DirectionalLight(accentColor.clone().lerp(new THREE.Color(0xffffff), 0.35), 2.2);
    rimB.position.set(-3.5, 1.4, -2.5);
    this.scene.add(rimB);
    this.scene.add(this.holder);

    if (!character) return;
    const root = character.root;
    root.position.set(0, 0, 0);
    this.holder.add(root);
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.frustumCulled = false;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
      }
    });
    this.addInkOutline(root);
    this.head = root.getObjectByName("Head") ?? null;
    if (this.head) {
      this.holder.updateMatrixWorld(true);
      this.restHeadY = this.head.getWorldPosition(this.headPos).y;
    }

    const clip =
      character.clips[program.clip] ??
      character.clips.jump ??
      character.clips.dash ??
      character.clips.run ??
      character.clips.idle;
    if (clip) {
      this.mixer = new THREE.AnimationMixer(root);
      this.action = this.mixer.clipAction(clip);
      this.action.play();
      this.action.paused = true;
      this.clipDuration = Math.max(0.05, clip.duration);
    }
  }

  /**
   * Inverted-hull ink contour on every opaque part: the skinned body and
   * clothes (hull bound to the same live skeleton) and the rigid
   * accessories (helmet shell, backpack: hull child at identity). The
   * inflation is converted to each part's local units so every piece gets
   * the same on-screen line weight.
   */
  private addInkOutline(root: THREE.Object3D): void {
    root.updateMatrixWorld(true);
    const parts: THREE.Mesh[] = [];
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh && mesh.visible && !mesh.userData.introOutline && !mesh.userData.enemyOutline) parts.push(mesh);
    });
    const scale = new THREE.Vector3();
    for (const src of parts) {
      const mats = Array.isArray(src.material) ? src.material : [src.material];
      // Glass / transparent pieces (helmet visor) get no contour.
      if (mats.some((m) => !m || m.transparent || m.opacity < 1)) continue;
      if (!src.geometry.getAttribute("normal")) continue;
      src.getWorldScale(scale);
      const s = Math.max(1e-6, Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z));
      const material = getInkOutlineMaterial(OUTLINE_WORLD / s);
      let hull: THREE.Mesh;
      if ((src as THREE.SkinnedMesh).isSkinnedMesh) {
        const skinned = src as THREE.SkinnedMesh;
        const h = new THREE.SkinnedMesh(getHullGeometry(skinned.geometry), material);
        h.bindMode = skinned.bindMode;
        h.bind(skinned.skeleton, skinned.bindMatrix);
        h.position.copy(skinned.position);
        h.quaternion.copy(skinned.quaternion);
        h.scale.copy(skinned.scale);
        skinned.parent?.add(h);
        hull = h;
      } else {
        // Rigid accessories keep their authored normals (small stacked parts
        // such as the helmet ear discs would bulge with averaged normals).
        hull = new THREE.Mesh(src.geometry, material);
        src.add(hull);
      }
      hull.frustumCulled = false;
      hull.castShadow = false;
      hull.receiveShadow = false;
      // After the bodies: the depth test rejects every hidden hull fragment.
      hull.renderOrder = 1;
      hull.userData.introOutline = true;
      hull.raycast = () => {};
      this.hulls.push(hull);
    }
  }

  /** Clip time of the pose program at `poseTime` seconds after the entrance. */
  private clipTime(poseTime: number): number {
    const p = this.program;
    const tau = Math.max(0, poseTime);
    const raw = p.t0 + p.speed * Math.min(tau, p.hold) + p.slotSpeed * Math.max(0, tau - p.hold);
    // Ping-pong inside the pose segment so a long hold never snaps back.
    const a = Math.max(0, Math.min(p.range[0], this.clipDuration - 0.02));
    const b = Math.max(a + 0.01, Math.min(p.range[1], this.clipDuration - 0.02));
    const d = b - a;
    const period = 2 * d;
    const m = (((raw - a) % period) + period) % period;
    return a + (m <= d ? m : period - m);
  }

  /**
   * Pose + frame the character for this frame. `bbox` is the blade's
   * screen rectangle and `focus` the chest position, both in normalized
   * screen units.
   */
  update(f: BladeFrame, bbox: { x0: number; y0: number; x1: number; y1: number }, aspect: number): void {
    if (this.action && this.mixer) {
      this.action.time = this.clipTime(f.poseTime);
      this.mixer.update(0);
    }
    const pop = THREE.MathUtils.clamp(f.pop, 0, 1.3);
    this.holder.rotation.y = Math.PI + f.yaw;
    this.holder.scale.setScalar(0.82 + 0.18 * pop);
    this.holder.position.y = -0.25 * (1 - Math.min(1, pop));

    // Look-at point: the chest at `lookY`, drifting onto the head in the
    // slots so a leaning / crouching pose never crops the face.
    let lx = 0;
    let ly = f.lookY;
    let lz = 0;
    if (this.head && f.track > 0.001) {
      this.holder.updateMatrixWorld(true);
      this.head.getWorldPosition(this.headPos);
      const restY = this.restHeadY * this.holder.scale.y + this.holder.position.y;
      lx = this.headPos.x * f.track;
      lz = this.headPos.z * f.track;
      ly = f.lookY + (this.headPos.y - restY) * 0.7 * f.track;
    }

    const bw = Math.max(1e-4, bbox.x1 - bbox.x0);
    const bh = Math.max(1e-4, bbox.y1 - bbox.y0);
    const cam = this.camera;
    cam.fov = FOV;
    cam.aspect = (bw * aspect) / bh;
    const dist = (f.frameH / 2 / Math.tan(THREE.MathUtils.degToRad(FOV / 2))) * f.dolly;
    this.target.set(lx, ly, lz);
    const elev = -0.06; // slightly low camera: heroic framing
    cam.position.set(
      lx + Math.sin(f.orbit) * dist,
      ly + elev * dist,
      lz + Math.cos(f.orbit) * dist,
    );
    cam.lookAt(this.target);
    cam.updateProjectionMatrix();
    // Lens shift: the look-at point projects on the blade focus point.
    const ndcX = ((f.focus[0] - bbox.x0) / bw) * 2 - 1;
    const ndcY = 1 - ((f.focus[1] - bbox.y0) / bh) * 2;
    cam.projectionMatrix.elements[8] = -ndcX;
    cam.projectionMatrix.elements[9] = -ndcY;
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
  }

  dispose(): void {
    for (const h of this.hulls) h.removeFromParent();
    this.hulls.length = 0;
    this.action?.stop();
    if (this.mixer && this.character) this.mixer.uncacheRoot(this.character.root);
    this.character?.root.removeFromParent();
    this.character?.dispose();
  }
}
