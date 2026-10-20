import * as THREE from "three";
import { GivreConfig as cfg } from "./GivreConfig";

/**
 * The dome's place in the opaque list: after every opaque object of the
 * world (the highest other render order is 999, the ragdoll debug lines).
 */
export const GIVRE_SKY_RENDER_ORDER = 10000;

/**
 * GIVRE 01 backdrop: the concept's flat alpine sky — one inverted sphere
 * with per-vertex colours following the export's gradient
 * (`lighting.skyBackground`: fac = clamp((dir.y + 0.02) / 0.82, 0, 1)).
 *
 * Same contract as YardSky / SpaceSky (the Game holds any of them):
 *  - one mesh, no texture, no light, no fog;
 *  - the group follows the camera so the sky reads as infinitely far;
 *  - never raycastable, collidable or outlined (userData.noOutline).
 */
export class GivreSky {
  readonly group = new THREE.Group();

  private readonly disposables: { dispose(): void }[] = [];
  private dome: THREE.Mesh | null = null;

  constructor() {
    this.group.name = "givre_sky";
    // (A Group's render order is its children's "group order", sorted before
    // their own: the dome stays last whatever other groups use.)
    this.group.renderOrder = GIVRE_SKY_RENDER_ORDER;
    // GivreOutlinePass: the sky never produces edges.
    this.group.userData.noOutline = true;
    this.buildDome();
  }

  private buildDome(): void {
    const stops = cfg.skyStops.map(([t, hex]) => ({ t, c: new THREE.Color(hex) }));
    const radius = cfg.skyRadius;
    const geo = new THREE.SphereGeometry(radius, 48, 24);
    const pos = geo.getAttribute("position");
    const colors = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const dirY = pos.getY(i) / radius;
      const f = THREE.MathUtils.clamp((dirY + 0.02) / 0.82, 0, 1);
      let k = 0;
      while (k < stops.length - 2 && f > stops[k + 1].t) k++;
      const a = stops[k];
      const b = stops[k + 1];
      c.copy(a.c).lerp(b.c, THREE.MathUtils.clamp((f - a.t) / (b.t - a.t), 0, 1));
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
    // PERF (GPU): drawn LAST among the opaques, on the far plane, with the
    // depth test — the GPU only colours the sky pixels nothing hides
    // (indoors: almost none). Drawn first, it filled the whole screen every
    // frame before the walls covered it: 1.7 ms of a 15 ms frame on an Intel
    // Iris Xe at 1920 × 928. Same image: every opaque writes depth (so the
    // sky still lands only where nothing was drawn), and every material that
    // does not is transparent — drawn after the sky, as before.
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace(
        "#include <project_vertex>",
        "#include <project_vertex>\n\tgl_Position.z = gl_Position.w; // on the far plane: behind any depth written",
      );
    };
    this.disposables.push(geo, mat);
    const dome = new THREE.Mesh(geo, mat);
    dome.renderOrder = GIVRE_SKY_RENDER_ORDER; // after every opaque, before the transparents
    dome.frustumCulled = false;
    dome.userData.noOutline = true;
    dome.raycast = () => {}; // purely visual
    this.group.add(dome);
    this.dome = dome;
  }

  /**
   * True while the dome is drawn in `scene`: a closed sphere around the
   * camera on the far plane, depth-tested after the opaques — every pixel
   * the opaques leave free (every view direction) gets the sky colour. The
   * world pass then skips its colour clear (SkyCoveredRenderPass).
   */
  coversEveryPixel(scene: THREE.Scene): boolean {
    const dome = this.dome;
    return dome !== null && dome.visible && this.group.visible && this.group.parent === scene;
  }

  /**
   * Same signature as SpaceSky.update / YardSky.update.
   * @param _dt       unused
   * @param _elapsed  unused (static sky)
   * @param camera    the sky follows the camera so it reads as infinitely far
   */
  update(_dt: number, _elapsed: number, camera: THREE.Camera): void {
    this.group.position.copy(camera.position);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.group.removeFromParent();
  }
}
