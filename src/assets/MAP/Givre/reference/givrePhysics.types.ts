// Types du fichier data/givre_01.physics.json (format "givre.physics.v1", version 3 du contenu).
// Toutes les coordonnees sont en metres, repere three.js : Y vers le haut, nord = -Z, est = +X.
// v3 : memes champs qu'avant (le chargement existant reste valable) + sections facultatives
// halos, fx, snow, footprints, animations et lighting.lightmap.

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

interface GivreColliderBase {
  /** Identifiant unique, ex. "COL_BAT_P1_00" ou "CLIP_Toit_P1". */
  id: string;
  /** Nom de l'objet Blender d'origine (ex. "BAT_P1", "PLACE_Chalets"). */
  source: string;
  /** Present uniquement dans playerClips : ces volumes ne bloquent que les joueurs. */
  blocks?: 'players';
  note?: string;
}

/** Boite alignee sur les axes (aucune rotation). */
export interface GivreBoxCollider extends GivreColliderBase {
  shape: 'box';
  center: Vec3;
  halfExtents: Vec3;
  min: Vec3;
  max: Vec3;
}

/** Enveloppe convexe (rampes, garde-corps, decor arrondi ou en biais). */
export interface GivreHullCollider extends GivreColliderBase {
  shape: 'convexHull';
  points: Vec3[];
}

export type GivreCollider = GivreBoxCollider | GivreHullCollider;

export interface GivreRamp {
  id: string;
  /** Collider convexHull correspondant dans `colliders`. */
  colliderId: string;
  /** Milieu du bord bas (Y = 0) et du bord haut (Y = 6). */
  lowCenter: Vec3;
  highCenter: Vec3;
  width: number;
  run: number;
  rise: number;
  slopeDeg: number;
}

export interface GivreSpawn {
  id: string;
  /** Centre de la capsule (pieds + 0,93 m). */
  position: Vec3;
  /** Point au sol sous la capsule. */
  feet: Vec3;
  /** Lacet en radians, convention Object3D.rotation.y (avant = -Z local). */
  yaw: number;
  /** Vecteur avant normalise (y = 0). */
  forward: Vec3;
  /** STOCK | CHAUFFERIE | VESTIBULE_SUD_OUEST | COUDE_EST */
  room: string;
}

export interface GivreZone {
  id: string;
  name: string;
  kind: 'interieur' | 'exterieur' | 'galerie' | 'rampe' | 'couvert';
  /** Hauteur du sol de la zone (0, ou 6 pour la galerie). */
  floorY: number;
  /** Rectangle en XZ. */
  min: Vec2;
  max: Vec2;
  axes: 'xz';
}

export interface GivreViewpoint {
  id: string;
  position: Vec3;
  lookAt: Vec3;
  horizontalFovDeg: number;
}

export interface GivreLighting {
  /** v3 : "fin_apres_midi". */
  preset?: string;
  sun: {
    directionToSun: Vec3;
    colorHex: string;
    blenderStrength: number;
    elevationDeg?: number;
    angularDiameterDeg: number;
    three: string;
  };
  ambient: {
    skyColorHex: string;
    horizonColorHex: string;
    groundColorHex: string;
    blenderStrength: number;
    three: string;
  };
  skyBackground: {
    /** [position 0..1, couleur sRGB] du bas (horizon) vers le zenith. */
    stops: [number, string][];
    mapping: string;
  };
  colorManagement: string;
  /** v3 : lumiere precalculee, deja branchee dans les materiaux du glb (emissiveMap + aoMap). */
  lightmap?: {
    uv: string;
    lumiere: string;
    ciel: string;
    echelle: number;
    resolution: number;
    note: string;
  };
  interiors: string;
}

export interface GivreMaterialInfo {
  baseColorHex: string;
  roughness?: number;
  emissiveHex?: string;
  emissiveStrength?: number;
}

/** Type de halo : rayon fixe (radius) ou proportionnel a la taille de l'ampoule (radiusFactorOfSize). */
export interface GivreHaloType {
  radius: number | null;
  radiusFactorOfSize: number | null;
  colorHex: string;
  intensity: number;
}

export interface GivreHaloPoint {
  type: 'chaude' | 'orange' | 'lanterne';
  /** Rayon du halo en m (deja calcule). */
  radius: number;
}

export interface GivreHalos {
  types: Record<string, GivreHaloType>;
  /** Ampoules et lanternes fixes, coordonnees monde. */
  static: (GivreHaloPoint & { position: Vec3 })[];
  /** Ampoules des guirlandes qui se balancent : coordonnees locales du noeud anime `node` du glb. */
  nodes: { node: string; points: (GivreHaloPoint & { local: Vec3 })[] }[];
  note: string;
}

/** Repere d'effet (lueur du foyer, sons). Les champs dependent de `fx`. */
export interface GivreFx {
  id: string;
  fx: 'lumiere_vacillante' | 'son' | string;
  position: Vec3;
  /** son : nom du son attendu (ex. "grondement_chaudiere"). */
  son?: string;
  /** son : 1 = en boucle. */
  boucle?: number;
  /** son : instants de declenchement dans la boucle de 8 s. */
  instants_s?: number[];
  periode_s?: number;
  duree_s?: number;
  portee_m?: number;
  /** lumiere_vacillante : couleur lineaire. */
  couleur?: Vec3;
  note?: string;
}

export interface GivreSnow {
  /** Boite de flocons centree sur la camera en XZ : [x, y, z] en m. */
  boxSize: Vec3;
  /** Bas de la boite (Y monde) ; le haut est yMin + boxSize[1]. */
  yMin: number;
  /** Flocons par m3 au niveau 'normale'. */
  density: number;
  countNormal: number;
  /** Diametre moyen d'un flocon (x 0,6 a 1,4). */
  flakeSize: number;
  /** Vitesse de chute moyenne (x 0,8 a 1,2 selon le flocon). */
  fallSpeed: number;
  /** Derive horizontale en m/s (repere three.js). */
  wind: Vec3;
  swayAmplitude: number;
  swayHz: number;
  /** Flocons caches a moins de cette distance de la camera. */
  minDistance: number;
  /** Multiplicateurs de densite (options graphiques). */
  levels: Record<string, number>;
  note: string;
  mask: string;
  maskMapping: {
    note: string;
    u: string;
    v: string;
    pixels: Vec2;
    metresParPixel: number;
    metresParNiveau: number;
  };
}

export interface GivreFootprints {
  /** [largeur, longueur] d'une empreinte en m. */
  size: Vec2;
  lateralOffset: number;
  minStep: number;
  heightAboveSurface: number;
  fullSeconds: number;
  goneSeconds: number;
  poolSize: number;
  surfaceMaterials: string[];
  maxSlopeDeg: number;
  image: string;
  note: string;
}

export interface GivreAnimations {
  loopSeconds: number;
  fps: number;
  animatedNodes: number;
  /** Noeuds du glb animes (a ne pas fusionner). */
  nodes: string[];
  note: string;
}

export interface GivrePhysics {
  format: 'givre.physics.v1';
  /** 3 pour ce paquet (absent avant). */
  version?: number;
  map: string;
  displayName: string;
  units: 'meters';
  coordinateSystem: Record<string, string>;
  /** Bornes XZ de la zone jouable (equivalent de expansion.mapEnvelope). */
  envelope: { min: Vec2; max: Vec2; axes: 'xz'; size: Vec2 };
  floorY: number;
  galleryY: number;
  killPlaneY: number;
  playerReference: {
    capsuleRadius: number;
    capsuleHalfHeight: number;
    capsuleHeight: number;
    spawnCenterHeight: number;
    note: string;
  };
  /** Collisions statiques solides (joueurs + tirs). */
  colliders: GivreCollider[];
  /** Volumes qui bloquent uniquement les joueurs (pas les tirs) : boites ou enveloppes convexes. */
  playerClips: GivreCollider[];
  ramps: GivreRamp[];
  spawns: GivreSpawn[];
  hazards: unknown[];
  zones: GivreZone[];
  viewpoints: GivreViewpoint[];
  lighting: GivreLighting;
  halos?: GivreHalos;
  fx?: GivreFx[];
  snow?: GivreSnow;
  footprints?: GivreFootprints;
  animations?: GivreAnimations;
  materials: Record<string, GivreMaterialInfo>;
  stats: Record<string, number>;
}
