import * as THREE from "three";
import { PhysicsWorld } from "../physics/PhysicsWorld";
import { InputManager } from "../input/InputManager";
import { FPSCamera } from "../camera/FPSCamera";
import { PlayerController } from "../player/PlayerController";
import { PlayerMovement, MoveState } from "../player/PlayerMovement";
import { TdmMap } from "../world/TdmMap";
import { DebugHUD } from "../ui/DebugHUD";
import { WeaponHUD } from "../ui/WeaponHUD";
import { DashHUD } from "../ui/DashHUD";
import { CombatHUD } from "../ui/CombatHUD";
import { BotsMenu } from "../ui/BotsMenu";
import { MovementConfig as cfg } from "../player/MovementConfig";
import { CombatConfig as cc } from "../combat/CombatConfig";
import { ParticleSystem } from "../effects/ParticleSystem";
import { PlasmaRifle } from "../weapons/PlasmaRifle";
import { TargetManager } from "../targets/TargetManager";
import { Combatant } from "../combat/Combatant";
import { PlayerCombatant } from "../combat/PlayerCombatant";
import { SpawnManager } from "../combat/SpawnManager";
import { NavGrid } from "../navigation/NavGrid";
import { BotManager } from "../bots/BotManager";

/**
 * Top-level game: rendering, main loop and wiring between subsystems.
 * FFA sandbox: the human player + up to 8 autonomous bots, everyone
 * hostile to everyone. The game pauses while the pointer is unlocked
 * (Escape menu) so bots can't kill you while you tweak their count.
 */
export class Game {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private physics: PhysicsWorld;
  private input: InputManager;
  private fpsCamera: FPSCamera;
  private player: PlayerController;
  private movement: PlayerMovement;
  private hud: DebugHUD;
  private weaponHud: WeaponHUD;
  private dashHud: DashHUD;
  private combatHud: CombatHUD;
  private botsMenu: BotsMenu;

  private particles: ParticleSystem;
  private rifle: PlasmaRifle;
  private targets: TargetManager;

  // ---- FFA combat ----
  private nav: NavGrid;
  private spawner: SpawnManager;
  private botManager: BotManager;
  private playerCombatant: PlayerCombatant;
  private readonly combatants: Combatant[] = [];
  private playerDeathTimer = 0;

  /** Static map meshes + target groups (never changes after startup). */
  private staticHittables: THREE.Object3D[] = [];
  /** Everything a beam can hit: statics + player proxy + bot models. */
  private hittables: THREE.Object3D[] = [];

  private lastTime = 0;
  private elapsed = 0;
  private readonly playerPos = new THREE.Vector3();
  private readonly rightDir = new THREE.Vector3();

  // Phase dash VFX
  private readonly phaseOverlayEl: HTMLElement;
  private readonly phaseColor = new THREE.Color(0xa855f7);
  private readonly phaseColorBright = new THREE.Color(0xd8b4fe);
  private readonly phaseNormal = new THREE.Vector3();
  private lastOverlayOpacity = -1;

  private constructor(container: HTMLElement, physics: PhysicsWorld) {
    this.physics = physics;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xa8bfd0);
    this.scene.fog = new THREE.Fog(0xa8bfd0, 90, 230);

    const map = new TdmMap(this.physics);
    this.scene.add(map.group);

    // Navigation must be built from STATIC geometry only — before any
    // character capsule (player or bot) exists in the physics world.
    // Refresh scene queries first: Rapier only indexes new colliders during
    // a step, so without this the NavGrid would see an EMPTY world and no
    // cell would be walkable (bots frozen in place).
    this.physics.refreshQueries();
    this.nav = new NavGrid(this.physics);
    this.spawner = new SpawnManager(this.physics);

    this.input = new InputManager(this.renderer.domElement);
    this.fpsCamera = new FPSCamera(window.innerWidth / window.innerHeight);
    // Camera must be in the scene graph so the weapon view model renders.
    this.scene.add(this.fpsCamera.camera);
    this.player = new PlayerController(this.physics);
    this.movement = new PlayerMovement(this.player, this.input, this.fpsCamera);
    this.hud = new DebugHUD();
    this.weaponHud = new WeaponHUD();
    this.dashHud = new DashHUD();
    this.combatHud = new CombatHUD();
    this.phaseOverlayEl = document.getElementById("phase-overlay")!;

    // ---- Weapon / targets / effects ----
    this.particles = new ParticleSystem(this.scene);
    this.targets = new TargetManager(this.particles);
    this.scene.add(this.targets.group);
    this.rifle = new PlasmaRifle(this.scene, this.fpsCamera.camera, this.particles);

    // ---- Player as an FFA combatant ----
    this.playerCombatant = new PlayerCombatant(this.player, this.movement, this.scene);
    this.combatants.push(this.playerCombatant);
    this.rifle.owner = this.playerCombatant;

    this.playerCombatant.health.onDamaged = (amount) => {
      this.combatHud.notifyDamage(amount);
    };
    this.playerCombatant.health.onDeath = () => {
      this.playerDeathTimer = cc.playerRespawnDelay;
    };

    // ---- Bots ----
    this.botManager = new BotManager(
      this.scene,
      this.physics,
      this.particles,
      this.nav,
      this.spawner,
      this.combatants,
    );
    this.botManager.onBotKilled = (_bot, killer) => {
      if (killer === this.playerCombatant) this.combatHud.notifyKill();
    };
    this.botsMenu = new BotsMenu((count) => {
      this.botManager.setBotCount(count);
      this.rebuildHittables();
    });

    // Raycast candidates: static map meshes + target groups.
    map.group.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) this.staticHittables.push(obj);
    });
    for (const t of this.targets.hittables) this.staticHittables.push(t);

    this.botManager.setBotCount(this.botsMenu.botCount);
    this.rebuildHittables();

    window.addEventListener("resize", () => {
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.fpsCamera.setAspect(window.innerWidth / window.innerHeight);
    });
  }

  static async create(container: HTMLElement): Promise<Game> {
    const physics = await PhysicsWorld.create();
    return new Game(container, physics);
  }

  get domElement(): HTMLElement {
    return this.renderer.domElement;
  }

  requestPointerLock(): void {
    this.input.requestPointerLock();
  }

  start(): void {
    this.lastTime = performance.now();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  /** Rebuild the beam raycast list after the bot roster changes. */
  private rebuildHittables(): void {
    this.hittables.length = 0;
    for (const h of this.staticHittables) this.hittables.push(h);
    this.hittables.push(this.playerCombatant.hitProxy);
    for (const bot of this.botManager.bots) this.hittables.push(bot.model.group);
  }

  private frame(): void {
    const now = performance.now();
    // Clamp dt so a background tab doesn't teleport the player.
    const dt = Math.min((now - this.lastTime) / 1000, 1 / 30);
    this.lastTime = now;
    this.elapsed += dt;

    // Game is PAUSED while the pointer is unlocked (Escape menu): no AI,
    // no physics, no damage — bots can't kill you in the menu.
    const running = this.input.pointerLocked;
    const playerAlive = this.playerCombatant.health.alive;

    if (running) {
      this.fpsCamera.handleMouse(this.input.mouseDX, this.input.mouseDY);
      this.playerCombatant.health.update(dt);

      if (playerAlive) {
        this.movement.update(dt);
      } else {
        this.updatePlayerDeath(dt);
      }

      this.botManager.update(dt); // AI + bot movement (pre-step)
      this.physics.step(dt);
      this.handleSafety();
      this.targets.update(dt);
    }

    this.playerCombatant.syncProxy();
    this.updateCamera(dt);

    // Sync bot visuals to their post-step physics positions, then refresh
    // world matrices so every beam raycast this frame is exact.
    this.botManager.postStep(
      dt,
      this.fpsCamera.camera.quaternion,
      this.fpsCamera.camera.position,
      this.elapsed,
    );
    this.scene.updateMatrixWorld();

    if (running) {
      const wantFire =
        playerAlive && this.input.pointerLocked && this.input.isMouseDown(0);
      this.rifle.update(dt, wantFire, this.hittables, this.elapsed);
      this.botManager.updateWeapons(dt, this.hittables, this.elapsed);
      this.handlePhaseEffects();
      this.particles.update(dt);
    }

    this.hud.update(dt, this.movement);
    this.weaponHud.update(dt, this.rifle.heat, this.rifle.hittingTarget);
    this.dashHud.update(dt, this.movement);
    this.combatHud.update(dt, this.playerCombatant.health, this.playerDeathTimer);
    this.renderer.render(this.scene, this.fpsCamera.camera);
    this.input.endFrame();
  }

  /** Death state: controls disabled, countdown, then smart respawn. */
  private updatePlayerDeath(dt: number): void {
    this.playerDeathTimer -= dt;
    if (this.playerDeathTimer > 0) return;

    const spawn = this.spawner.pickSpawn(this.combatants, this.playerCombatant);
    this.movement.respawn(spawn.pos); // velocity = 0, movement states reset
    this.playerCombatant.health.reset(cc.spawnProtectionDuration);
  }

  /**
   * Phase dash feedback: portal rings + bursts on both wall faces and a
   * short violet screen flash. Purely visual — movement is never paused.
   */
  private handlePhaseEffects(): void {
    const ev = this.movement.consumePhaseEvent();
    if (ev) {
      // Entry face effect (ring normal faces back toward the player).
      this.phaseNormal.copy(ev.travelDir).negate();
      this.particles.ring(ev.entryPoint, this.phaseNormal, 26, 0.55, 4.5, 0.45, this.phaseColor);
      this.particles.burst(ev.entryPoint, 14, 3.5, 0.35, this.phaseColorBright);

      // Exit face effect (ring normal faces the travel direction).
      this.particles.ring(ev.exitPoint, ev.travelDir, 26, 0.55, 4.5, 0.45, this.phaseColor);
      this.particles.burst(ev.exitPoint, 14, 3.5, 0.35, this.phaseColorBright);
    }

    // Violet energy vignette driven by the phase timer (1 → 0).
    const opacity = Math.round(this.movement.phaseIntensity * 100) / 100;
    if (opacity !== this.lastOverlayOpacity) {
      this.lastOverlayOpacity = opacity;
      this.phaseOverlayEl.style.opacity = String(opacity);
    }
  }

  private handleSafety(): void {
    if (!this.playerCombatant.health.alive) return;
    this.player.getPosition(this.playerPos);
    const fellOut = this.playerPos.y < cfg.killPlaneY;
    if (fellOut || this.input.wasPressed("KeyR")) {
      // Suicide / kill plane → normal death + respawn flow.
      this.playerCombatant.health.kill(null);
    }
  }

  private updateCamera(dt: number): void {
    this.player.getPosition(this.playerPos);
    this.fpsCamera.getRight(this.rightDir);

    this.fpsCamera.update(dt, this.playerPos, {
      speed: this.movement.horizontalSpeed,
      lateralSpeed: this.movement.velocity.dot(this.rightDir),
      wallSide: this.movement.state === MoveState.WALL_SLIDING ? this.movement.wallSide : 0,
      crouchAmount: this.player.crouched ? 1 : 0,
      dashKick: this.movement.isDashing ? 1 : 0,
      phaseKick: this.movement.phaseIntensity,
    });
  }
}