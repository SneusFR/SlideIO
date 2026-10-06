import * as THREE from "three";

/**
 * Frisbee HUD mechanism — geometry + materials of the little 3D launcher fork
 * drawn on the left edge of the Frisbee plate (see FrisbeeMechanism.ts).
 * Built ONCE, shared by every mesh (all discs share one geometry / material).
 *
 * Units: 1 world unit ≈ 1 plate pixel (the plate is authored at 170 × 72 and
 * zoomed by CSS). Y up, origin on the axis of the disc column, +z = camera.
 *
 *        (cap)            (cap)     ← orange caps on turquoise / ivory arms
 *           ╲   ▭▭▭▭▭▭   ╱          ← seated disc, held by the navy cords
 *            │  ▭▭▭▭▭▭  │           ← the stack (next discs)
 *            ╰─╲▭▭▭▭▭▭╱─╯           ← the well (the cage): discs rise out of it
 *                 ║║                ← turquoise handle, ivory wraps
 *                 ●                 ← orange pommel
 */
export const FRISBEE_HUD_COLORS = {
  orange: 0xff8a3d,
  orangeDeep: 0xd9622a,
  yellow: 0xffc845,
  ivory: 0xf6ecd6,
  ivoryShade: 0xcfc0a2,
  turquoise: 0x22b8b0,
  navy: 0x1f2a55,
} as const;

const C = FRISBEE_HUD_COLORS;

export const DISC_R = 13;
export const DISC_T = 4.2;
/** Visible slots of the column (disc centres), top first. Slot 2 sits half inside the well. */
export const SLOT_Y = [2.2, -2.9, -8.0] as const;
/** Inside the well: entering discs come from here, leaving discs sink here. */
export const HIDDEN_Y = -11.4;
/** The top disc lifts into the cords once it is seated on the deck. */
export const SEAT_LIFT = 1.6;
/** Arm pivot (right side, x mirrored) and cap centre at rest. */
export const ARM_PIVOT = new THREE.Vector3(16.2, -11.5, 0);
export const CAP_POS = new THREE.Vector3(19.0, 9.6, 0);
/** Radius of the cord band around the seated disc. */
export const BAND_R = 13.8;

type Profile = ReadonlyArray<readonly [r: number, y: number, color: number]>;

/** Revolved profile with one colour per profile point (a sharp colour edge = two close points). */
function latheColored(profile: Profile, segments: number, yOffset = 0): THREE.LatheGeometry {
  const pts = profile.map(([r, y]) => new THREE.Vector2(r, y + yOffset));
  const geo = new THREE.LatheGeometry(pts, segments);
  const n = pts.length;
  const count = geo.attributes.position.count;
  const colors = new Float32Array(count * 3);
  const c = new THREE.Color();
  for (let v = 0; v < count; v++) {
    c.setHex(profile[v % n][2]); // vertex index = segment * points + point
    colors[v * 3] = c.r;
    colors[v * 3 + 1] = c.g;
    colors[v * 3 + 2] = c.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geo;
}

/**
 * The disc: thick, rounded rim (the edge), slightly dished top inside a raised
 * lip, hollow underside. Orange with a yellow ring and an ivory centre; the
 * underside is a deeper orange so a tilt reads at once.
 * Profile: underside centre → inner cavity → rim → top centre (outward normals).
 */
function discGeometry(): THREE.LatheGeometry {
  const top = (r: number) => 3.5 + 0.6 * (r / 11.2) ** 2;
  const profile: Profile = [
    [0, 2.25, C.orangeDeep],
    [5.5, 2.2, C.orangeDeep],
    [9.4, 1.95, C.orangeDeep],
    [10.25, 1.45, C.orangeDeep],
    [10.6, 0.65, C.orangeDeep],
    [11.0, 0.12, C.orange],
    [11.8, 0.0, C.orange],
    [12.5, 0.3, C.orange],
    [12.9, 1.0, C.orange],
    [13.0, 2.0, C.orange],
    [12.9, 3.0, C.orange],
    [12.5, 3.7, C.orange],
    [11.9, 4.15, C.orange],
    [11.2, top(11.2), C.orange],
    [10.3, top(10.3), C.orange],
    [9.5, top(9.5), C.orange],
    [9.3, top(9.3), C.yellow],
    [8.5, top(8.5), C.yellow],
    [7.7, top(7.7), C.yellow],
    [7.5, top(7.5), C.orange],
    [6.0, top(6.0), C.orange],
    [4.3, top(4.3), C.orange],
    [4.1, top(4.1), C.ivory],
    [2.4, top(2.4), C.ivory],
    [0, top(0), C.ivory],
  ];
  return latheColored(profile, 48, -DISC_T / 2);
}

/** The well (the cage): open cup, turquoise foot, ivory upper wall and rim, shaded inside. */
function wellGeometry(): THREE.LatheGeometry {
  const profile: Profile = [
    [0, -15.2, C.turquoise],
    [13.6, -15.2, C.turquoise],
    [14.6, -14.9, C.turquoise],
    [15.0, -14.2, C.turquoise],
    [15.0, -10.6, C.turquoise],
    [15.0, -10.45, C.ivory],
    [15.0, -8.0, C.ivory],
    [14.85, -7.2, C.ivory],
    [14.4, -6.85, C.ivory],
    [13.9, -7.0, C.ivory],
    [13.6, -7.6, C.ivoryShade],
    [13.6, -13.4, C.ivoryShade],
    [13.2, -14.0, C.ivoryShade],
    [0, -14.0, C.ivoryShade],
  ];
  return latheColored(profile, 48);
}

/** Paint a tube's vertices by their position along the path (u = 0 → 1). */
function colorTube(geo: THREE.TubeGeometry, colorAt: (u: number) => number): void {
  const { tubularSegments, radialSegments } = geo.parameters;
  const count = geo.attributes.position.count;
  const colors = new Float32Array(count * 3);
  const c = new THREE.Color();
  for (let i = 0; i <= tubularSegments; i++) {
    c.setHex(colorAt(i / tubularSegments));
    for (let j = 0; j <= radialSegments; j++) {
      const v = i * (radialSegments + 1) + j;
      colors[v * 3] = c.r;
      colors[v * 3 + 1] = c.g;
      colors[v * 3 + 2] = c.b;
    }
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
}

/**
 * One arm of the fork in its PIVOT space (the pivot = where it leaves the
 * well): a turquoise tube bending outward then up, ivory collar + ivory wrap,
 * ending under the cap. The left arm is the same mesh rotated 180° about Y.
 */
function armGeometry(): THREE.TubeGeometry {
  const tip = CAP_POS.clone().sub(ARM_PIVOT);
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-1.4, -0.6, 0),
    new THREE.Vector3(1.2, 3.2, 0),
    new THREE.Vector3(2.9, 9.0, 0),
    new THREE.Vector3(3.2, 14.5, 0),
    new THREE.Vector3(tip.x, tip.y - 2.2, 0),
  ]);
  const geo = new THREE.TubeGeometry(curve, 40, 2.05, 12, false);
  colorTube(geo, (u) => (u < 0.13 || (u > 0.6 && u < 0.71) ? C.ivory : C.turquoise));
  return geo;
}

/** Handle under the well: turquoise grip with two ivory wraps. */
function handleGeometry(): THREE.LatheGeometry {
  const profile: Profile = [
    [0, -26.0, C.turquoise],
    [2.7, -25.6, C.turquoise],
    [2.9, -23.4, C.turquoise],
    [3.15, -23.2, C.ivory],
    [3.15, -21.6, C.ivory],
    [2.9, -21.4, C.turquoise],
    [2.9, -19.6, C.turquoise],
    [3.15, -19.4, C.ivory],
    [3.15, -17.8, C.ivory],
    [2.9, -17.6, C.turquoise],
    [3.6, -15.6, C.turquoise],
    [0, -15.2, C.turquoise],
  ];
  return latheColored(profile, 24);
}

/** Everything the mechanism draws, built once. dispose() frees every GPU resource. */
export class FrisbeeHudKit {
  readonly disc = discGeometry();
  readonly well = wellGeometry();
  readonly arm = armGeometry();
  readonly handle = handleGeometry();
  readonly cap = new THREE.SphereGeometry(2.75, 20, 14);
  readonly pommel = new THREE.SphereGeometry(3.5, 20, 14);

  /** Satin opaque plastic: no metal, a soft clear coat, restrained highlights. */
  readonly plastic = new THREE.MeshPhysicalMaterial({
    vertexColors: true,
    roughness: 0.46,
    metalness: 0,
    clearcoat: 0.28,
    clearcoatRoughness: 0.5,
  });
  readonly capPlastic = new THREE.MeshPhysicalMaterial({
    color: C.orange,
    roughness: 0.42,
    metalness: 0,
    clearcoat: 0.3,
    clearcoatRoughness: 0.45,
  });
  /** Elastic cords: matte navy rubber. */
  readonly cord = new THREE.MeshStandardMaterial({ color: C.navy, roughness: 0.78, metalness: 0 });

  /** A fading copy of the disc plastic (one per ejected disc: each fades on its own clock). */
  ejectMaterial(): THREE.MeshPhysicalMaterial {
    const m = this.plastic.clone();
    m.transparent = true;
    return m;
  }

  dispose(): void {
    for (const g of [this.disc, this.well, this.arm, this.handle, this.cap, this.pommel]) g.dispose();
    for (const m of [this.plastic, this.capPlastic, this.cord]) m.dispose();
  }
}

/**
 * Elastic cord: a tube whose path is rewritten IN PLACE (fixed vertex count,
 * no allocation per frame). `update()` takes `points.length === samples`.
 */
export class CordTube {
  readonly geometry = new THREE.BufferGeometry();
  private readonly pos: Float32Array;
  private readonly nor: Float32Array;
  private readonly t = new THREE.Vector3();
  private readonly n = new THREE.Vector3();
  private readonly b = new THREE.Vector3();
  private readonly ref = new THREE.Vector3();

  constructor(
    readonly samples: number,
    private readonly radius: number,
    private readonly radial = 6,
  ) {
    const ring = radial + 1;
    this.pos = new Float32Array(samples * ring * 3);
    this.nor = new Float32Array(samples * ring * 3);
    const idx: number[] = [];
    for (let i = 0; i < samples - 1; i++) {
      for (let j = 0; j < radial; j++) {
        const a = i * ring + j;
        const b = (i + 1) * ring + j;
        idx.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    this.geometry.setIndex(idx);
    this.geometry.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute("normal", new THREE.BufferAttribute(this.nor, 3).setUsage(THREE.DynamicDrawUsage));
  }

  update(points: readonly THREE.Vector3[]): void {
    const { samples, radial, radius } = this;
    const ring = radial + 1;
    for (let i = 0; i < samples; i++) {
      const p = points[i];
      const a = points[Math.max(0, i - 1)];
      const c = points[Math.min(samples - 1, i + 1)];
      this.t.subVectors(c, a).normalize();
      this.ref.set(0, 1, 0);
      if (Math.abs(this.t.y) > 0.9) this.ref.set(0, 0, 1);
      this.n.crossVectors(this.ref, this.t).normalize();
      this.b.crossVectors(this.t, this.n);
      for (let j = 0; j < ring; j++) {
        const ang = (j / radial) * Math.PI * 2;
        const cs = Math.cos(ang);
        const sn = Math.sin(ang);
        const nx = this.n.x * cs + this.b.x * sn;
        const ny = this.n.y * cs + this.b.y * sn;
        const nz = this.n.z * cs + this.b.z * sn;
        const k = (i * ring + j) * 3;
        this.nor[k] = nx;
        this.nor[k + 1] = ny;
        this.nor[k + 2] = nz;
        this.pos[k] = p.x + nx * radius;
        this.pos[k + 1] = p.y + ny * radius;
        this.pos[k + 2] = p.z + nz * radius;
      }
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.normal.needsUpdate = true;
    this.geometry.computeBoundingSphere();
  }

  dispose(): void {
    this.geometry.dispose();
  }
}

