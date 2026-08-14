import * as THREE from "three";
import { PhysicsWorld } from "../physics/PhysicsWorld";
import { InputManager } from "../input/InputManager";
import { FPSCamera } from "../camera/FPSCamera";
import { PlayerController } from "../player/PlayerController";
import { PlayerMovement, MoveState } from "../player/PlayerMovement";
import { TestMap } from "../world/TestMap";
import { DebugHUD } from "../ui/DebugHUD";
import { WeaponHUD } from "../ui/WeaponHUD";
import { DashHUD } from "../ui/DashHUD";
import { MovementConfig as cfg } from "../player/MovementConfig";
import { ParticleSystem } from "../effects/ParticleSystem";
import { PlasmaRifle } from "../weapons/PlasmaRifle";
import { TargetManager } from "../targets/TargetManager";

/**
 * Top-level game: rendering, main loop and wiring between subsystems.
 * (Networking will plug in here later without touching movement/weapons.)
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

  private particles: ParticleSystem;
  private rifle: PlasmaRifle;
  private targets: TargetManager;
  /** Static map meshes + target groups — everything the beam can hit. */
  private hittables: THREE.Object3D[] = [];

  private lastTime = 0;
  private elapsed = 0;
  private readonly playerPos = new THREE.Vector3();
  private readonly rightDir = new THREE.Vector3();

  private constructor(container: HTMLElement, physics: PhysicsWorld) {
    this.physics = physics;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0d1420);
    this.scene.fog = new THREE.Fog(0x0d1420, 70, 190);

    const map = new TestMap(this.physics);
    this.scene.add(map.group);

    this.input = new InputManager(this.renderer.domElement);
    this.fpsCamera = new FPSCamera(window.innerWidth / window.innerHeight);
    // Camera must be in the scene graph so the weapon view model renders.
    this.scene.add(this.fpsCamera.camera);
    this.player = new PlayerController(this.physics);
    this.movement = new PlayerMovement(this.player, this.input, this.fpsCamera);
    this.hud = new DebugHUD();
    this.weaponHud = new WeaponHUD();
    this.dashHud = new DashHUD();

    // ---- Weapon / targets / effects ----
    this.particles = new ParticleSystem(this.scene);
    this.targets = new TargetManager(this.particles);
    this.scene.add(this.targets.group);
    this.rifle = new PlasmaRifle(this.scene, this.fpsCamera.camera, this.particles);

    // Raycast candidates, built once: static map meshes + target groups.
    map.group.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) this.hittables.push(obj);
    });
    for (const t of this.targets.hittables) this.hittables.push(t);

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

  private frame(): void {
    const now = performance.now();
    // Clamp dt so a background tab doesn't teleport the player.
    const dt = Math.min((now - this.lastTime) / 1000, 1 / 30);
    this.lastTime = now;
    this.elapsed += dt;

    if (this.input.pointerLocked) {
      this.fpsCamera.handleMouse(this.input.mouseDX, this.input.mouseDY);
      this.movement.update(dt);
      this.physics.step(dt);
      this.handleSafety();
    }

    this.updateCamera(dt);
    this.targets.update(dt);

    // Weapon raycast needs up-to-date world matrices (camera, targets)
    // BEFORE the render call that would normally refresh them.
    this.scene.updateMatrixWorld();

    const wantFire = this.input.pointerLocked && this.input.isMouseDown(0);
    this.rifle.update(dt, wantFire, this.hittables, this.elapsed);
    this.particles.update(dt);

    this.hud.update(dt, this.movement);
    this.weaponHud.update(dt, this.rifle.heat, this.rifle.hittingTarget);
    this.dashHud.update(dt, this.movement);
    this.renderer.render(this.scene, this.fpsCamera.camera);
    this.input.endFrame();
  }

  private handleSafety(): void {
    this.player.getPosition(this.playerPos);
    const fellOut = this.playerPos.y < cfg.killPlaneY;
    if (fellOut || this.input.wasPressed("KeyR")) {
      this.movement.respawn();
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
    });
  }
}