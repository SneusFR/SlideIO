import * as THREE from "three";
import { CombatConfig as cc } from "../combat/CombatConfig";
import { HitZone } from "../combat/HitZone";
import { HitFeedbackConfig as hfc } from "../combat/HitFeedbackConfig";

const BODY_COLORS = [0xd4a03b, 0x3bb0d4, 0x7ed43b, 0xd43b9a, 0xd4573b, 0x3bd4a8, 0x8a3bd4, 0xd4cf3b];

// ---- Shared enemy-readability resources (created once for all bots) ----

/**
 * Inverted-hull outline material: back faces of a slightly enlarged copy
 * of each body box render as a thin red rim hugging the silhouette.
 * Depth test stays ON → walls fully occlude the outline (no X-ray).
 */
let outlineMat: THREE.MeshBasicMaterial | null = null;
function getOutlineMaterial(): THREE.MeshBasicMaterial {
  if (!outlineMat) {
    outlineMat = new THREE.MeshBasicMaterial({
      color: cc.enemyOutlineColor,
      side: THREE.BackSide,
      toneMapped: false,
    });
    outlineMat.userData.shared = true;
  }
  return outlineMat;
}

/** "BOT" nameplate texture + material, shared by every bot. */
let labelMat: THREE.MeshBasicMaterial | null = null;
function getLabelMaterial(): THREE.MeshBasicMaterial {
  if (!labelMat) {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 96;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, 256, 96);
    ctx.font = "bold 60px Consolas, 'Courier New', monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 12;
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(8, 10, 14, 0.9)";
    ctx.strokeText("BOT", 128, 50);
    ctx.fillStyle = "#ffffff";
    ctx.fillText("BOT", 128, 50);
    const tex = new THREE.CanvasTexture(canvas);
    labelMat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    });
    labelMat.userData.shared = true;
  }
  return labelMat;
}

/**
 * Low-poly humanoid bot: head, torso, legs, arms and a mini Plasma Rifle.
 * Procedural animation (leg swing, bob, gun pitch) + billboarded enemy UI
 * (name + big red health bar) and a red silhouette outline. Outline and
 * UI are only shown while the PLAYER actually sees the bot (`setSeen`) —
 * never through walls.
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
  private readonly nameLabel: THREE.Mesh;
  private readonly bodyMat: THREE.MeshLambertMaterial;
  /** Head-only material (same base color) so headshot flashes stay local. */
  private readonly headMat: THREE.MeshLambertMaterial;
  private readonly visorMat: THREE.MeshBasicMaterial;
  private readonly chestMat: THREE.MeshBasicMaterial;

  /** Inverted-hull outline meshes (share source geometry + one material). */
  private readonly outlineMeshes: THREE.Mesh[] = [];
  private seen = false;

  private walkPhase = Math.random() * 10;
  private flashAmount = 0;
  private headFlashAmount = 0;
  private readonly baseColor: THREE.Color;
  private readonly flashColor = new THREE.Color(0xffffff);
  private readonly visorBaseColor = new THREE.Color(0xc084fc);
  private readonly tmpColor = new THREE.Color();
  private readonly tmpSize = new THREE.Vector3();

  constructor(index: number) {
    const color = BODY_COLORS[index % BODY_COLORS.length];
    this.baseColor = new THREE.Color(color);
    this.bodyMat = new THREE.MeshLambertMaterial({ color });
    this.headMat = new THREE.MeshLambertMaterial({ color });
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
    const head = mesh(new THREE.BoxGeometry(0.26, 0.26, 0.26), this.headMat);
    head.position.y = 0.58;
    const visor = mesh(new THREE.BoxGeometry(0.2, 0.07, 0.02), this.visorMat);
    visor.position.set(0, 0.6, -0.14);
    // The head mesh IS the headshot hitbox: parented to the animated torso,
    // it follows every pose automatically. The visor sits on the face and
    // counts as head too.
    head.userData.hitZone = HitZone.HEAD;
    visor.userData.hitZone = HitZone.HEAD;
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

    // ---- Ragdoll part tags (consumed by BotRagdollFactory) ----
    // The bot has no skinned skeleton: these nodes ARE its "bones". The
    // tags survive cloning (createCorpseVisual) so death corpses build the
    // exact same physical skeleton as the live knockdown ragdoll.
    this.torso.userData.ragdollPart = "torso";
    head.userData.ragdollPart = "head";
    armL.userData.ragdollPart = "armL";
    this.gunPivot.userData.ragdollPart = "armR";
    this.legL.userData.ragdollPart = "legL";
    this.legR.userData.ragdollPart = "legR";

    // ---- Silhouette outline (hull copies follow each animated part) ----
    if (cc.enemyOutlineEnabled) {
      this.addOutline(legGeoL);
      this.addOutline(legGeoR);
      this.addOutline(chest);
      this.addOutline(head);
      this.addOutline(armL);
      this.addOutline(armR);
      this.addOutline(gunBody);
    }

    // ---- Enemy UI (billboarded, above the head): BOT + big red HP bar ----
    this.healthBar = new THREE.Group();
    this.healthBar.position.y = 1.32;
    const barBg = new THREE.Mesh(
      new THREE.PlaneGeometry(1.15, 0.16),
      new THREE.MeshBasicMaterial({
        color: 0x14161c,
        transparent: true,
        opacity: 0.72,
        toneMapped: false,
      }),
    );
    this.healthFill = new THREE.Mesh(
      new THREE.PlaneGeometry(1.09, 0.115),
      new THREE.MeshBasicMaterial({ color: 0xef4444, toneMapped: false }),
    );
    this.healthFill.position.z = 0.002;
    this.nameLabel = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.195), getLabelMaterial());
    this.nameLabel.position.y = 0.19;
    this.nameLabel.visible = cc.enemyNameVisible;
    this.healthBar.add(barBg, this.healthFill, this.nameLabel);
    this.healthBar.visible = false; // hidden until the player actually sees the bot
    // UI planes must NEVER count as body hits for beam raycasts.
    barBg.raycast = NO_RAYCAST;
    this.healthFill.raycast = NO_RAYCAST;
    this.nameLabel.raycast = NO_RAYCAST;
    this.group.add(this.healthBar);
  }

  /** Create an inverted-hull copy of `source` on the same animated parent. */
  private addOutline(source: THREE.Mesh): void {
    const geo = source.geometry;
    geo.computeBoundingBox();
    geo.boundingBox!.getSize(this.tmpSize);
    const t = cc.enemyOutlineThickness * 2;
    const o = new THREE.Mesh(geo, getOutlineMaterial());
    o.position.copy(source.position);
    o.rotation.copy(source.rotation);
    o.scale.set(
      (this.tmpSize.x + t) / this.tmpSize.x,
      (this.tmpSize.y + t) / this.tmpSize.y,
      (this.tmpSize.z + t) / this.tmpSize.z,
    );
    o.visible = false;
    o.castShadow = false;
    // The hull is purely visual: exclude it from beam raycasts so the
    // effective hitbox of the bot does not grow by the outline thickness.
    o.raycast = NO_RAYCAST;
    source.parent!.add(o);
    this.outlineMeshes.push(o);
  }

  /**
   * Toggle the enemy readability visuals (outline + name + HP bar).
   * Called every frame by BotManager.updateVisibility with the REAL
   * line-of-sight result — nothing here ever shows through walls.
   */
  setSeen(seen: boolean): void {
    if (seen === this.seen) return;
    this.seen = seen;
    const outlineOn = seen && cc.enemyOutlineEnabled;
    for (const o of this.outlineMeshes) o.visible = outlineOn;
    this.healthBar.visible = seen && cc.enemyHealthBarVisible;
  }

  getMuzzleWorld(out: THREE.Vector3): THREE.Vector3 {
    return this.muzzle.getWorldPosition(out);
  }

  /** Trigger the damage flash (throttle-friendly: just refreshes intensity). */
  flash(): void {
    this.flashAmount = 1;
  }

  /**
   * Zone-aware hit reaction from the local player's confirmed hits:
   * BODY refreshes the classic white body flash, HEAD lights up ONLY the
   * head + visor (the rest of the bot keeps its color — §readability).
   */
  hitFlash(zone: HitZone): void {
    if (zone === HitZone.HEAD) this.headFlashAmount = 1;
    else this.flashAmount = 1;
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
    this.torso.position.y += targetY * 0.5;

    this.gunPivot.rotation.x = pitch;

    // Damage flash on the body material.
    if (this.flashAmount > 0) {
      this.flashAmount = Math.max(0, this.flashAmount - dt * hfc.bodyHitFlashDecay);
      this.tmpColor.lerpColors(this.baseColor, this.flashColor, this.flashAmount * 0.8);
      this.bodyMat.color.copy(this.tmpColor);
    }

    // Head flash: the brightest of the general body flash (head is part of
    // the body) and the dedicated headshot flash, which also lights the visor.
    if (this.flashAmount > 0 || this.headFlashAmount > 0) {
      this.headFlashAmount = Math.max(0, this.headFlashAmount - dt * hfc.headHitFlashDecay);
      const headAmt = Math.max(this.flashAmount * 0.8, this.headFlashAmount);
      this.tmpColor.lerpColors(this.baseColor, this.flashColor, headAmt);
      this.headMat.color.copy(this.tmpColor);
      this.tmpColor.lerpColors(this.visorBaseColor, this.flashColor, this.headFlashAmount);
      this.visorMat.color.copy(this.tmpColor);
    }

    // Spawn protection: chest glow pulses white.
    if (protectedNow) {
      const pulse = 0.5 + 0.5 * Math.sin(time * 20);
      this.chestMat.color.setRGB(1, 1, pulse);
    } else {
      this.chestMat.color.setHex(0xa855f7);
    }

    // Enemy UI: pure billboard (never rotates with the skeleton) + fill.
    // The group itself rotates with the body yaw, so cancel it by applying
    // the camera quaternion in world terms (premultiply the inverse yaw).
    this.healthBar.quaternion
      .setFromAxisAngle(Y_AXIS, -yaw)
      .multiply(camQuat);
    this.healthFill.scale.x = Math.max(hpRatio, 0.001);
    this.healthFill.position.x = -0.545 * (1 - hpRatio);
  }

  /**
   * CORPSE SNAPSHOT (death ragdoll): clone the body parts at their CURRENT
   * pose into an independent group placed at the model's world transform.
   * The clone shares geometries/materials with the live model (cheap) and
   * keeps the `ragdollPart` tags, so BotRagdollFactory can build the same
   * physical skeleton on it. The enemy UI (health bar / nameplate) is
   * intentionally NOT part of the corpse. Call setSeen(false) first so the
   * cloned outline hulls stay hidden.
   *
   * The corpse is fully independent: the bot can respawn elsewhere while
   * the body keeps simulating — it is never teleported to the new spawn.
   */
  createCorpseVisual(): THREE.Group {
    const corpse = new THREE.Group();
    corpse.position.copy(this.group.position);
    corpse.quaternion.copy(this.group.quaternion);
    corpse.scale.copy(this.group.scale);
    for (const part of [this.legL, this.legR, this.torso, this.gunPivot]) {
      corpse.add(part.clone(true));
    }
    return corpse;
  }

  dispose(): void {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry.dispose();
        const mat = m.material as THREE.Material;
        // Never dispose shared resources (outline / nameplate materials).
        if (!mat.userData.shared) mat.dispose();
      }
    });
  }
}

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const NO_RAYCAST = () => {};
