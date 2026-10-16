// v3 : empreintes de pied nu dans la neige de Givre (three.js r155+). Code de reference, a adapter au projet.
// Un seul InstancedMesh (un appel de rendu) avec une reserve fixe de decalques (poolSize = 1024) : chaque pas sur
// la neige (materiau GIV_Neige, pente <= 30 degres) pose un decalque a plat sur le sol, oriente dans le sens de la
// marche, pied gauche en miroir. L'empreinte reste entiere 20 s puis s'efface en douceur jusqu'a 30 s ; le fondu
// est calcule dans le shader (aucun travail CPU par image). Purement visuel : ni collision, ni message reseau.
// Chaque client pose les empreintes de tous les joueurs qu'il voit, a partir des positions qu'il recoit deja.
//
// La neige sous le pied est trouvee dans une grille 2D des triangles de neige (GivreSnowGrid), construite une fois
// au chargement : quelques triangles testes par pas, au lieu des ~24 000 du mesh de neige pour un Raycaster.
import * as THREE from 'three';
import type { GivrePhysics } from './givrePhysics.types';

const FOOT_VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute float aBirth;
attribute float aMirror;
varying vec2 vUv;
varying float vBirth;
void main() {
  vUv = vec2(aMirror > 0.0 ? uv.x : 1.0 - uv.x, uv.y);
  vBirth = aBirth;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const FOOT_FRAGMENT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D uMap;
uniform float uTime;
uniform float uFull;
uniform float uGone;
uniform vec3 uSnow;        // couleur de base lineaire de la neige (materiau GIV_Neige)
varying vec2 vUv;
varying float vBirth;
void main() {
  #include <logdepthbuf_fragment>
  float age = uTime - vBirth;
  vec4 tex = texture2D(uMap, vUv);
  float a = tex.a * step(0.0, age) * (1.0 - smoothstep(uFull, uGone, age));
  if (a < 0.004) discard;
  // decalque multiplicatif : la neige deja eclairee (soleil, ombre, lumiere des guirlandes) prend la teinte du
  // creux, comme un decalque eclaire dans Blender : neige x mix(1, empreinte / neige, alpha)
  vec3 f = clamp(tex.rgb / uSnow, 0.0, 1.0);
  gl_FragColor = vec4(mix(vec3(1.0), f, a), 1.0);
  #include <colorspace_fragment>
}
`;

/** Fenetre verticale ou chercher la neige autour du pied (m). */
const SEARCH_ABOVE = 0.5; // pied enfonce dans une congere
const SEARCH_BELOW = 0.35; // neige plus basse : le joueur est sur une caisse ou en l'air, pas d'empreinte

/**
 * Grille XZ (cellules de 2 m) des triangles de neige, en coordonnees monde. A construire apres avoir place la map
 * (la map ne bouge plus ensuite).
 */
export class GivreSnowGrid {
  private readonly tri: Float32Array; // 9 flottants par triangle
  private readonly start: Uint32Array; // triangles de la cellule c : items[start[c] .. start[c + 1] - 1]
  private readonly items: Uint32Array;
  private readonly x0: number;
  private readonly z0: number;
  private readonly nx: number;
  private readonly nz: number;

  constructor(
    meshes: readonly THREE.Mesh[],
    private readonly cell = 2,
  ) {
    const coords: number[] = [];
    const v = new THREE.Vector3();
    for (const mesh of meshes) {
      mesh.updateWorldMatrix(true, false);
      const pos = mesh.geometry.getAttribute('position');
      const index = mesh.geometry.getIndex();
      const n = index ? index.count : pos.count;
      for (let i = 0; i < n; i++) {
        v.fromBufferAttribute(pos, index ? index.getX(i) : i).applyMatrix4(mesh.matrixWorld);
        coords.push(v.x, v.y, v.z);
      }
    }
    const t = new Float32Array(coords);
    const count = t.length / 9;
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < t.length; i += 3) {
      minX = Math.min(minX, t[i]);
      maxX = Math.max(maxX, t[i]);
      minZ = Math.min(minZ, t[i + 2]);
      maxZ = Math.max(maxZ, t[i + 2]);
    }
    if (count === 0) {
      minX = minZ = 0;
      maxX = maxZ = cell;
    }
    this.tri = t;
    this.x0 = minX;
    this.z0 = minZ;
    this.nx = Math.max(1, Math.ceil((maxX - minX) / cell));
    this.nz = Math.max(1, Math.ceil((maxZ - minZ) / cell));
    const cells = this.nx * this.nz;
    const visit = (k: number, fn: (c: number) => void) => {
      const o = k * 9;
      const i0 = this.ix(Math.min(t[o], t[o + 3], t[o + 6]));
      const i1 = this.ix(Math.max(t[o], t[o + 3], t[o + 6]));
      const j0 = this.iz(Math.min(t[o + 2], t[o + 5], t[o + 8]));
      const j1 = this.iz(Math.max(t[o + 2], t[o + 5], t[o + 8]));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) fn(j * this.nx + i);
    };
    const start = new Uint32Array(cells + 1);
    for (let k = 0; k < count; k++) visit(k, (c) => start[c + 1]++);
    for (let c = 0; c < cells; c++) start[c + 1] += start[c];
    const items = new Uint32Array(start[cells]);
    const fill = start.slice(0, cells);
    for (let k = 0; k < count; k++) visit(k, (c) => (items[fill[c]++] = k));
    this.start = start;
    this.items = items;
  }

  private ix(x: number): number {
    return Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.x0) / this.cell)));
  }

  private iz(z: number): number {
    return Math.min(this.nz - 1, Math.max(0, Math.floor((z - this.z0) / this.cell)));
  }

  /**
   * Hauteur de la plus haute surface de neige a la verticale de (x, z) entre yMin et yMax, ou null s'il n'y en a pas.
   * `normal` recoit la normale (tournee vers le haut) du triangle trouve.
   */
  heightAt(x: number, z: number, yMin: number, yMax: number, normal: THREE.Vector3): number | null {
    if (x < this.x0 || z < this.z0 || x > this.x0 + this.nx * this.cell || z > this.z0 + this.nz * this.cell) {
      return null;
    }
    const t = this.tri;
    const c = this.iz(z) * this.nx + this.ix(x);
    let best: number | null = null;
    for (let k = this.start[c]; k < this.start[c + 1]; k++) {
      const o = this.items[k] * 9;
      const ax = t[o], ay = t[o + 1], az = t[o + 2];
      const bx = t[o + 3], by = t[o + 4], bz = t[o + 5];
      const qx = t[o + 6], qy = t[o + 7], qz = t[o + 8];
      const det = (bz - qz) * (ax - qx) + (qx - bx) * (az - qz);
      if (Math.abs(det) < 1e-12) continue; // triangle vertical
      const l1 = ((bz - qz) * (x - qx) + (qx - bx) * (z - qz)) / det;
      const l2 = ((qz - az) * (x - qx) + (ax - qx) * (z - qz)) / det;
      const l3 = 1 - l1 - l2;
      if (l1 < 0 || l2 < 0 || l3 < 0) continue;
      const y = l1 * ay + l2 * by + l3 * qy;
      if (y < yMin || y > yMax || (best !== null && y <= best)) continue;
      best = y;
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = qx - ax, vy = qy - ay, vz = qz - az;
      normal.set(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx).normalize();
      if (normal.y < 0) normal.negate();
    }
    return best;
  }
}

export interface GivreFootprintsOptions {
  /** Duree d'un pas pour track() : un pas tous les max(minStep, vitesse x strideSeconds) metres. */
  strideSeconds?: number;
}

interface Walker {
  last: THREE.Vector3;
  travelled: number;
  right: boolean;
}

export class GivreFootprints {
  readonly mesh: THREE.InstancedMesh;
  readonly grid: GivreSnowGrid;
  private readonly material: THREE.ShaderMaterial;
  private readonly birth: THREE.InstancedBufferAttribute;
  private readonly mirror: THREE.InstancedBufferAttribute;
  private readonly walkers = new Map<string, Walker>();
  private readonly pool: number;
  private next = 0;
  private readonly size: [number, number];
  private readonly lateral: number;
  private readonly minStep: number;
  private readonly lift: number;
  private readonly cosMaxSlope: number;
  private readonly strideSeconds: number;
  // temporaires
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly n = new THREE.Vector3();
  private readonly qAlign = new THREE.Quaternion();
  private readonly qYaw = new THREE.Quaternion();
  private readonly m = new THREE.Matrix4();
  private readonly s = new THREE.Vector3();
  private readonly p = new THREE.Vector3();
  private readonly side = new THREE.Vector3();

  /**
   * @param texture assets/givre_empreinte.png charge avec TextureLoader (pied droit vu de dessus, orteils en haut,
   *   alpha = forme du pied). Le constructeur regle lui-meme l'espace de couleur.
   * @param snowSurfaces meshes de neige du visuel (GivreVisual.snowSurfaces), deja places dans la scene.
   */
  constructor(phys: GivrePhysics, texture: THREE.Texture, snowSurfaces: readonly THREE.Mesh[], opts: GivreFootprintsOptions = {}) {
    const cfg = phys.footprints;
    if (!cfg) throw new Error('Givre : section footprints absente du JSON');
    this.size = cfg.size;
    this.lateral = cfg.lateralOffset;
    this.minStep = cfg.minStep;
    this.lift = cfg.heightAboveSurface;
    this.cosMaxSlope = Math.cos(THREE.MathUtils.degToRad(cfg.maxSlopeDeg));
    this.strideSeconds = opts.strideSeconds ?? 0.28;
    this.pool = cfg.poolSize;
    this.grid = new GivreSnowGrid(snowSurfaces);

    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.needsUpdate = true;

    // quad 1 x 1 a plat (normale +Y), orteils (haut de l'image) vers -Z = l'avant d'un Object3D
    const geom = new THREE.PlaneGeometry(1, 1);
    geom.rotateX(-Math.PI / 2);
    this.birth = new THREE.InstancedBufferAttribute(new Float32Array(this.pool).fill(-1e9), 1);
    this.mirror = new THREE.InstancedBufferAttribute(new Float32Array(this.pool).fill(1), 1);
    this.birth.setUsage(THREE.DynamicDrawUsage);
    this.mirror.setUsage(THREE.DynamicDrawUsage);
    geom.setAttribute('aBirth', this.birth);
    geom.setAttribute('aMirror', this.mirror);

    // couleur de base de la neige : celle du materiau du glb (lineaire), sinon celle du JSON
    const first = snowSurfaces[0]?.material;
    const snowMat = (Array.isArray(first) ? first[0] : first) as THREE.MeshStandardMaterial | undefined;
    const snow = snowMat?.color ? snowMat.color.clone() : new THREE.Color(phys.materials.GIV_Neige?.baseColorHex ?? '#f4f5f9');

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: texture },
        uTime: { value: 0 },
        uFull: { value: cfg.fullSeconds },
        uGone: { value: cfg.goneSeconds },
        uSnow: { value: new THREE.Vector3(snow.r, snow.g, snow.b) },
      },
      vertexShader: FOOT_VERTEX,
      fragmentShader: FOOT_FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      // couleur finale = couleur de l'image deja rendue x couleur du decalque
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.DstColorFactor,
      blendDst: THREE.ZeroFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -4,
    });

    this.mesh = new THREE.InstancedMesh(geom, this.material, this.pool);
    this.mesh.name = 'givre_empreintes';
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < this.pool; i++) this.mesh.setMatrixAt(i, zero);
    this.mesh.count = 0; // grandit jusqu'a poolSize au fil des pas
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.renderOrder = -10; // premier des objets transparents, juste apres le sol opaque
    this.mesh.userData.noOutline = true;
  }

  /**
   * Pose une empreinte si le sol sous le pied est de la neige.
   * @param foot position du pied au sol, en coordonnees monde (pour un joueur : centre de la capsule - 0,93 m)
   * @param yaw cap du personnage en radians (convention Object3D.rotation.y, avant = -Z local)
   * @param right pied droit (sinon gauche, en miroir)
   * @param now temps de jeu en secondes, le meme que pour update()
   */
  stamp(foot: THREE.Vector3, yaw: number, right: boolean, now: number): boolean {
    // leger desordre, comme dans l'apercu Blender : +/- 1,5 cm et +/- 5 degres
    const x = foot.x + (Math.random() - 0.5) * 0.03;
    const z = foot.z + (Math.random() - 0.5) * 0.03;
    const y = this.grid.heightAt(x, z, foot.y - SEARCH_BELOW, foot.y + SEARCH_ABOVE, this.n);
    if (y === null || this.n.y < this.cosMaxSlope) return false;

    const i = this.next;
    this.next = (i + 1) % this.pool;
    this.mesh.count = Math.max(this.mesh.count, i + 1);
    const jitter = THREE.MathUtils.degToRad((Math.random() - 0.5) * 10);
    this.qYaw.setFromAxisAngle(this.up, yaw + jitter);
    this.qAlign.setFromUnitVectors(this.up, this.n).multiply(this.qYaw);
    this.p.set(x, y, z).addScaledVector(this.n, this.lift);
    this.s.set(this.size[0], 1, this.size[1]);
    this.m.compose(this.p, this.qAlign, this.s);
    this.mesh.setMatrixAt(i, this.m);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.birth.setX(i, now);
    this.birth.needsUpdate = true;
    this.mirror.setX(i, right ? 1 : -1);
    this.mirror.needsUpdate = true;
    return true;
  }

  /**
   * Suivi automatique d'un personnage, a appeler a chaque image pour chaque joueur visible (le local et les
   * distants) avec la position de ses pieds. Pose un pas tous les max(minStep, vitesse x strideSeconds) metres
   * parcourus au sol, en alternant les pieds de part et d'autre de la trajectoire. Pour un joueur distant dont on
   * ne connait pas l'etat au sol, passer grounded = true : la fenetre verticale de stamp() evite deja les
   * empreintes en plein saut. Si le jeu a deja des evenements de pas (sons de pas), appeler plutot stamp().
   */
  track(id: string, feet: THREE.Vector3, grounded: boolean, now: number, dt: number): void {
    let w = this.walkers.get(id);
    if (!w) {
      w = { last: feet.clone(), travelled: 0, right: true };
      this.walkers.set(id, w);
      return;
    }
    const dx = feet.x - w.last.x;
    const dz = feet.z - w.last.z;
    const d = Math.hypot(dx, dz);
    if (!grounded || d > 5) {
      // en l'air, ou teleportation (reapparition) : on repart de zero
      w.last.copy(feet);
      w.travelled = 0;
      return;
    }
    w.travelled += d;
    const speed = dt > 0 ? d / dt : 0;
    const stride = Math.max(this.minStep, speed * this.strideSeconds);
    if (d > 1e-4 && w.travelled >= stride) {
      w.travelled = 0;
      const yaw = Math.atan2(-dx, -dz);
      // (-dz, dx) / d = droite de la marche ; pied droit a droite, pied gauche a gauche
      this.side.set(-dz / d, 0, dx / d).multiplyScalar(w.right ? this.lateral : -this.lateral);
      this.p.copy(feet).add(this.side);
      this.stamp(this.p, yaw, w.right, now);
      w.right = !w.right;
    }
    w.last.copy(feet);
  }

  /** A appeler quand un joueur quitte la partie ou n'est plus suivi. */
  forget(id: string): void {
    this.walkers.delete(id);
  }

  /** Efface toutes les empreintes (changement de manche, retour au menu). */
  clear(): void {
    this.birth.array.fill(-1e9);
    this.birth.needsUpdate = true;
    this.mesh.count = 0;
    this.next = 0;
    this.walkers.clear();
  }

  /** A chaque image, avec le meme temps que stamp() et track(). */
  update(now: number): void {
    this.material.uniforms.uTime.value = now;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
