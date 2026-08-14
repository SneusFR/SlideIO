import * as THREE from "three";

const BODY_COLORS = [0xd4a03b, 0x3bb0d4, 0x7ed43b, 0xd43b9a, 0xd4573b, 0x3bd4a8, 0x8a3bd4, 0xd4cf3b];

/**
 * Low-poly humanoid bot: head, torso, legs, arms and a mini Plasma Rifle.
 * Procedural animation (leg swing, bob, gun pitch) + world-space health bar.
 */
export class BotModel {
  readonly group = new THREE.Group();
  private readonly legL: THREE.Group;
  private readonly legR: THREE.Group;
  private readonly torso: THREE.Group;
  private readonly gunPivot: THREE.Group;
  private readonly muzzle: THREE.Object3D;
  private readonly healthBar: THREE.Group;
  private readonly healthFill: THREE.Mesh;
  private readonly healthFillMat: THREE.MeshBasicMaterial;
  private readonly bodyMat: THREE.MeshLambertMaterial;
  private readonly visorMat: THREE.MeshBasicMaterial;
  private readonly chestMat: THREE.MeshBasicMaterial;

  private walkPhase = Math.random() * 10;
  private flashAmount = 0;
  private readonly baseColor: THREE.Color;
  private readonly flashColor = new THREE.Color(0xffffff);
  private readonly tmpColor = new THREE.Color();

  constructor(index: number) {
    const color = BODY_COLORS[index % BODY_COLORS.length];
    this.baseColor = new THREE.Color(color);
    this.bodyMat = new THREE.MeshLambertMaterial({ color });
    const darkMat = new THREE.MeshLambertMaterial({ color: 0x2a2e38 });
    this.visorMat = new THREE.MeshBasicMaterial({ color: 0xc084fc });
    this.chestMat = new THREE.MeshBasicMaterial({ color: 0xa855f7 });

    const mesh = (g: THREE.BufferGeometry, m: THREE.Material) => {
      const me = new THREE.Mesh(g, m);
      me.castShadow = true;
      return me;
    };

    // Legs (pivot at hips, feet reach y -0.9)
    this.legL = new THREE.Group();
    this.legL.position.set(-0.12, -0.18, 0);
    const legGeoL = mesh(new THREE.BoxGeometry(0.15, 0.62, 0.18), darkMat);
    legGeoL.position.y = -0.35;
    this.legL.add(legGeoL);
    this.legR = new THREE.Group();
    this.legR.position.set(0.12, -0.18, 0);
    const legGeoR = mesh(new THREE.BoxGeometry(0.15, 0.62, 0.18), darkMat);
    legGeoR.position.y = -0.35;
    this.legR.add(legGeoR);

    // Torso + head + chest light
    this.torso = new THREE.Group();
    const chest = mesh(new THREE.BoxGeometry(0.48, 0.55, 0.26), this.bodyMat);
    chest.position.y = 0.14;
    const chestGlow = mesh(new THREE.BoxGeometry(0.2, 0.08, 0.02), this.chestMat);
    chestGlow.position.set(0, 0.22, -0.14);
    const head = mesh(new THREE.BoxGeometry(0.26, 0.26, 0.26), this.bodyMat);
    head.position.y = 0.58;
    const visor = mesh(new THREE.BoxGeometry(0.2, 0.07, 0.02), this.visorMat);
    visor.position.set(0, 0.6, -0.14);
    // Left arm (supports the rifle)
    const armL = mesh(new THREE.BoxGeometry(0.11, 0.4, 0.11), this.bodyMat);
    armL.position.set(-0.3, 0.12, -0.08);
    armL.rotation.x = -0.5;
    this.torso.add(chest, chestGlow, head, visor, armL);

    // Gun pivot at right shoulder — pitches toward the aim target.
    this.gunPivot = new THREE.Group();
    this.gunPivot.position.set(0.24, 0.28, 0);
    const armR = mesh(new THREE.BoxGeometry(0.11, 0.11, 0.4), this.bodyMat);
    armR.position.set(0, -0.06, -0.18);
    const gunBody = mesh(new THREE.BoxGeometry(0.09, 0.12, 0.55), darkMat);
    gunBody.position.set(0, 0, -0.42);
    const gunGlow = mesh(new THREE.BoxGeometry(0.03, 0.05, 0.3), this.chestMat);
    gunGlow.position.set(0, 0.07, -0.42);
    this.muzzle = new THREE.Object3D();
    this.muzzle.position.set(0, 0, -0.72);
    this.gunPivot.add(armR, gunBody, gunGlow, this.muzzle);

    this.group.add(this.legL, this.legR, this.torso, this.gunPivot);

    // ---- Health bar (billboarded, above the head) ----
    this.healthBar = new THREE.Group();
    this.healthBar.position.y = 1.15;
    const barBg = new THREE.Mesh(
      new THREE.PlaneGeometry(0.95, 0.11),
      new THREE.MeshBasicMaterial({ color: 0x14161c, transparent: true, opacity: 0.75 }),
    );
    this.healthFillMat = new THREE.MeshBasicMaterial({ color: 0x4ade80 });
    this.healthFill = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.07), this.healthFillMat);
    this.healthFill.position.z = 0.002;
    this.healthBar.add(barBg, this.healthFill);
    this.group.add(this.healthBar);
  }

  getMuzzleWorld(out: THREE.Vector3): THREE.Vector3 {
    return this.muzzle.getWorldPosition(out);
  }

  /** Trigger the damage flash (throttle-friendly: just refreshes intensity). */
  flash(): void {
    this.flashAmount = 1;
  }

  /**
   * @param speed     horizontal speed (drives legs)
   * @param yaw       body facing
   * @param pitch     gun aim pitch
   * @param sliding   true while the bot is sliding
   * @param hpRatio   0..1 health bar fill
   * @param camQuat   camera quaternion for billboarding
   * @param protectedNow spawn protection indicator
   */
  update(
    dt: number,
    speed: number,
    yaw: number,
    pitch: number,
    sliding: boolean,
    hpRatio: number,
    camQuat: THREE.Quaternion,
    protectedNow: boolean,
    time: number,
  ): void {
    this.group.rotation.y = yaw;

    // Legs + bob
    this.walkPhase += speed * dt * 1.7;
    const swing = Math.min(speed / 9.5, 1.4) * 0.65;
    this.legL.rotation.x = Math.sin(this.walkPhase) * swing;
    this.legR.rotation.x = -Math.sin(this.walkPhase) * swing;
    this.torso.position.y = Math.abs(Math.sin(this.walkPhase)) * 0.035;

    // Slide posture: lean back, crouch low.
    const targetTilt = sliding ? 0.55 : 0;
    this.torso.rotation.x = THREE.MathUtils.damp(this.torso.rotation.x, targetTilt, 12, dt);
    const targetY = sliding ? -0.32 : 0;
    this.torso.position.z = sliding ? 0.1 : 0;
    this.group.children.forEach(() => {}); // noop keeps shape stable
    this.torso.position.y += targetY * 0.5;

    this.gunPivot.rotation.x = pitch;

    // Damage flash on the body material.
    if (this.flashAmount > 0) {
      this.flashAmount = Math.max(0, this.flashAmount - dt * 5);
      this.tmpColor.lerpColors(this.baseColor, this.flashColor, this.flashAmount * 0.8);
      this.bodyMat.color.copy(this.tmpColor);
    }

    // Spawn protection: chest glow pulses white.
    if (protectedNow) {
      const pulse = 0.5 + 0.5 * Math.sin(time * 20);
      this.chestMat.color.setRGB(1, 1, pulse);
    } else {
      this.chestMat.color.setHex(0xa855f7);
    }

    // Health bar: fill + color + billboard.
    this.healthBar.quaternion.copy(camQuat);
    this.healthFill.scale.x = Math.max(hpRatio, 0.001);
    this.healthFill.position.x = -0.45 * (1 - hpRatio);
    if (hpRatio > 0.5) this.healthFillMat.color.setHex(0x4ade80);
    else if (hpRatio > 0.25) this.healthFillMat.color.setHex(0xfacc15);
    else this.healthFillMat.color.setHex(0xef4444);
  }

  dispose(): void {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    });
  }
}