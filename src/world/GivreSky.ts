import * as THREE from "three";
import { GivreConfig as cfg } from "./GivreConfig";

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

  constructor() {
    this.group.name = "givre_sky";
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
    this.disposables.push(geo, mat);
    const dome = new THREE.Mesh(geo, mat);
    dome.renderOrder = -10; // behind everything
    dome.frustumCulled = false;
    dome.userData.noOutline = true;
    dome.raycast = () => {}; // purely visual
    this.group.add(dome);
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
