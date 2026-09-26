import * as THREE from "three";

/**
 * Popcorns tirés — PUREMENT VISUEL (les dégâts viennent des raycasts gameplay).
 * UNE instance pour tout le monde (joueur local + joueurs distants) : un seul InstancedMesh qui
 * réutilise la géométrie du popcorn du réservoir (Popcorn_Template, 100 triangles, couleurs de
 * sommets) avec un clone léger du matériau (émission crème : lisible dans les zones sombres).
 * 1 draw call, aucune allocation par frame.
 *
 * Cycle (SlideIO v3) : VOL très rapide façon plombs (180 m/s, étiré en courte traînée le long
 * de la trajectoire, grossit en sortant du canon) → REBOND le long de
 * la normale → CHUTE jusqu'au sol (hauteur fournie par l'appelant pour un impact mur /
 * personnage) → AU SOL ~2 s → rétrécit. Un plomb qui ne touche rien disparaît à portée max.
 *
 * Coût au repos : un popcorn posé garde sa matrice en cache ; le buffer d'instances n'est
 * reconstruit et envoyé au GPU que si au moins un popcorn bouge ou change d'état.
 */
const MAX = 512;            // 12 plombs × ~40 tirs en vol / au sol (le plus ancien est recyclé)
const SPEED = 180;          // m/s visuels, façon plombs : 10 m en 0,06 s, 40 m en 0,22 s (dégâts instantanés)
const STREAK = 4.5;         // en vol, le popcorn s'étire en traînée le long de sa trajectoire (× longueur)…
const STREAK_MAX = 0.9;     // …plafonnée à 0,9 m et jamais plus longue que le chemin déjà parcouru
const STREAK_WIDTH = 0.8;   // section de la traînée (× taille du popcorn)
const SIZE = 0.45;          // échelle de la géométrie (≈ 0,24 u) → popcorn ≈ 11 cm
const SIZE_JITTER = 0.15;   // ±15 % de taille
const MUZZLE_GROW = 1.5;    // m : grossit de 30 % à 100 % sur les premiers mètres de vol
const FAR_BONUS = 0.015;    // +1,5 % d'échelle par mètre de distance à la caméra…
const FAR_BONUS_MAX = 1.5;  // …plafonné à ×1,5 (lisible au loin)
const SPIN_MIN = 6, SPIN_MAX = 14; // rad/s : roulis de la traînée en vol, tumble à la chute
const GRAVITY = 9.81;
const FALL_MAX_TIME = 1.2;  // s : pas de sol trouvé → le popcorn disparaît après ça
const REST_TIME = 2.0;      // s posé au sol
const SHRINK_TIME = 0.3;    // s : disparition finale
const RECYCLE_TIME = 0.1;   // s : disparition express quand le pool est plein
const MISS_FADE = 0.12;     // s : plomb qui n'a rien touché → disparaît à portée max
const REST_LIFT = 0.04;     // m : centre du popcorn au-dessus du sol (≈ rayon)
const FLOOR_NORMAL_Y = 0.6; // normale.y ≥ ça : le plan d'impact EST le sol
const NO_FLOOR = -1e9;

const St = { Free: 0, Flight: 1, Fall: 2, Rest: 3, Shrink: 4, Miss: 5 } as const;

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _dq = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _ax = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _Z = new THREE.Vector3(0, 0, 1);
const _roll = new THREE.Quaternion();

export class PopcornProjectiles {
  readonly mesh: THREE.InstancedMesh;
  private readonly material: THREE.Material;
  private readonly a = new Float32Array(MAX * 3);   // départ (bouche du canon)
  private readonly b = new Float32Array(MAX * 3);   // arrivée (impact ou portée max)
  private readonly x = new Float32Array(MAX * 3);   // position (chute / sol)
  private readonly v = new Float32Array(MAX * 3);   // vitesse (chute)
  private readonly floorY = new Float32Array(MAX);  // hauteur du sol (NO_FLOOR = aucun)
  private readonly rot = new Float32Array(MAX * 4);
  private readonly spin = new Float32Array(MAX * 4); // axe (xyz) + vitesse angulaire
  private readonly mat = new Float32Array(MAX * 16); // matrice en cache (popcorns posés)
  private readonly t = new Float32Array(MAX);
  private readonly dur = new Float32Array(MAX);
  private readonly size = new Float32Array(MAX);
  private readonly shrinkFrom = new Float32Array(MAX); // échelle au début de la disparition
  private readonly bounce = new Float32Array(MAX * 3); // vitesse de rebond (normale + hasard)
  private readonly hit = new Uint8Array(MAX);
  /** 1 tant que le popcorn n'a pas encore été dessiné en vol (visible ≥ 1 frame, même de près). */
  private readonly fresh = new Uint8Array(MAX);
  private readonly st = new Uint8Array(MAX);
  private next = 0;
  private live = 0;
  /** L'ensemble dessiné doit être reconstruit (spawn, mouvement, changement d'état). */
  private dirty = false;
  private readonly cam = new THREE.Vector3();
  private hasCam = false;

  /**
   * template = shotgun.tank.popcornMesh : géométrie PARTAGÉE (rien n'est cloné), matériau
   * cloné une fois (émission crème) — le réservoir de l'arme garde le sien.
   */
  constructor(template: THREE.Mesh, parent: THREE.Object3D) {
    const src = Array.isArray(template.material) ? template.material[0] : template.material;
    this.material = src.clone();
    const std = this.material as THREE.MeshStandardMaterial;
    if (std.isMeshStandardMaterial) {
      std.emissive = new THREE.Color(0xfff1c9);
      std.emissiveIntensity = 0.22;
    }
    this.mesh = new THREE.InstancedMesh(template.geometry, this.material, MAX);
    this.mesh.name = "PopcornProjectiles";
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.raycast = () => {}; // jamais touché par les raycasts gameplay
    this.mesh.count = 0;
    parent.add(this.mesh);
  }

  /** Popcorns actifs (en vol, au sol ou en disparition). */
  get activeCount(): number {
    return this.live;
  }

  /** Position de la caméra de jeu (bonus d'échelle au loin). Appeler avant update(). */
  setCamera(position: THREE.Vector3): void {
    this.cam.copy(position);
    this.hasCam = true;
  }

  /**
   * from      : bouche du canon en coordonnées MONDE
   * to[i]     : point d'impact du plomb i (ou point à portée max s'il n'a rien touché)
   * normal[i] : normale MONDE de la surface touchée, ou null si le plomb n'a rien touché
   * floor[i]  : (optionnel) hauteur Y du sol sous un impact MUR / PERSONNAGE (raycast vers le
   *             bas fait par l'appelant) ; null = sol non trouvé. Ignoré quand la surface
   *             touchée est elle-même un sol (normale.y ≥ 0,6 : le point d'impact sert de sol).
   */
  spawn(
    from: THREE.Vector3,
    to: readonly THREE.Vector3[],
    normal: readonly (THREE.Vector3 | null)[],
    floor?: readonly (number | null)[],
  ): void {
    for (let k = 0; k < to.length; k++) {
      const i = this.next;
      this.next = (this.next + 1) % MAX;
      if (this.st[i] === St.Free) this.live++;
      else this.recycleNext(); // pool plein : le plus ancien restant part plus vite
      const i3 = i * 3, i4 = i * 4, e = to[k], nk = normal[k];
      this.a[i3] = from.x; this.a[i3 + 1] = from.y; this.a[i3 + 2] = from.z;
      this.b[i3] = e.x; this.b[i3 + 1] = e.y; this.b[i3 + 2] = e.z;
      this.hit[i] = nk ? 1 : 0;
      if (nk) {
        // Sol : le point d'impact est le sol. Mur / personnage : sol fourni (ou aucun).
        const f = floor?.[k];
        this.floorY[i] = nk.y >= FLOOR_NORMAL_Y ? e.y : f === null || f === undefined ? NO_FLOOR : f;
        const up = 1.0 + Math.random() * 1.2, side = 0.7;
        this.bounce[i3] = nk.x * up + (Math.random() - 0.5) * side;
        this.bounce[i3 + 1] = nk.y * up + 0.8 + Math.random() * 0.6;
        this.bounce[i3 + 2] = nk.z * up + (Math.random() - 0.5) * side;
      }
      this.dur[i] = Math.max(0.005, from.distanceTo(e) / SPEED);
      this.t[i] = 0;
      this.st[i] = St.Flight;
      this.fresh[i] = 1;
      this.size[i] = SIZE * (1 + SIZE_JITTER * (2 * Math.random() - 1));
      _q.random();
      this.rot[i4] = _q.x; this.rot[i4 + 1] = _q.y; this.rot[i4 + 2] = _q.z; this.rot[i4 + 3] = _q.w;
      _ax.randomDirection();
      this.spin[i4] = _ax.x; this.spin[i4 + 1] = _ax.y; this.spin[i4 + 2] = _ax.z;
      this.spin[i4 + 3] = SPIN_MIN + Math.random() * (SPIN_MAX - SPIN_MIN);
    }
    this.dirty = true;
  }

  /** Pool plein : le prochain slot à recycler (le plus ancien restant) disparaît en 0,1 s. */
  private recycleNext(): void {
    const j = this.next;
    if (this.st[j] === St.Rest) {
      this.shrinkFrom[j] = this.size[j];
      this.st[j] = St.Shrink;
      this.t[j] = SHRINK_TIME - RECYCLE_TIME;
      this.dirty = true;
    }
  }

  /** Échelle d'affichage : bonus de lisibilité au loin (distance à la caméra de jeu). */
  private farScale(x: number, y: number, z: number): number {
    if (!this.hasCam) return 1;
    const dx = x - this.cam.x, dy = y - this.cam.y, dz = z - this.cam.z;
    return Math.min(FAR_BONUS_MAX, 1 + FAR_BONUS * Math.sqrt(dx * dx + dy * dy + dz * dz));
  }

  /** Rotation propre (tumble) — en vol et en chute seulement. */
  private tumble(i4: number, dt: number, rate: number): void {
    _q.set(this.rot[i4], this.rot[i4 + 1], this.rot[i4 + 2], this.rot[i4 + 3]);
    _ax.set(this.spin[i4], this.spin[i4 + 1], this.spin[i4 + 2]);
    _q.multiply(_dq.setFromAxisAngle(_ax, this.spin[i4 + 3] * rate * dt));
    this.rot[i4] = _q.x; this.rot[i4 + 1] = _q.y; this.rot[i4 + 2] = _q.z; this.rot[i4 + 3] = _q.w;
  }

  private writeMatrix(i: number, x: number, y: number, z: number, scale: number): void {
    const i4 = i * 4;
    _p.set(x, y, z);
    _q.set(this.rot[i4], this.rot[i4 + 1], this.rot[i4 + 2], this.rot[i4 + 3]);
    _s.setScalar(Math.max(scale * this.farScale(x, y, z), 1e-4));
    _m.compose(_p, _q, _s).toArray(this.mat, i * 16);
  }

  /**
   * Vol : traînée étirée le long de la trajectoire (axe Z local → direction de vol), roulis
   * propre autour de cet axe. La traînée est centrée DERRIÈRE la tête du popcorn : elle ne
   * dépasse jamais l'impact et ne sort jamais en arrière du canon.
   */
  private writeStreak(i: number, hx: number, hy: number, hz: number, travelled: number, size: number): void {
    const i3 = i * 3, i4 = i * 4;
    _dir.set(this.b[i3] - this.a[i3], this.b[i3 + 1] - this.a[i3 + 1], this.b[i3 + 2] - this.a[i3 + 2]);
    const len = _dir.length();
    if (len < 1e-6) {
      this.writeMatrix(i, hx, hy, hz, size);
      return;
    }
    _dir.multiplyScalar(1 / len);
    const far = this.farScale(hx, hy, hz);
    const width = size * STREAK_WIDTH * far;
    // longueur monde de la traînée (le popcorn fait ≈ 0,24 u × scale)
    const streakM = Math.min(STREAK_MAX, travelled, size * 0.24 * STREAK);
    const lengthScale = Math.max(width, streakM / 0.24);
    _p.set(hx, hy, hz).addScaledVector(_dir, -streakM * 0.5);
    _q.setFromUnitVectors(_Z, _dir);
    _roll.setFromAxisAngle(_Z, this.spin[i4 + 3] * this.t[i] * 3 + this.spin[i4] * 6.283);
    _q.multiply(_roll);
    _s.set(width, width, lengthScale);
    _m.compose(_p, _q, _s).toArray(this.mat, i * 16);
  }

  private free(i: number): void {
    this.st[i] = St.Free;
    this.live--;
    this.dirty = true;
  }


  /** Une fois par frame, après les spawns de la frame (même dt pour tout le monde). */
  update(dt: number): void {
    if (this.live === 0) {
      if (this.mesh.count !== 0) {
        this.mesh.count = 0;
        this.mesh.instanceMatrix.needsUpdate = true;
      }
      return;
    }
    if (dt <= 0 && !this.dirty) return;
    for (let i = 0; i < MAX; i++) {
      const state = this.st[i];
      if (state === St.Free) continue;
      const i3 = i * 3, i4 = i * 4;
      const t = (this.t[i] += dt);

      if (state === St.Flight) {
        const T = this.dur[i];
        // Vol très rapide (façon plombs) : un tir proche peut arriver en moins d'une frame.
        // La PREMIÈRE frame est bornée à 60 % du trajet → chaque popcorn est vu en vol au
        // moins une frame (≤ 16 ms de plus, purement visuel : les dégâts sont déjà appliqués).
        if (this.fresh[i]) {
          this.fresh[i] = 0;
          if (t >= T) this.t[i] = 0.6 * T;
        }
        const tt = this.t[i];
        const u = Math.min(1, tt / T);
        const ax = this.a[i3], ay = this.a[i3 + 1], az = this.a[i3 + 2];
        const bx = this.b[i3], by = this.b[i3 + 1], bz = this.b[i3 + 2];
        const px = ax + (bx - ax) * u;
        const py = ay + (by - ay) * u;
        const pz = az + (bz - az) * u;
        // grossit en sortant du canon : 30 % → 100 % sur les MUZZLE_GROW premiers mètres
        const travelled = SPEED * Math.min(tt, T);
        const grow = Math.min(1, 0.3 + (0.7 * travelled) / MUZZLE_GROW);
        if (u < 1) this.writeStreak(i, px, py, pz, travelled, this.size[i] * grow);
        else this.writeMatrix(i, px, py, pz, this.size[i]); // impact : redevient un popcorn
        this.dirty = true;
        if (u >= 1) {
          this.t[i] = 0;
          if (this.hit[i]) {
            // impact : petit rebond le long de la normale, puis chute vers le sol
            this.x[i3] = bx + this.bounce[i3] * 0.01;
            this.x[i3 + 1] = by + this.bounce[i3 + 1] * 0.01;
            this.x[i3 + 2] = bz + this.bounce[i3 + 2] * 0.01;
            this.v[i3] = this.bounce[i3]; this.v[i3 + 1] = this.bounce[i3 + 1]; this.v[i3 + 2] = this.bounce[i3 + 2];
            this.st[i] = St.Fall;
          } else {
            this.st[i] = St.Miss;
          }
        }
      } else if (state === St.Fall) {
        this.v[i3 + 1] -= GRAVITY * dt;
        let px = this.x[i3] + this.v[i3] * dt;
        let py = this.x[i3 + 1] + this.v[i3 + 1] * dt;
        let pz = this.x[i3 + 2] + this.v[i3 + 2] * dt;
        const ground = this.floorY[i] + REST_LIFT;
        if (this.v[i3 + 1] < 0 && py <= ground && this.floorY[i] > NO_FLOOR) {
          // posé : se couche, n'évolue plus (matrice en cache jusqu'à la disparition)
          py = ground;
          this.st[i] = St.Rest;
          this.t[i] = 0;
        } else if (t >= FALL_MAX_TIME) {
          // aucun sol sous l'impact (vide, rebord) : disparaît en tombant
          this.shrinkFrom[i] = this.size[i];
          this.st[i] = St.Shrink;
          this.t[i] = 0;
        } else {
          this.v[i3] *= 1 - 0.6 * dt; this.v[i3 + 2] *= 1 - 0.6 * dt; // traînée légère
          this.tumble(i4, dt, 0.7);
        }
        this.x[i3] = px; this.x[i3 + 1] = py; this.x[i3 + 2] = pz;
        this.writeMatrix(i, px, py, pz, this.size[i]);
        this.dirty = true;
      } else if (state === St.Rest) {
        if (t >= REST_TIME) {
          this.shrinkFrom[i] = this.size[i];
          this.st[i] = St.Shrink;
          this.t[i] = 0;
        }
        // matrice inchangée : rien à écrire
      } else if (state === St.Shrink) {
        if (t >= SHRINK_TIME) {
          this.free(i);
          continue;
        }
        const k = 1 - t / SHRINK_TIME;
        this.writeMatrix(i, this.x[i3], this.x[i3 + 1], this.x[i3 + 2], this.shrinkFrom[i] * k * k);
        this.dirty = true;
      } else {
        // Miss : disparaît à portée max
        if (t >= MISS_FADE) {
          this.free(i);
          continue;
        }
        this.x[i3] = this.b[i3]; this.x[i3 + 1] = this.b[i3 + 1]; this.x[i3 + 2] = this.b[i3 + 2];
        this.writeMatrix(i, this.b[i3], this.b[i3 + 1], this.b[i3 + 2], this.size[i] * (1 - t / MISS_FADE));
        this.dirty = true;
      }
    }
    if (!this.dirty) return; // tout est posé et immobile : aucun envoi GPU
    this.dirty = false;
    // Reconstruit la liste dessinée à partir des matrices en cache (copie brute, sans compose).
    const dst = this.mesh.instanceMatrix.array as Float32Array;
    let drawn = 0;
    for (let i = 0; i < MAX; i++) {
      if (this.st[i] === St.Free) continue;
      dst.set(this.mat.subarray(i * 16, i * 16 + 16), drawn * 16);
      drawn++;
    }
    this.mesh.count = drawn;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Vide le pool (fin de partie / changement de mode). */
  clear(): void {
    this.st.fill(St.Free);
    this.live = 0;
    this.dirty = false;
    this.mesh.count = 0;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.dispose(); // ne libère PAS la géométrie partagée avec l'arme
    this.material.dispose(); // clone privé du pool
  }
}

