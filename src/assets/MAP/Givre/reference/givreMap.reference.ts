// Code de reference pour integrer Givre v3 (three.js r155+ + Rapier).
// A ADAPTER aux conventions du projet : chemins d'assets, chargement, boucle de jeu et moteur physique
// existent deja (Givre est deja integre). Les changements de la v3 sont marques "v3".
//
// v3 en bref :
//  - le glb porte la lumiere precalculee (emissiveMap + aoMap sur l'attribut uv) : il faut GARDER l'attribut
//    `uv` lors de la fusion des meshes statiques ;
//  - 141 noeuds sont animes (vapeur, fumees, guirlandes, bannieres, chaudiere, aiguilles...) : ils ne sont pas
//    fusionnes, une seule animation glTF de 8 s les fait bouger en boucle (AnimationMixer) ; les 95 bouffees de
//    fumee et de vapeur partagent 6 geometries et passent en InstancedMesh (95 -> 6 appels de rendu) ;
//  - nouvelle ambiance (soleil bas, ciel plus profond) lue dans le JSON, comme avant ;
//  - halos des ampoules (sprites additifs) et vacillement du foyer.
// La neige et les empreintes sont dans givreSnow.reference.ts et givreFootprints.reference.ts.
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
  /** Fusionne les meshes statiques par materiau (~25 draw calls au lieu de ~290). */
  merge?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
  /**
   * v3 : coupe les mipmaps des deux images de lumiere precalculee (moins de memoire, pas de bavure entre ilots
   * de la carte UV au loin). Mettre false si le sol scintille au loin.
   */
  lightmapNoMipmaps?: boolean;
  /**
   * v3 : les noeuds animes qui partagent geometrie et materiau (au moins 4 : les bouffees de fumee et de vapeur)
   * sont dessines par un InstancedMesh ; les noeuds restent animes par le mixer, mais invisibles.
   */
  instanceRepeated?: boolean;
}

export interface GivreVisual {
  /** A ajouter a la scene. Contient les meshes fusionnes et les noeuds animes. */
  root: THREE.Group;
  /** Animations de la map (null si le glb n'en a pas). */
  mixer: THREE.AnimationMixer | null;
  /** Noeuds animes, par nom (les halos des guirlandes s'y accrochent). */
  animatedNodes: Map<string, THREE.Object3D>;
  /** Meshes dont le materiau est de la neige (GIV_Neige) : cible des empreintes. */
  snowSurfaces: THREE.Mesh[];
  /** Materiaux par nom (ex. 'GIV_Feu' pour le vacillement du foyer). */
  materials: Map<string, THREE.Material>;
  /** A appeler a chaque image (dt en secondes). */
  update(dt: number): void;
  dispose(): void;
}

const KEEP_ATTRIBUTES = new Set(['position', 'normal', 'uv']); // v3 : `uv` porte la lumiere precalculee

/** Charge assets/givre_01.glb. Les objets sont deja en metres, Y vers le haut. */
export async function loadGivreVisual(url: string, opts: GivreVisualOptions = {}): Promise<GivreVisual> {
  const { merge = true, castShadow = true, receiveShadow = true, lightmapNoMipmaps = true, instanceRepeated = true } = opts;
  const gltf = await new GLTFLoader().loadAsync(url);
  const scene = gltf.scene;
  scene.updateMatrixWorld(true);

  // v3 : noeuds animes = cibles des pistes d'animation, avec leurs enfants
  const animatedNodes = new Map<string, THREE.Object3D>();
  const animated = new Set<THREE.Object3D>();
  for (const clip of gltf.animations) {
    for (const track of clip.tracks) {
      const { nodeName } = THREE.PropertyBinding.parseTrackName(track.name);
      const node = scene.getObjectByName(nodeName);
      if (!node || animatedNodes.has(node.name)) continue;
      animatedNodes.set(node.name, node);
      node.traverse((o) => animated.add(o));
    }
  }

  const materials = new Map<string, THREE.Material>();
  const lightmapTextures = new Set<THREE.Texture>();
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      materials.set(m.name, m);
      const std = m as THREE.MeshStandardMaterial;
      if (std.emissiveMap) lightmapTextures.add(std.emissiveMap);
      if (std.aoMap) lightmapTextures.add(std.aoMap);
    }
  });
  if (lightmapNoMipmaps) {
    for (const t of lightmapTextures) {
      t.generateMipmaps = false;
      t.minFilter = THREE.LinearFilter;
      t.needsUpdate = true;
    }
  }

  // noeuds animes : pas d'ombre portee (vapeur, fumees et petites pieces), materiaux transparents sans ecriture
  // de profondeur (GLTFLoader le fait deja pour les materiaux BLEND)
  for (const node of animatedNodes.values()) {
    node.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = false;
      mesh.receiveShadow = receiveShadow;
    });
  }

  const root = new THREE.Group();
  root.name = 'givre_01';
  const snowSurfaces: THREE.Mesh[] = [];

  if (!merge) {
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || animated.has(mesh)) return;
      mesh.castShadow = castShadow;
      mesh.receiveShadow = receiveShadow;
      if ((mesh.material as THREE.Material).name === 'GIV_Neige') snowSurfaces.push(mesh);
    });
    root.add(scene);
  } else {
    // Une primitive glTF = un Mesh three.js avec un seul materiau, partage entre primitives.
    const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>();
    const staticMeshes: THREE.Mesh[] = [];
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || animated.has(mesh)) return;
      staticMeshes.push(mesh);
      const material = mesh.material as THREE.Material;
      const geom = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
      for (const name of Object.keys(geom.attributes)) {
        if (!KEEP_ATTRIBUTES.has(name)) geom.deleteAttribute(name);
      }
      // objet en miroir (echelle negative) : inverser l'ordre des sommets, sinon il serait vu de l'interieur
      // une fois fusionne (aucun dans ce glb, mais garder la protection pour les prochains exports)
      if (mesh.matrixWorld.determinant() < 0 && geom.index) {
        const idx = geom.index.array;
        for (let i = 0; i < idx.length; i += 3) {
          const tmp = idx[i + 1];
          idx[i + 1] = idx[i + 2];
          idx[i + 2] = tmp;
        }
      }
      const list = byMaterial.get(material) ?? [];
      list.push(geom);
      byMaterial.set(material, list);
    });
    // retire les meshes statiques du glb. S'ils ont des enfants (noeud anime, repere FX), un Object3D vide prend
    // leur place avec la meme transformation locale : les pistes d'animation, exprimees dans le repere du parent,
    // restent justes (attach() les fausserait).
    for (const mesh of staticMeshes) {
      const parent = mesh.parent;
      if (!parent) continue;
      if (mesh.children.length > 0) {
        const holder = new THREE.Object3D();
        holder.name = mesh.name;
        holder.position.copy(mesh.position);
        holder.quaternion.copy(mesh.quaternion);
        holder.scale.copy(mesh.scale);
        parent.add(holder);
        for (const child of [...mesh.children]) holder.add(child);
      }
      parent.remove(mesh);
    }
    for (const [material, geoms] of byMaterial) {
      const merged = mergeGeometries(geoms, false);
      if (!merged) throw new Error(`Givre : fusion impossible pour ${material.name}`);
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, material);
      mesh.name = `givre_${material.name}`;
      mesh.castShadow = castShadow && !(material as THREE.MeshStandardMaterial).transparent;
      mesh.receiveShadow = receiveShadow;
      mesh.matrixAutoUpdate = false;
      root.add(mesh);
      if (material.name === 'GIV_Neige') snowSurfaces.push(mesh);
      geoms.forEach((g) => g.dispose());
    }
    root.add(scene); // il ne reste dans scene que les noeuds animes et les reperes FX (empties)
  }

  // v3 : animations (une seule animation glTF de 8 s, toutes les pistes en boucle depuis t = 0)
  let mixer: THREE.AnimationMixer | null = null;
  if (gltf.animations.length > 0) {
    mixer = new THREE.AnimationMixer(scene);
    for (const clip of gltf.animations) {
      mixer.clipAction(clip).setLoop(THREE.LoopRepeat, Infinity).play();
    }
  }

  // v3 (perf) : noeuds animes identiques (meme geometrie, meme materiau, sans enfant) -> un InstancedMesh par
  // groupe. GLTFLoader partage deja la geometrie entre les noeuds qui utilisent le meme mesh glTF.
  const instanced: { mesh: THREE.InstancedMesh; sources: THREE.Mesh[] }[] = [];
  if (instanceRepeated) {
    const groups = new Map<string, THREE.Mesh[]>();
    for (const node of animatedNodes.values()) {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh || mesh.children.length > 0 || Array.isArray(mesh.material)) continue;
      const key = `${mesh.geometry.uuid}/${mesh.material.uuid}`;
      const list = groups.get(key) ?? [];
      list.push(mesh);
      groups.set(key, list);
    }
    for (const sources of groups.values()) {
      if (sources.length < 4) continue;
      const first = sources[0];
      const im = new THREE.InstancedMesh(first.geometry, first.material, sources.length);
      im.name = `givre_instances_${first.name}`;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.frustumCulled = false; // les instances bougent : pas de sphere englobante fiable
      im.castShadow = false;
      im.receiveShadow = first.receiveShadow;
      for (const s of sources) s.visible = false; // toujours animes par le mixer, plus dessines
      root.add(im);
      instanced.push({ mesh: im, sources });
    }
  }
  const rootInverse = new THREE.Matrix4();
  const tmp = new THREE.Matrix4();

  return {
    root,
    mixer,
    animatedNodes,
    snowSurfaces,
    materials,
    update(dt: number) {
      mixer?.update(dt);
      if (instanced.length > 0) {
        scene.updateMatrixWorld(); // matrices des noeuds animes a jour avant la copie
        rootInverse.copy(root.matrixWorld).invert();
        for (const { mesh, sources } of instanced) {
          for (let i = 0; i < sources.length; i++) {
            mesh.setMatrixAt(i, tmp.multiplyMatrices(rootInverse, sources[i].matrixWorld));
          }
          mesh.instanceMatrix.needsUpdate = true;
        }
      }
    },
    dispose() {
      mixer?.stopAllAction();
      for (const { mesh } of instanced) mesh.dispose();
      root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) mesh.geometry.dispose();
      });
      for (const m of materials.values()) m.dispose();
      for (const t of lightmapTextures) t.dispose();
    },
  };
}

/** Charge assets/givre_01_fond.glb (plaine + montagnes, hors limites, sans ombre ni collision). Inchange. */
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

/** Reglages proches du rendu Blender (couleurs en aplats, pas de tone mapping). Inchange. */
export function configureRendererForGivre(renderer: THREE.WebGLRenderer): void {
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
}

/**
 * Ciel en degrade (sphere a couleurs de sommets). Inchange : les nouvelles couleurs viennent du JSON.
 * Centrer la sphere sur la camera a chaque image (sky.position.copy(camera.position)) et garder camera.far > radius.
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
  /** Plus grand cote de la carte d'ombre ; l'autre cote est reduit selon la forme de la map vue du soleil. */
  shadowMapSize?: number;
  /**
   * v3 (remplace shadowExtent) : boite a couvrir d'ombres, la camera d'ombre s'y ajuste. Defaut : l'enveloppe de
   * la map, de Y = -1 a 21 m (haut du decor statique).
   */
  shadowBounds?: THREE.Box3;
  /** v3 : soleil bas (17 degres), ombres longues : biais un peu plus forts qu'avant. */
  shadowBias?: number;
  shadowNormalBias?: number;
}

/**
 * Soleil + ambiance, valeurs du JSON : soleil bas et dore a l'ouest-sud-ouest, ambiance plus bleue et plus faible.
 * L'aoMap du glb eteint l'ambiance dans les salles et sous la halle : c'est la lumiere precalculee (emissif) qui
 * les eclaire, sans aucune lampe en direct. v3 : seule la camera d'ombre change (ajustee a la map).
 */
export function createGivreLights(phys: GivrePhysics, opts: GivreLightOptions = {}): THREE.Group {
  const {
    sunIntensity = phys.lighting.sun.blenderStrength,
    hemiIntensity = Math.PI * phys.lighting.ambient.blenderStrength,
    shadowMapSize = 4096,
    shadowBias = -0.0006,
    shadowNormalBias = 0.08,
  } = opts;
  const env = phys.envelope;
  const bounds =
    opts.shadowBounds ??
    new THREE.Box3(new THREE.Vector3(env.min[0], -1, env.min[1]), new THREE.Vector3(env.max[0], 21, env.max[1]));
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
  const center = bounds.getCenter(new THREE.Vector3()).setY(0);
  sun.target.position.copy(center);
  sun.position.copy(center).addScaledVector(toSun, 300);
  sun.castShadow = true;

  // v3 : camera d'ombre ajustee a la map vue du soleil. Avec le soleil bas, l'ancien carre de +/-150 m centre sur
  // l'origine laissait une bande d'environ 40 m sans ombre au nord-ouest (Stock) ; vue du soleil, la map fait
  // ~340 x 125 m,
  // d'ou une carte d'ombre rectangulaire (4096 x 2048 par defaut : moitie moins de memoire que 4096 x 4096).
  const cam = sun.shadow.camera;
  cam.position.copy(sun.position);
  cam.lookAt(center);
  cam.updateMatrixWorld(true);
  const box = new THREE.Box3();
  const corner = new THREE.Vector3();
  for (let i = 0; i < 8; i++) {
    corner.set(i & 1 ? bounds.max.x : bounds.min.x, i & 2 ? bounds.max.y : bounds.min.y, i & 4 ? bounds.max.z : bounds.min.z);
    box.expandByPoint(corner.applyMatrix4(cam.matrixWorldInverse));
  }
  const margin = 2;
  cam.left = box.min.x - margin;
  cam.right = box.max.x + margin;
  cam.bottom = box.min.y - margin;
  cam.top = box.max.y + margin;
  cam.near = Math.max(0.5, -box.max.z - 10); // la camera regarde vers -Z
  cam.far = -box.min.z + 10;
  cam.updateProjectionMatrix();
  const w = cam.right - cam.left;
  const h = cam.top - cam.bottom;
  sun.shadow.mapSize.set(
    Math.min(shadowMapSize, 2 ** Math.ceil(Math.log2(shadowMapSize * Math.min(1, w / h)))),
    Math.min(shadowMapSize, 2 ** Math.ceil(Math.log2(shadowMapSize * Math.min(1, h / w)))),
  );
  sun.shadow.bias = shadowBias;
  sun.shadow.normalBias = shadowNormalBias;
  group.add(sun, sun.target);
  return group;
}

// ---------------------------------------------------------------- v3 : halos des ampoules

const HALO_VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute float aRadius;
attribute vec3 aColor;
attribute float aIntensity;
uniform float uViewportHeight;
varying vec3 vColor;
varying float vIntensity;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  // diametre (2 x rayon) en metres -> pixels, comme un sprite de taille fixe dans le monde
  gl_PointSize = clamp(aRadius * projectionMatrix[1][1] * uViewportHeight / max(-mv.z, 0.01), 0.0, 256.0);
  vColor = aColor;
  vIntensity = aIntensity;
  #include <logdepthbuf_vertex>
}
`;

const HALO_FRAGMENT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec3 vColor;
varying float vIntensity;
void main() {
  #include <logdepthbuf_fragment>
  float r = length(gl_PointCoord - 0.5) * 2.0;
  float f = pow(clamp(1.0 - r, 0.0, 1.0), 3.0) * vIntensity;
  if (f < 0.002) discard;
  gl_FragColor = vec4(vColor * f, 1.0);
  #include <colorspace_fragment>
}
`;

export interface GivreHalos {
  objects: THREE.Points[];
  /** A appeler a chaque image (et au redimensionnement) avec la hauteur du canvas en pixels. */
  update(viewportHeightPx: number): void;
  dispose(): void;
}

function haloPoints(
  points: { radius: number; type: string; xyz: [number, number, number] }[],
  phys: GivrePhysics,
  material: THREE.ShaderMaterial,
): THREE.Points {
  const n = points.length;
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const rad = new Float32Array(n);
  const inten = new Float32Array(n);
  const c = new THREE.Color();
  points.forEach((p, i) => {
    const t = phys.halos!.types[p.type];
    pos.set(p.xyz, i * 3);
    c.set(t.colorHex); // sRGB -> lineaire (gestion des couleurs de three.js)
    col.set([c.r, c.g, c.b], i * 3);
    rad[i] = p.radius;
    inten[i] = t.intensity;
  });
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geom.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  geom.setAttribute('aRadius', new THREE.BufferAttribute(rad, 1));
  geom.setAttribute('aIntensity', new THREE.BufferAttribute(inten, 1));
  geom.computeBoundingSphere();
  const obj = new THREE.Points(geom, material);
  obj.userData.noOutline = true;
  obj.castShadow = false;
  obj.receiveShadow = false;
  obj.renderOrder = 10;
  return obj;
}

/**
 * Halos additifs autour des ampoules et des lanternes (647 points, 15 appels de rendu) : un Points en
 * coordonnees monde pour les sources fixes, un Points enfant de chaque guirlande animee.
 */
export function createGivreHalos(phys: GivrePhysics, visual: GivreVisual): GivreHalos {
  const material = new THREE.ShaderMaterial({
    uniforms: { uViewportHeight: { value: 1080 } },
    vertexShader: HALO_VERTEX,
    fragmentShader: HALO_FRAGMENT,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
  });
  const objects: THREE.Points[] = [];
  const halos = phys.halos;
  if (halos) {
    const fixed = halos.static.map((p) => ({ radius: p.radius, type: p.type, xyz: p.position }));
    if (fixed.length) {
      const pts = haloPoints(fixed, phys, material);
      pts.name = 'givre_halos';
      visual.root.add(pts);
      objects.push(pts);
    }
    for (const group of halos.nodes) {
      const node = visual.animatedNodes.get(group.node) ?? visual.root.getObjectByName(group.node);
      if (!node) {
        console.warn(`Givre : noeud ${group.node} introuvable pour les halos`);
        continue;
      }
      const pts = haloPoints(
        group.points.map((p) => ({ radius: p.radius, type: p.type, xyz: p.local })),
        phys,
        material,
      );
      pts.name = `givre_halos_${group.node}`;
      node.add(pts); // suit le balancement de la guirlande
      objects.push(pts);
    }
  }
  return {
    objects,
    update(viewportHeightPx: number) {
      material.uniforms.uViewportHeight.value = viewportHeightPx;
    },
    dispose() {
      for (const o of objects) {
        o.removeFromParent();
        o.geometry.dispose();
      }
      material.dispose();
    },
  };
}

// ---------------------------------------------------------------- v3 : vacillement du foyer (sans lumiere en direct)

/**
 * La lueur du foyer de la chaudiere est deja dans la lumiere precalculee. Ce petit effet fait seulement vaciller
 * l'emissif du feu (materiau GIV_Feu) entre 2 et 6 Hz, plus fort aux pulsations de la boucle (1, 3, 5 et 7 s).
 */
export function createGivreFireFlicker(visual: GivreVisual): (elapsedSeconds: number) => void {
  const fire = visual.materials.get('GIV_Feu') as THREE.MeshStandardMaterial | undefined;
  if (!fire) return () => {};
  const base = fire.emissiveIntensity;
  return (t: number) => {
    const loop = t % 8;
    const pulse = Math.max(0, 1 - Math.abs((loop % 2) - 1) / 0.25); // pics a 1, 3, 5 et 7 s
    const n = 0.5 * Math.sin(t * 2 * Math.PI * 2.3) + 0.3 * Math.sin(t * 2 * Math.PI * 5.7 + 1.3) + 0.2 * Math.sin(t * 2 * Math.PI * 3.1 + 2.1);
    fire.emissiveIntensity = base * (0.85 + 0.15 * n + 0.35 * pulse);
  };
}

// ---------------------------------------------------------------- physique (Rapier), inchange

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

/** Cree les colliders fixes de Givre (sans corps rigide = attaches au monde). v3 : des clips peuvent etre convexes. */
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

// ---------------------------------------------------------------- outils de jeu, inchanges

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

/** Nom de la zone sous une position (callouts). La galerie (Y = 6) passe avant le sol. */
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
