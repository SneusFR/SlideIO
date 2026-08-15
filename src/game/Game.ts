import * as THREE from "three";
import { PhysicsWorld } from "../physics/PhysicsWorld";
import { InputManager } from "../input/InputManager";
import { FPSCamera } from "../camera/FPSCamera";
import { PlayerController } from "../player/PlayerController";
import { PlayerMovement, MoveState } from "../player/PlayerMovement";
import { TdmMap } from "../world/TdmMap";
import { SpaceSky } from "../world/SpaceSky";
import { SpaceConfig as spaceCfg } from "../world/SpaceConfig";
import { DebugHUD } from "../ui/DebugHUD";
import { WeaponHUD } from "../ui/WeaponHUD";
import { DashHUD } from "../ui/DashHUD";
import { CombatHUD } from "../ui/CombatHUD";
import { BotsMenu } from "../ui/BotsMenu";
import { MovementConfig as cfg } from "../player/MovementConfig";
import { CombatConfig as cc } from "../combat/CombatConfig";
import { ParticleSystem } from "../effects/ParticleSystem";
import { Shockwave } from "../effects/Shockwave";
import { PlasmaRifle } from "../weapons/PlasmaRifle";
import { HammerWeapon } from "../weapons/HammerWeapon";
import { HammerViewmodel } from "../weapons/HammerViewmodel";
import { SpearWeapon } from "../weapons/SpearWeapon";
import { SpearViewmodel } from "../weapons/SpearViewmodel";
import { SpearConfig as spearCfg } from "../weapons/SpearConfig";
import { SpearHUD } from "../ui/SpearHUD";
import { loadLoadout, MeleeWeaponId, PrimaryWeaponId } from "../loadout/Loadout";
import { ObliterreurWeapon } from "../weapons/obliterreur/ObliterreurWeapon";
import { KillstreakManager } from "../killstreaks/KillstreakManager";
import { MoleStrike } from "../killstreaks/mole/MoleStrike";
import { MoleStrikeVFX } from "../killstreaks/mole/MoleStrikeVFX";
import { KillstreakHUD } from "../ui/KillstreakHUD";
import { TargetManager } from "../targets/TargetManager";
import { Combatant } from "../combat/Combatant";
import { PlayerCombatant } from "../combat/PlayerCombatant";
import { SpawnManager } from "../combat/SpawnManager";
import { NavGrid } from "../navigation/NavGrid";
import { BotManager } from "../bots/BotManager";
import { GameAudio } from "../audio/GameAudio";
import { PickupManager } from "../pickups/PickupManager";
import { ComboManager } from "../combo/ComboManager";
import { MedalManager } from "../medals/MedalManager";
import { MedalHUD } from "../ui/MedalHUD";
import { ComboHUD } from "../ui/ComboHUD";
import { MatchStatsManager } from "../stats/MatchStatsManager";
import { LeaderboardHUD } from "../ui/LeaderboardHUD";

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
  private spaceSky: SpaceSky | null = null;

  // ---- Hammer melee ----
  private shockwave: Shockwave;
  private hammer: HammerWeapon;
  private hammerViewmodel: HammerViewmodel;
  private readonly eyePos = new THREE.Vector3();
  private readonly fwdFlat = new THREE.Vector3();

  // ---- Astral Lance melee (equipped via the Loadout menu) ----
  private spear: SpearWeapon;
  private spearViewmodel: SpearViewmodel;
  private spearHud: SpearHUD;
  /** Which melee weapon is equipped (read from the persisted loadout). */
  private meleeWeapon: MeleeWeaponId;
  /** Tap-vs-hold detection: press time accumulated while the key is held. */
  private meleeHoldTimer = 0;
  private meleeHoldPending = false;
  private spearRushWasReady = true;

  // ---- OBLITERREUR (primary alternative — equipped via the Loadout menu) ----
  private obliterreur: ObliterreurWeapon;
  /** Which primary weapon is equipped (read from the persisted loadout). */
  private primaryWeapon: PrimaryWeaponId;
  private readonly obliAudioPos = new THREE.Vector3();

  // ---- FFA combat ----
  private gameAudio: GameAudio;

  // ---- Kill combo + medals (local player only — pure observers) ----
  private combo: ComboManager;
  private medals: MedalManager;
  private medalHud: MedalHUD;
  private comboHud: ComboHUD;

  // ---- FFA match stats (ALL combatants) + live leaderboard HUD ----
  private matchStats: MatchStatsManager;
  private leaderboardHud: LeaderboardHUD;

  // ---- Killstreaks: 3 equippable slots (keys 1/2/3), reset on death ----
  private killstreaks: KillstreakManager;
  private moleStrike: MoleStrike;
  private killstreakHud: KillstreakHUD;

  private nav: NavGrid;
  private spawner: SpawnManager;
  private botManager: BotManager;
  private pickups: PickupManager;
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
  private readonly attackerPos = new THREE.Vector3();
  private readonly toAttacker = new THREE.Vector3();
  private readonly fwdDir = new THREE.Vector3();

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
    // Light "color grading": filmic curve → deep blacks, cool highlights.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = spaceCfg.toneMappingExposure;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    // Deep-space night: near-black clear color + a very light violet-blue
    // distance haze that only melts far map geometry (never a ground fog).
    this.scene.background = new THREE.Color(spaceCfg.backgroundColor);
    this.scene.fog = new THREE.Fog(spaceCfg.fogColor, spaceCfg.fogNear, spaceCfg.fogFar);

    const map = new TdmMap(this.physics);
    this.scene.add(map.group);

    // Purple deep-space backdrop: stars / nebula / moon / meteors.
    // Added straight to the scene (NOT map.group) so it is never part of
    // the beam-raycast hittables and never touches physics or the NavGrid.
    if (spaceCfg.spaceSkyEnabled) {
      this.spaceSky = new SpaceSky();
      this.scene.add(this.spaceSky.group);
    }

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

    // ---- FFA match stats (source of truth) + live leaderboard HUD ----
    // Event flow: combat event → MatchStatsManager → leaderboard refresh.
    // The HUD is a pure observer and only re-renders when stats actually
    // change (kill / death / assist / bot added / removed) — never per frame.
    this.matchStats = new MatchStatsManager();
    this.leaderboardHud = new LeaderboardHUD();
    this.matchStats.onStatsChanged = () =>
      this.leaderboardHud.refresh(this.matchStats.getSortedStats());
    this.matchStats.register(this.playerCombatant, "VALENTIN", true);

    // ---- Combat hammer (melee): grounded sweep + airborne Ground Slam ----
    this.shockwave = new Shockwave(this.scene);
    this.hammerViewmodel = new HammerViewmodel(this.fpsCamera.camera);
    this.hammer = new HammerWeapon(
      this.combatants,
      this.particles,
      this.shockwave,
      this.hammerViewmodel,
    );
    this.hammer.owner = this.playerCombatant;
    this.hammer.onCameraShake = (amount) => this.fpsCamera.addShake(amount);

    // ---- Astral Lance (melee alternative — equipped from the Loadout menu):
    // quick press → horizontal sweep, held press → CHARGED SPEAR RUSH.
    this.meleeWeapon = loadLoadout().melee;
    this.spearViewmodel = new SpearViewmodel(this.fpsCamera.camera);
    this.spear = new SpearWeapon(
      this.combatants,
      this.particles,
      this.shockwave,
      this.spearViewmodel,
    );
    this.spear.owner = this.playerCombatant;
    this.spear.onCameraShake = (amount) => this.fpsCamera.addShake(amount);
    // The FIRST combatant hit by the tip stops the charge immediately.
    this.spear.onRushImpact = () => {
      this.movement.stopSpearRush("HIT");
      this.movement.consumeSpearRushEnd(); // already handled right here
      this.spear.onRushEnded("HIT");
      this.gameAudio.slamImpact(1); // heavy piercing energy impact
    };
    this.spearHud = new SpearHUD();

    // ---- OBLITERREUR (primary alternative — equipped from the Loadout menu):
    // RMB anchors two mini black holes on static surfaces, LMB opens a huge
    // curved black-vortex beam between them (damage through walls).
    this.primaryWeapon = loadLoadout().primary;
    this.obliterreur = new ObliterreurWeapon(
      this.scene,
      this.fpsCamera.camera,
      this.combatants,
      this.particles,
    );
    this.obliterreur.owner = this.playerCombatant;
    this.obliterreur.onCameraShake = (amount) => this.fpsCamera.addShake(amount);

    // ---- Audio: pure observation of existing gameplay events ----
    this.gameAudio = new GameAudio();
    this.movement.sfx = this.gameAudio.movementSfx;
    this.rifle.onOverheat = () => this.gameAudio.overheat();
    this.hammer.onSwingStart = () => this.gameAudio.hammerSwing();
    this.hammer.onHitConnect = (pos) => this.gameAudio.hammerHit(pos);
    this.hammer.onSlamStart = () => this.gameAudio.slamDescent();
    this.hammer.onSlamImpact = (_pos, hitCount) => this.gameAudio.slamImpact(hitCount);
    // Lance: reuse the existing heavy melee / energy palette (same system).
    this.spear.onSweepStart = () => this.gameAudio.hammerSwing(); // polearm whoosh
    this.spear.onHitConnect = (pos) => this.gameAudio.hammerHit(pos);
    this.spear.onRushStart = () => this.gameAudio.phaseTraversal(); // energy charge whoosh
    // Obliterreur: layered dark-energy palette from existing SFX.
    this.obliterreur.onPointPlaced = () => this.gameAudio.obliterreurPlace();
    this.obliterreur.onBeamStart = () => this.gameAudio.obliterreurActivate();
    this.obliterreur.onBeamEnd = (cancelled) => this.gameAudio.obliterreurBeamEnd(cancelled);

    this.playerCombatant.health.onDamaged = (amount, attacker) => {
      this.combatHud.notifyDamage(amount, this.damageAngleFrom(attacker));
      this.gameAudio.playerDamaged();
    };
    // ---- Kill combo + medal presentation (observes kills, changes nothing) ----
    this.combo = new ComboManager();
    this.medalHud = new MedalHUD(); // preloads the 5 medal images now
    this.medals = new MedalManager(this.medalHud);
    this.comboHud = new ComboHUD();
    this.medals.onMedalPop = (pitch) => this.gameAudio.medalPop(pitch);
    // Combo over (timeout or death) → the pitch chain restarts at base.
    this.combo.onComboEnd = () => this.medals.resetChain();

    // ---- Killstreaks: pure state machine + HUD + the MOLE STRIKE ability.
    // Kills feed the slots, death resets everything, keys 1/2/3 activate.
    this.killstreaks = new KillstreakManager();
    this.killstreakHud = new KillstreakHUD(this.killstreaks);
    this.killstreaks.onChanged = () => this.killstreakHud.render();
    this.killstreaks.onReady = (slotIndex) => {
      this.killstreakHud.notifyReady(slotIndex);
      this.gameAudio.killstreakReady();
    };
    this.moleStrike = new MoleStrike(
      this.player,
      this.movement,
      this.playerCombatant,
      this.fpsCamera,
      this.combatants,
      new MoleStrikeVFX(this.particles, this.shockwave),
      this.gameAudio,
    );
    this.killstreaks.setEquipped(loadLoadout().killstreaks);

    this.playerCombatant.health.onDeath = () => {
      this.playerDeathTimer = cc.playerRespawnDelay;
      this.hammer.reset(); // drop any melee attack in progress
      this.spear.reset();
      this.obliterreur.reset(); // vortex off + anchors cleared on death
      this.meleeHoldPending = false;
      // Death mid-burrow: instant cleanup WITHOUT the AoE, then every
      // killstreak slot (progress / ready / spent) resets to LOCKED.
      this.moleStrike.abort();
      this.killstreaks.onPlayerDeath();
      this.gameAudio.playerDeath();
      // The combo NEVER survives death — even on a mutual kill the medal
      // may already be queued, but the bar/count reset immediately.
      this.combo.resetOnDeath();
    };

    // ---- Loot pickups (medkits + coins dropped by dead bots) ----
    this.pickups = new PickupManager(this.scene, this.physics, this.particles);
    this.pickups.onMedkitCollected = (healed) => {
      this.combatHud.notifyHeal(healed);
      this.gameAudio.healthPickup();
    };
    this.pickups.onCoinCollected = () => {
      // No economy yet: sound + disappear. A wallet hooks in here later.
      this.gameAudio.coinPickup();
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
    this.botManager.onBotKilled = (bot, killer, method) => {
      if (killer === this.playerCombatant) {
        this.combatHud.notifyKill();
        // LOCAL PLAYER kill only (bot-vs-bot never touches the combo):
        // +1 combo, timer refilled, bar punch, medals queued (combo medal
        // first, then the kill-method medal — HOMERUN / SMASHED).
        const count = this.combo.registerKill();
        this.comboHud.notifyKill();
        this.medals.onPlayerKill(count, method);
        // Killstreak progress: every LOCKED slot advances by one kill.
        this.killstreaks.onPlayerKill();
        this.killstreakHud.notifyKill();
      }
      this.gameAudio.botKilled(bot);
      // Loot belongs to a REAL combat death only. Manual bot removal from
      // the Escape menu never fires onBotKilled, and the player's manual
      // respawn (R) is a player death — neither ever drops loot.
      this.pickups.spawnLoot(bot.deathPosition);
    };
    // Leaderboard roster: new bots join with 0/0/0; Escape-menu removal
    // deletes the row WITHOUT counting a death for anyone.
    this.botManager.onBotAdded = (bot) => this.matchStats.register(bot, `BOT ${bot.id + 1}`);
    this.botManager.onBotRemoved = (bot) => this.matchStats.unregister(bot.id);
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
    // User gesture → safe point to unlock the AudioContext (autoplay policy)
    // and kick off SFX preloading (cached — only the first call fetches).
    this.gameAudio.unlock();
    void this.gameAudio.preload();
    this.applyLoadout();
    this.input.requestPointerLock();
  }

  /**
   * Re-read the persisted loadout when (re)entering the game. The Loadout
   * menu only WRITES the selection — this is the single point where the
   * game applies it. Switching melee weapons cleanly drops any attack.
   */
  private applyLoadout(): void {
    const selection = loadLoadout();
    // The manager skips unchanged slots, so in-flight progress survives.
    this.killstreaks.setEquipped(selection.killstreaks);
    // Primary swap: a clean slate — active vortex cancelled, anchors gone.
    if (selection.primary !== this.primaryWeapon) {
      this.primaryWeapon = selection.primary;
      this.obliterreur.reset();
    }
    const melee = selection.melee;
    if (melee === this.meleeWeapon) return;
    this.meleeWeapon = melee;
    this.hammer.reset();
    this.spear.reset();
    this.meleeHoldPending = false;
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
      // Assist-window clock: game time, so the Escape menu never expires
      // recent damage contributions while everything is frozen.
      this.matchStats.setTime(this.elapsed);
      this.playerCombatant.health.update(dt);

      if (playerAlive) {
        // Melee is blocked for the whole MOLE STRIKE (burrow → eruption).
        if (!this.moleStrike.blocksWeapons) this.handleMeleeInput(dt);
        this.movement.update(dt);
        // AFTER movement: E while burrowed emerges here instead of dashing
        // (the movement itself refuses to dash while UNDERGROUND).
        this.handleKillstreakInput();

        // Ground Slam AoE: fires on the REAL ground contact of the dive
        // (reported by the movement state machine) — never on a timer.
        const slamImpact = this.movement.consumeSlamImpact();
        if (slamImpact) this.hammer.onSlamLanded(slamImpact);

        // Spear rush lifecycle: the movement reports WHY the charge ended
        // (wall / timeout — a tip hit is stopped by the weapon itself).
        const rushEnd = this.movement.consumeSpearRushEnd();
        if (rushEnd) {
          this.spear.onRushEnded(rushEnd);
          if (rushEnd === "WALL") {
            this.player.getPosition(this.playerPos);
            this.gameAudio.hammerHit(this.playerPos); // distinct wall impact
          }
        }
      } else {
        this.updatePlayerDeath(dt);
      }

      // MOLE STRIKE phase timers (enter / burrow timeout / emerge AoE).
      this.moleStrike.update(dt);

      this.botManager.update(dt); // AI + bot movement (pre-step)
      this.physics.step(dt);
      this.handleSafety();
      this.targets.update(dt);

      // Loot: idle animation, lifetimes and walk-over collection.
      this.player.getPosition(this.playerPos);
      this.pickups.update(dt, this.playerPos, this.playerCombatant.health, this.elapsed);
    }

    this.playerCombatant.syncProxy();
    this.updateCamera(dt);

    // Space backdrop: follows the camera, twinkles, spawns rare meteors.
    // Runs even in the Escape menu (purely decorative, gameplay untouched).
    this.spaceSky?.update(dt, this.elapsed, this.fpsCamera.camera);

    // Sync bot visuals to their post-step physics positions, then refresh
    // world matrices so every beam raycast this frame is exact.
    this.botManager.postStep(
      dt,
      this.fpsCamera.camera.quaternion,
      this.fpsCamera.camera.position,
      this.elapsed,
    );
    this.scene.updateMatrixWorld();

    // Enemy readability: outline + name + HP bar only with REAL line of
    // sight (frustum + wall raycasts) — never through walls.
    this.botManager.updateVisibility(this.fpsCamera.camera);

    if (running) {
      // Melee weapons: hit windows / rush bookkeeping + viewmodel anims.
      this.playerCombatant.getEyePosition(this.eyePos);
      this.fpsCamera.getForward(this.fwdFlat);
      this.hammer.update(dt, this.eyePos, this.fwdFlat);
      this.spear.update(dt, this.eyePos, this.fwdFlat, this.movement.spearRushDir);

      // Cooldown feedback: discreet ping when SPEAR RUSH becomes READY.
      const rushReady = this.spear.rushReady;
      if (rushReady && !this.spearRushWasReady && this.meleeWeapon === "SPEAR") {
        this.gameAudio.medalPop(1.4); // small "energy ready" ping
      }
      this.spearRushWasReady = rushReady;

      // Plasma Rifle is unavailable while a melee weapon is out (nothing is
      // reset — heat keeps cooling / overheat keeps ticking normally) or
      // when the OBLITERREUR is the equipped primary.
      const obliEquipped = this.primaryWeapon === "OBLITERREUR";
      const meleeBlocked =
        this.hammer.blocksFiring || this.spear.blocksFiring || this.moleStrike.blocksWeapons;
      const wantFire =
        playerAlive &&
        this.input.pointerLocked &&
        this.input.isMouseDown(0) &&
        !meleeBlocked &&
        !obliEquipped;
      this.rifle.setViewmodelHidden(
        this.hammer.isBusy || this.spear.isBusy || this.moleStrike.active || obliEquipped,
      );
      this.rifle.update(dt, wantFire, this.hittables, this.elapsed);

      // OBLITERREUR: RMB places / redefines anchors (cancels an active
      // vortex), LMB opens the beam. Placement raycasts STATIC geometry
      // only; the active beam damages through walls (volume check).
      this.obliterreur.setViewmodelHidden(
        !obliEquipped || this.hammer.isBusy || this.spear.isBusy || this.moleStrike.active,
      );
      this.obliterreur.update(dt, {
        placePressed:
          obliEquipped && playerAlive && !meleeBlocked && this.input.wasMousePressed(2),
        firePressed:
          obliEquipped && playerAlive && !meleeBlocked && this.input.wasMousePressed(0),
        staticHittables: this.staticHittables,
        time: this.elapsed,
      });
      this.gameAudio.updateObliterreurBeam(
        this.obliterreur.beamActive,
        this.obliterreur.getAudioEmitterPos(this.playerPos, this.obliAudioPos),
      );
      this.botManager.updateWeapons(dt, this.hittables, this.elapsed);
      this.handlePhaseEffects();
      this.particles.update(dt);
      this.shockwave.update(dt);

      // Combo window countdown + medal queue presentation (paused with
      // the game so the Escape menu never eats your combo).
      this.combo.update(dt);
      this.medals.update(dt);
      this.gameAudio.setComboLayer(this.combo.active, this.combo.comboCount);
    }

    // Audio: listener follows the camera; loops/cadence/edges are polled.
    this.gameAudio.update(dt, {
      camera: this.fpsCamera.camera,
      movement: this.movement,
      rifle: this.rifle,
      playerHealth: this.playerCombatant.health,
      botManager: this.botManager,
      running,
    });

    this.hud.update(dt, this.movement);
    this.weaponHud.update(dt, this.rifle.heat, this.rifle.hittingTarget);
    this.dashHud.update(dt, this.movement);
    this.spearHud.setVisible(this.meleeWeapon === "SPEAR");
    this.spearHud.update(this.spear);
    this.combatHud.update(dt, this.playerCombatant.health, this.playerDeathTimer);
    this.comboHud.update(this.combo);
    this.renderer.render(this.scene, this.fpsCamera.camera);
    this.input.endFrame();
  }

  /**
   * Killstreak activation (keys 1/2/3) + MOLE STRIKE emerge (E).
   * A refused activation (no ground below the feet) consumes NOTHING —
   * the slot stays READY. Only one killstreak can be ACTIVE at a time.
   */
  private handleKillstreakInput(): void {
    if (this.moleStrike.active) {
      if (this.input.wasPressed("KeyE")) this.moleStrike.requestEmerge();
      return;
    }
    for (let i = 0; i < 3; i++) {
      if (!this.input.wasPressed(`Digit${i + 1}`)) continue;
      const def = this.killstreaks.peekReady(i);
      if (!def) continue;
      if (def.id === "MOLE_STRIKE" && this.moleStrike.canActivate()) {
        this.killstreaks.confirmActivation(i);
        this.moleStrike.activate(() => this.killstreaks.completeActivation(i));
        this.meleeHoldPending = false; // never resume a held charge afterwards
      }
    }
  }

  /** Melee input dispatch: the equipped weapon owns the "A" key. */
  private handleMeleeInput(dt: number): void {
    if (this.meleeWeapon === "SPEAR") {
      this.handleSpearInput(dt);
      return;
    }

    // ---- Hammer (single press, edge-triggered) ----
    //   attack in progress   → nothing (no cancel, no spam, no stacking)
    //   airborne             → Ground Slam (vertical charge + AoE on landing)
    //   grounded             → alternating horizontal hammer sweep
    if (!this.input.wasMeleePressed()) return;
    if (this.hammer.isBusy) return; // input cleanly ignored — no feedback needed

    if (this.movement.grounded) {
      this.hammer.startSwing();
    } else if (this.hammer.startSlam()) {
      // Movement takes over the descent; the AoE fires on real ground contact.
      this.movement.startGroundSlam();
    }
  }

  /**
   * Astral Lance tap-vs-hold detection (grounded AND airborne — identical):
   *   press released before the hold threshold → SWEEP
   *   press held past the threshold            → CHARGED SPEAR RUSH
   * The sweep is NEVER auto-played before a rush. During the rush cooldown
   * a held press does nothing, but a quick tap still sweeps normally.
   * Once a rush launches it is COMMITTED — releasing the key changes nothing.
   */
  private handleSpearInput(dt: number): void {
    if (this.spear.isBusy) {
      this.meleeHoldPending = false; // no buffering, no cancel, no stacking
      return;
    }

    if (this.input.wasMeleePressed()) {
      this.meleeHoldPending = true;
      this.meleeHoldTimer = 0;
    }
    if (!this.meleeHoldPending) return;

    if (!this.input.isMeleeDown()) {
      // Released before the threshold → quick press → SWEEP.
      this.meleeHoldPending = false;
      this.spear.startSweep();
      return;
    }

    this.meleeHoldTimer += dt;
    if (this.meleeHoldTimer >= spearCfg.spearChargeHoldThreshold) {
      this.meleeHoldPending = false;
      // Held past the threshold → RUSH (only if the cooldown allows it).
      if (this.spear.rushReady && this.spear.startRush()) {
        this.movement.startSpearRush();
      }
    }
  }

  /** Death state: controls disabled, countdown, then smart respawn. */
  private updatePlayerDeath(dt: number): void {
    this.playerDeathTimer -= dt;
    if (this.playerDeathTimer > 0) return;

    const spawn = this.spawner.pickSpawn(this.combatants, this.playerCombatant);
    this.movement.respawn(spawn.pos); // velocity = 0, movement states reset
    this.playerCombatant.health.reset(cc.spawnProtectionDuration);
    this.gameAudio.playerRespawn();
  }

  /**
   * Phase dash feedback: portal rings + bursts on both wall faces and a
   * short violet screen flash. Purely visual — movement is never paused.
   */
  private handlePhaseEffects(): void {
    const ev = this.movement.consumePhaseEvent();
    if (ev) {
      // Phase audio: enter WHUM + pitched exit tail.
      this.gameAudio.phaseTraversal();

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

  /**
   * Relative screen angle toward the damage source: 0 = ahead,
   * +PI/2 = right, ±PI = behind (matches the HUD indicator rotation).
   * Null when there is no attacker (kill plane, suicide…).
   */
  private damageAngleFrom(attacker: Combatant | null): number | null {
    if (!attacker || attacker === this.playerCombatant) return null;
    attacker.getPosition(this.attackerPos);
    this.player.getPosition(this.playerPos);
    this.toAttacker.subVectors(this.attackerPos, this.playerPos);
    this.toAttacker.y = 0;
    if (this.toAttacker.lengthSq() < 0.0001) return null;
    this.toAttacker.normalize();
    this.fpsCamera.getForward(this.fwdDir); // flat forward
    this.fpsCamera.getRight(this.rightDir);
    return Math.atan2(this.toAttacker.dot(this.rightDir), this.toAttacker.dot(this.fwdDir));
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
      dashKick: this.movement.isDashing
        ? 1
        : this.movement.isSpearRushing
          ? spearCfg.spearRushFovKick
          : 0,
      phaseKick: this.movement.phaseIntensity,
      undergroundDrop: this.moleStrike.cameraDrop,
    });
  }
}
