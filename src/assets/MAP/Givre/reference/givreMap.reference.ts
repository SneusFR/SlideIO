// Code de reference pour integrer Givre (three.js + Rapier).
// A ADAPTER aux conventions du projet : chemins d'assets, chargement, boucle de jeu et moteur physique
// existent deja pour Yard. Si le projet n'utilise pas Rapier, reprendre seulement la logique
// (boites alignees, enveloppes convexes, volumes "playerClip" qui ne bloquent que les joueurs).
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { GivreCollider, GivrePhysics, GivreSpawn } from './givrePhysics.types';

// ---------------------------------------------------------------- donnees

export async function loadGivrePhysics(url: string): Promise<GivrePhysics> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Givre : impossible de charger ${url} (${res.status})`);
  const data = (await res.json()) as GivrePhysics;
  if (data.format !== 'givre.physics.v1') throw new Error(`Givre : format inattendu ${data.format}`);
  return data;
}

// ---------------------------------------------------------------- visuel

export interface GivreVisualOptions {
  /** Fusionne les meshes statiques par materiau (~15 draw calls au lieu de ~225). */
  merge?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
}

/** Charge assets/givre_01.glb. Les objets sont deja en metres, Y vers le haut. */
export async function loadGivreVisual(url: string, opts: GivreVisualOptions = {}): Promise<THREE.Group> {
  const { merge = true, castShadow = true, receiveShadow = true } = opts;
  const gltf = await new GLTFLoader().loadAsync(url);
  const root = gltf.scene;
  root.updateMatrixWorld(true);

  if (!merge) {
    root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = castShadow;
        o.receiveShadow = receiveShadow;
      }
    });
    return root;
  }

  // Une primitive glTF = un Mesh three.js avec un seul materiau, partage entre primitives.
  const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const material = mesh.material as THREE.Material;
    const geom = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
    for (const name of Object.keys(geom.attributes)) {
      if (name !== 'position' && name !== 'normal') geom.deleteAttribute(name);
    }
    const list = byMaterial.get(material) ?? [];
    list.push(geom);
    byMaterial.set(material, list);
  });

  const group = new THREE.Group();
  group.name = 'givre_01';
  for (const [material, geoms] of byMaterial) {
    const merged = mergeGeometries(geoms, false);
    if (!merged) throw new Error(`Givre : fusion impossible pour ${material.name}`);
    const mesh = new THREE.Mesh(merged, material);
    mesh.name = `givre_${material.name}`;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = receiveShadow;
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
    geoms.forEach((g) => g.dispose());
  }
  return group;
}

/** Charge assets/givre_01_fond.glb (plaine + montagnes, hors limites, sans ombre ni collision). */
export async function loadGivreBackground(url: string): Promise<THREE.Group> {
  const gltf = await new GLTFLoader().loadAsync(url);
  gltf.scene.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = false;
      o.receiveShadow = false;
    }
  });
  return gltf.scene;
}

// ---------------------------------------------------------------- rendu

/** Reglages proches du rendu Blender (couleurs en aplats, pas de tone mapping). */
export function configureRendererForGivre(renderer: THREE.WebGLRenderer): void {
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
}

/**
 * Ciel en degrade (sphere a couleurs de sommets). Centrer la sphere sur la camera a chaque image
 * (sky.position.copy(camera.position)) et garder camera.far > radius.
 */
export function createGivreSky(phys: GivrePhysics, radius = 6000): THREE.Mesh {
  const stops = phys.lighting.skyBackground.stops.map(([t, hex]) => ({ t, c: new THREE.Color(hex) }));
  const geometry = new THREE.SphereGeometry(radius, 48, 24);
  const pos = geometry.getAttribute('position');
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
    colors.set([c.r, c.g, c.b], i * 3);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const sky = new THREE.Mesh(geometry, material);
  sky.name = 'givre_sky';
  sky.renderOrder = -1;
  sky.frustumCulled = false;
  sky.userData.noOutline = true; // ignore par GivreOutlinePass
  return sky;
}

export interface GivreLightOptions {
  /** Intensite du soleil ; defaut = force Blender (lumieres physiques three.js r155+). */
  sunIntensity?: number;
  /** Intensite de l'ambiance hemisphere ; defaut = PI x force Blender. */
  hemiIntensity?: number;
  shadowMapSize?: number;
  /** Demi-largeur de la camera d'ombre (la map fait 280 m de cote). */
  shadowExtent?: number;
}

export function createGivreLights(phys: GivrePhysics, opts: GivreLightOptions = {}): THREE.Group {
  const {
    sunIntensity = phys.lighting.sun.blenderStrength,
    hemiIntensity = Math.PI * phys.lighting.ambient.blenderStrength,
    shadowMapSize = 4096,
    shadowExtent = 150,
  } = opts;
  const group = new THREE.Group();
  group.name = 'givre_lights';

  const hemi = new THREE.HemisphereLight(
    phys.lighting.ambient.skyColorHex,
    phys.lighting.ambient.groundColorHex,
    hemiIntensity,
  );
  group.add(hemi);

  const sun = new THREE.DirectionalLight(phys.lighting.sun.colorHex, sunIntensity);
  const toSun = new THREE.Vector3(...phys.lighting.sun.directionToSun).normalize();
  sun.position.copy(toSun.multiplyScalar(300));
  sun.target.position.set(0, 0, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(shadowMapSize, shadowMapSize);
  const cam = sun.shadow.camera;
  cam.left = -shadowExtent;
  cam.right = shadowExtent;
  cam.top = shadowExtent;
  cam.bottom = -shadowExtent;
  cam.near = 1;
  cam.far = 700;
  cam.updateProjectionMatrix();
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.05;
  group.add(sun, sun.target);
  return group;
}

// ---------------------------------------------------------------- physique (Rapier)

/** Groupes de collision Rapier : 16 bits d'appartenance (poids fort) + 16 bits de filtre. */
export function interactionGroups(membership: number, filter: number): number {
  return ((membership & 0xffff) << 16) | (filter & 0xffff);
}

export interface GivreRapierGroups {
  /** Colliders solides : bloquent joueurs et tirs. */
  solid?: number;
  /**
   * playerClips : ne doivent bloquer que le controleur de personnage.
   * Ex. interactionGroups(GROUP_CLIP, GROUP_PLAYER) et exclure GROUP_CLIP du filtre des raycasts d'armes.
   */
  playerClip?: number;
}

function colliderDesc(rapier: typeof RAPIER, c: GivreCollider, groups?: number): RAPIER.ColliderDesc {
  let desc: RAPIER.ColliderDesc | null;
  if (c.shape === 'box') {
    desc = rapier.ColliderDesc.cuboid(c.halfExtents[0], c.halfExtents[1], c.halfExtents[2]).setTranslation(
      c.center[0],
      c.center[1],
      c.center[2],
    );
  } else {
    desc = rapier.ColliderDesc.convexHull(new Float32Array(c.points.flat()));
    if (!desc) throw new Error(`Givre : enveloppe convexe invalide pour ${c.id}`);
  }
  if (groups !== undefined) desc.setCollisionGroups(groups);
  return desc;
}

/** Cree les colliders fixes de Givre (sans corps rigide = attaches au monde). */
export function buildGivreRapierColliders(
  rapier: typeof RAPIER,
  world: RAPIER.World,
  phys: GivrePhysics,
  groups: GivreRapierGroups = {},
): { solids: RAPIER.Collider[]; clips: RAPIER.Collider[] } {
  const solids = phys.colliders.map((c) => world.createCollider(colliderDesc(rapier, c, groups.solid)));
  const clips = phys.playerClips.map((c) => world.createCollider(colliderDesc(rapier, c, groups.playerClip)));
  return { solids, clips };
}

// ---------------------------------------------------------------- outils de jeu

/** Spawn le plus eloigne des autres joueurs (aleatoire si personne). */
export function pickGivreSpawn(phys: GivrePhysics, others: ReadonlyArray<{ x: number; z: number }>): GivreSpawn {
  if (others.length === 0) return phys.spawns[Math.floor(Math.random() * phys.spawns.length)];
  let best = phys.spawns[0];
  let bestScore = -Infinity;
  for (const s of phys.spawns) {
    const score = Math.min(...others.map((p) => Math.hypot(p.x - s.position[0], p.z - s.position[2])));
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best;
}

/** Nom de la zone sous une position (callouts, minimap). La galerie (Y = 6) passe avant le sol. */
export function givreZoneAt(phys: GivrePhysics, x: number, y: number, z: number): string | null {
  const hits = phys.zones.filter((zn) => x >= zn.min[0] && x <= zn.max[0] && z >= zn.min[1] && z <= zn.max[1]);
  if (hits.length === 0) return null;
  hits.sort((a, b) => Math.abs(y - a.floorY) - Math.abs(y - b.floorY));
  return hits[0].name;
}

/** Fil de fer des colliders (magenta) et des playerClips (cyan), masque par defaut. */
export function createGivreColliderDebug(phys: GivrePhysics): THREE.Group {
  const group = new THREE.Group();
  group.name = 'givre_colliders_debug';
  group.visible = false;
  group.userData.noOutline = true; // ignore par GivreOutlinePass
  const solidMat = new THREE.MeshBasicMaterial({ color: 0xff2fd0, wireframe: true });
  const clipMat = new THREE.MeshBasicMaterial({ color: 0x2fd0ff, wireframe: true });
  const add = (c: GivreCollider, mat: THREE.Material) => {
    let geom: THREE.BufferGeometry;
    if (c.shape === 'box') {
      geom = new THREE.BoxGeometry(c.halfExtents[0] * 2, c.halfExtents[1] * 2, c.halfExtents[2] * 2);
      geom.translate(c.center[0], c.center[1], c.center[2]);
    } else {
      geom = new ConvexGeometry(c.points.map((p) => new THREE.Vector3(p[0], p[1], p[2])));
    }
    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = c.id;
    group.add(mesh);
  };
  phys.colliders.forEach((c) => add(c, solidMat));
  phys.playerClips.forEach((c) => add(c, clipMat));
  return group;
}
