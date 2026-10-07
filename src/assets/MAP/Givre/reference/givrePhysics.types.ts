// Types du fichier data/givre_01.physics.json (format "givre.physics.v1").
// Toutes les coordonnees sont en metres, repere three.js : Y vers le haut, nord = -Z, est = +X.

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

interface GivreColliderBase {
  /** Identifiant unique, ex. "COL_BAT_P1_00" ou "CLIP_Toit_P1". */
  id: string;
  /** Nom de l'objet Blender d'origine (ex. "BAT_P1", "SALLE_Stock_Murs"). */
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

/** Enveloppe convexe (rampes, garde-corps, bloc central octogonal, conduites). */
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
  sun: {
    directionToSun: Vec3;
    colorHex: string;
    blenderStrength: number;
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
  interiors: string;
}

export interface GivreMaterialInfo {
  baseColorHex: string;
  roughness?: number;
  emissiveHex?: string;
  emissiveStrength?: number;
}

export interface GivrePhysics {
  format: 'givre.physics.v1';
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
  /** Volumes qui bloquent uniquement les joueurs (pas les tirs). */
  playerClips: GivreCollider[];
  ramps: GivreRamp[];
  spawns: GivreSpawn[];
  hazards: unknown[];
  zones: GivreZone[];
  viewpoints: GivreViewpoint[];
  lighting: GivreLighting;
  materials: Record<string, GivreMaterialInfo>;
  stats: Record<string, number>;
}
