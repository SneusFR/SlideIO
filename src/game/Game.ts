import * as THREE from "three";
import { PhysicsWorld } from "../physics/PhysicsWorld";
import { InputManager } from "../input/InputManager";
import { FPSCamera } from "../camera/FPSCamera";
import { PlayerController } from "../player/PlayerController";
import { PlayerMovement, MoveState } from "../player/PlayerMovement";
import { JungleMap } from "../world/JungleMap";
import { YardMap } from "../world/YardMap";
import { YardEffects } from "../world/YardEffects";
import { YardSky } from "../world/YardSky";
import { YardConfig as yardCfg } from "../world/YardConfig";
import { SpaceSky } from "../world/SpaceSky";
import { SpaceConfig as spaceCfg } from "../world/SpaceConfig";
import { loadMapSelection } from "../world/MapSelection";
import { MapId } from "../../shared/map/MapRegistry";
import { YARD_SPAWN_POINTS } from "../../shared/map/YardSpawns";
import { JUNGLE_NAV_BOUNDS, YARD_NAV_BOUNDS } from "../navigation/NavGrid";
import { InteractHUD } from "../ui/InteractHUD";
import { DebugHUD } from "../ui/DebugHUD";
import { WeaponHUD } from "../ui/WeaponHUD";
import { DashHUD } from "../ui/DashHUD";
import { CombatHUD } from "../ui/CombatHUD";
import { BotsMenu } from "../ui/BotsMenu";
import { MovementConfig as cfg } from "../player/MovementConfig";
import { CombatConfig as cc } from "../combat/CombatConfig";
import { ParticleSystem } from "../effects/ParticleSystem";
import { Shockwave } from "../effects/Shockwave";
import { fxLights } from "../effects/FXLightPool";
import { PlasmaRifle } from "../weapons/PlasmaRifle";
import { HammerWeapon } from "../weapons/HammerWeapon";
import { HammerViewmodel } from "../weapons/HammerViewmodel";
import { SpearWeapon } from "../weapons/SpearWeapon";
import { SpearViewmodel } from "../weapons/SpearViewmodel";
import { SpearConfig as spearCfg } from "../weapons/SpearConfig";
import { SpearHUD } from "../ui/SpearHUD";
import { loadLoadout, MeleeWeaponId, PrimaryWeaponId } from "../loadout/Loadout";
import { ObliterreurWeapon } from "../weapons/obliterreur/ObliterreurWeapon";
import { RevolverWeapon } from "../weapons/revolver/RevolverWeapon";
import { loadRevolverTemplate } from "../weapons/revolver/RevolverModel";
import { RevolverHUD } from "../ui/RevolverHUD";
import { BassBlasterWeapon } from "../weapons/bassblaster/BassBlasterWeapon";
import { BassBlasterHUD } from "../ui/BassBlasterHUD";
import { PoisonWeapon } from "../weapons/poison/PoisonWeapon";
import { PoisonHUD } from "../ui/PoisonHUD";
import { HexSniperWeapon } from "../weapons/hexsniper/HexSniperWeapon";
import { HexSniperWorldAdapter } from "../weapons/hexsniper/HexSniperWorldAdapter";
import { HexSniperConfig as hexCfg } from "../weapons/hexsniper/HexSniperConfig";
import { ViewmodelSystem } from "../weapons/viewmodel/ViewmodelSystem";
import { MusicSelectorHUD } from "../ui/MusicSelectorHUD";
import { KillstreakManager } from "../killstreaks/KillstreakManager";
import { MoleStrike } from "../killstreaks/mole/MoleStrike";
import { MoleStrikeVFX } from "../killstreaks/mole/MoleStrikeVFX";
import { KillstreakHUD } from "../ui/KillstreakHUD";
import { TargetManager } from "../targets/TargetManager";
import { Combatant } from "../combat/Combatant";
import { PlayerCombatant } from "../combat/PlayerCombatant";
import { HitZone } from "../combat/HitZone";
import { HitFeedbackManager } from "../combat/HitFeedbackManager";
import { HitmarkerHUD } from "../ui/HitmarkerHUD";
import { DamageNumbersHUD } from "../ui/DamageNumbersHUD";
import { SpawnManager } from "../combat/SpawnManager";
import { NavGrid } from "../navigation/NavGrid";
import { BotManager } from "../bots/BotManager";
import { CorpseManager } from "../ragdoll/CorpseManager";
import { GameAudio } from "../audio/GameAudio";
import { PickupManager } from "../pickups/PickupManager";
import { PickupConfig } from "../pickups/PickupConfig";
import { ComboManager } from "../combo/ComboManager";
import { MedalManager } from "../medals/MedalManager";
import { MedalHUD } from "../ui/MedalHUD";
import { ComboHUD } from "../ui/ComboHUD";
import { MatchStatsManager } from "../stats/MatchStatsManager";
import { LeaderboardHUD } from "../ui/LeaderboardHUD";
import { NetworkDebugHUD } from "../ui/NetworkDebugHUD";
import { MultiplayerGameController } from "../network/MultiplayerGameController";
import type { MultiplayerClient } from "../network/MultiplayerClient";
import { KillMethod } from "../combat/KillMethod";
import { WeaponActionType } from "../../shared/combat/NetworkWeapons";
import type { HitConfirmedEvent } from "../../shared/combat/NetworkWeapons";
import { getQualitySettings } from "./GraphicsQuality";
import { clone as skeletonClone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { loadCharacterAsset, stripEnemyOutline } from "../characters/PotatoCharacter";

/**
 * Top-level game: rendering, main loop and wiring between subsystems.
 * FFA sandbox: the human player + up to 8 autonomous bots, everyone
 * hostile to everyone. In SOLO the game pauses while the pointer is
 * unlocked (Escape menu) so bots can't kill you while you tweak their
 * count. In MULTIPLAYER the match NEVER pauses — Escape only releases
 * the inputs; physics, damage and network events keep running.
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
  /** The active map's sky backdrop (SpaceSky on Jungle, YardSky on Yard). */
  private spaceSky: SpaceSky | YardSky | null = null;

  // ---- YARD map extras (null on the Jungle map) ----
  /** Which map this Game instance runs (fixed for the whole session). */
  readonly mapId: MapId;
  /** Acid + animations + terminals (ONE instance per loaded Yard map). */
  private yardEffects: YardEffects | null = null;
  private interactHud: InteractHUD | null = null;
  /**
   * True while a Yard interactable is in range THIS frame: F then belongs
   * to the terminal (interaction) — the weapon inspect (also F) yields.
   */
  private interactNearby = false;
  private readonly feetPos = new THREE.Vector3();

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

  // ---- REVOLVER (primary alternative — equipped via the Loadout menu) ----
  private revolver: RevolverWeapon;
  private revolverHud: RevolverHUD;

  // ---- BASS BLASTER (musical SMG — networked like the other primaries) ----
  private bassBlaster: BassBlasterWeapon;
  private bassBlasterHud: BassBlasterHUD;
  private musicSelector: MusicSelectorHUD;

  // ---- LANCE-POISON (short-range toxic sprayer with the living tank) ----
  private poison: PoisonWeapon;
  private poisonHud: PoisonHUD;

  // ---- HEX SNIPER (monster-head sniper: tongue grapple + bite) ----
  private hexSniper: HexSniperWeapon;

  // ---- Common FP viewmodel system (shared arms rig + dedicated FP pass;
  // HexSniper is the first migrated weapon — legacy viewmodels keep their
  // own camera-attached adapters until their pose libraries exist) ----
  private viewmodelSystem: ViewmodelSystem;

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
  /** Death-ragdoll corpses (bots + remote players) — physical, transient. */
  private corpses: CorpseManager;

  /** Non-null while running in MULTIPLAYER mode (Phase 2 transform sync). */
  private multiplayer: MultiplayerGameController | null = null;
  /** F1 network diagnostic overlay (multiplayer sessions only). */
  private netDebugHud: NetworkDebugHUD | null = null;
  /** The raw client, kept for weapon equip/action sends (Phase 5). */
  private multiplayerClient: MultiplayerClient | null = null;
  private playerCombatant: PlayerCombatant;
  private hitmarkerHud: HitmarkerHUD;
  private damageNumbersHud: DamageNumbersHUD;
  private hitFeedback: HitFeedbackManager;
  private readonly combatants: Combatant[] = [];
  private playerDeathTimer = 0;

  // ---- Phase 5: networked weapons (multiplayer only) ----
  /** Last WEAPON_EQUIP actually sent (dedup — resent on respawn). */
  private lastSentEquip = "";
  /** Plasma edge detection: local isFiring → PLASMA_START / PLASMA_STOP. */
  private netPlasmaWasFiring = false;
  /** ~10 Hz PLASMA_AIM refresh accumulator while firing. */
  private netPlasmaAimTimer = 0;
  /** Poison edge detection: local isSpraying → POISON_START / POISON_STOP. */
  private netPoisonWasSpraying = false;
  /** ~10 Hz POISON_AIM refresh accumulator while spraying. */
  private netPoisonAimTimer = 0;
  /** True once the local weapon callbacks have been network-wrapped. */
  private netCallbacksWrapped = false;
  /** Latest server-reported attacker position (directional damage HUD). */
  private readonly netAttackerPos = new THREE.Vector3();
  private netAttackerAge = Infinity;
  /** Server hitmarker throttle (plasma streams confirm at ~20 Hz). */
  private lastNetHitFeedback = -1;
  private readonly netOrigin = new THREE.Vector3();
  private readonly netDir = new THREE.Vector3();
  /** Bass Blaster grain metadata scratch (track / offset / note index). */
  private readonly netGrain = new THREE.Vector3();
  private readonly netImpulse = new THREE.Vector3();

  /** Static map meshes + target groups (never changes after startup). */
  private staticHittables: THREE.Object3D[] = [];
  /** Everything a beam can hit: statics + player proxy + bot models. */
  private hittables: THREE.Object3D[] = [];

  private lastTime = 0;
  private elapsed = 0;
  /** True once the one-time GPU warm-up pass has run. */
  private gpuWarmedUp = false;
  /**
   * Optional frame-rate cap: target milliseconds between rendered frames
   * (0 = uncapped). The deadline advances by one interval per accepted
   * tick, rather than imposing a minimum gap since the last render.
   * Actual cadence still depends on the browser and available CPU/GPU
   * budget; a cap cannot guarantee evenly presented images.
   * Duplicate rAF chains are a lifecycle bug, NOT a reason to impose a cap.
   */
  private frameIntervalMs: number;
  /** Next render deadline (performance.now() ms). 0 = not started. */
  private nextFrameAt = 0;
  /**
   * LOW preset: STATIC shadows — the map's shadow map is baked once (map
   * and lights never move; characters don't cast on LOW) instead of being
   * re-rendered per frame. Kills both the fixed per-frame caster pass and
   * the short/long frame cadence of the old half-rate refresh.
   */
  private readonly staticShadows: boolean;
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

  private constructor(
    container: HTMLElement,
    physics: PhysicsWorld,
    map: JungleMap | YardMap,
    mapId: MapId,
  ) {
    this.physics = physics;
    this.mapId = mapId;

    // Quality preset (auto-detected iGPU → LOW, override in the Escape
    // menu): resolution cap, MSAA, shadow budget — see GraphicsQuality.
    const quality = getQualitySettings();
    this.renderer = new THREE.WebGLRenderer({
      antialias: quality.antialias,
      powerPreference: "high-performance",
      // Enemy outline: the crisp red contour is a stencil-masked inverted
      // hull (see PotatoCharacter.getEnemyOutlineMaterial) — the default
      // drawing buffer must carry stencil bits (three defaults to false).
      stencil: true,
    });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.pixelRatioCap));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // LOW: the shadow map is BAKED (autoUpdate off) — the map and its
    // single shadow light are fully static, so one render at load time
    // (see warmUpRendering) serves every frame afterwards.
    this.staticShadows = quality.staticShadows;
    if (this.staticShadows) this.renderer.shadowMap.autoUpdate = false;
    // LOW: cap rendered frames (see frameIntervalMs doc). HIGH: uncapped (0).
    this.frameIntervalMs = Number.isFinite(quality.maxFps)
      ? 1000 / quality.maxFps
      : 0;
    // Light "color grading": filmic curve → deep blacks, cool highlights.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = spaceCfg.toneMappingExposure;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    // Shared FX light pool: created BEFORE any weapon/VFX so the scene
    // light count is final from the first shader compile (adding a light
    // later would force three.js to recompile every lit material).
    fxLights.init(this.scene);
    // Per-map atmosphere: each map owns its clear color, distance haze,
    // exposure and sky backdrop (added straight to the scene — NOT
    // map.group — so it is never part of the beam-raycast hittables and
    // never touches physics or the NavGrid).
    if (mapId === MapId.YARD) {
      // YARD: contaminated industrial dusk (see YardConfig).
      this.scene.background = new THREE.Color(yardCfg.backgroundColor);
      this.scene.fog = new THREE.Fog(yardCfg.fogColor, yardCfg.fogNear, yardCfg.fogFar);
      this.renderer.toneMappingExposure = yardCfg.toneMappingExposure;
      this.spaceSky = new YardSky();
      this.scene.add(this.spaceSky.group);
    } else {
      // JUNGLE: deep-space night — near-black clear color + a very light
      // violet-blue distance haze (never a ground fog).
      this.scene.background = new THREE.Color(spaceCfg.backgroundColor);
      this.scene.fog = new THREE.Fog(spaceCfg.fogColor, spaceCfg.fogNear, spaceCfg.fogFar);
      if (spaceCfg.spaceSkyEnabled) {
        this.spaceSky = new SpaceSky();
        this.scene.add(this.spaceSky.group);
      }
    }

    // Map visuals + exact Rapier colliders were already loaded/created in
    // Game.create (async) — just attach the group.
    this.scene.add(map.group);

    // Navigation must be built from STATIC geometry only — before any
    // character capsule (player or bot) exists in the physics world.
    // Refresh scene queries first: Rapier only indexes new colliders during
    // a step, so without this the NavGrid would see an EMPTY world and no
    // cell would be walkable (bots frozen in place).
    this.physics.refreshQueries();
    const isYard = mapId === MapId.YARD;
    this.nav = new NavGrid(this.physics, isYard ? YARD_NAV_BOUNDS : JUNGLE_NAV_BOUNDS);
    this.spawner = new SpawnManager(this.physics, isYard ? YARD_SPAWN_POINTS : undefined);

    this.input = new InputManager(this.renderer.domElement);
    this.fpsCamera = new FPSCamera(window.innerWidth / window.innerHeight);
    // Camera must be in the scene graph so the weapon view model renders.
    this.scene.add(this.fpsCamera.camera);
    this.player = new PlayerController(this.physics);
    // The default body position (MovementConfig.spawnPosition) belongs to
    // the Jungle map — on Yard, snap to one of ITS validated spawns now,
    // BEFORE the menu preview / camera flight read the player pose.
    if (isYard) {
      const s = YARD_SPAWN_POINTS[0];
      this.player.setPosition(s.x, s.y + 0.3, s.z);
    }
    this.movement = new PlayerMovement(this.player, this.input, this.fpsCamera);
    this.hud = new DebugHUD();
    this.weaponHud = new WeaponHUD();
    this.dashHud = new DashHUD();
    this.combatHud = new CombatHUD();
    this.phaseOverlayEl = document.getElementById("phase-overlay")!;

    // ---- Weapon / targets / effects ----
    this.particles = new ParticleSystem(this.scene);
    // YARD has NO training targets (per the map design) — the manager
    // still exists so weapon adapters keep working against empty lists.
    this.targets = new TargetManager(this.particles, !isYard);
    this.scene.add(this.targets.group);

    // ---- YARD: animations + acid + terminals (ONE instance per map) ----
    if (isYard && map instanceof YardMap) {
      this.yardEffects = new YardEffects(map, this.physics);
      this.interactHud = new InteractHUD();
      // Acid pool (solo/local): falling in kills through the normal death
      // flow (respawn timer + feedback). In MULTIPLAYER the server's
      // authoritative acid tick decides — the local hook only provides
      // instant feedback via the same server-driven death events, so we
      // skip the local kill there (see onHazard guard below).
      this.yardEffects.onHazard = () => {
        if (this.multiplayer) return; // server-authoritative in MP
        this.playerCombatant.health.kill(null);
      };
      // Terminals: clear extension point — no major mechanic invented.
      // Today: a satisfying local confirmation (sound + log). Multiplayer
      // rules must be validated by the server before granting any effect.
      this.yardEffects.onInteract = (item) => {
        this.gameAudio.medalPop(1.2); // "terminal activated" ping
        console.log(`[YARD] Terminal activé: ${item.id} (${item.label})`);
      };
    }
    this.rifle = new PlasmaRifle(this.scene, this.fpsCamera.camera, this.particles);

    // ---- Player as an FFA combatant ----
    this.playerCombatant = new PlayerCombatant(this.player, this.movement, this.scene);
    this.combatants.push(this.playerCombatant);
    this.rifle.owner = this.playerCombatant;
    // KNOCKDOWN feedback (§ ragdoll — bot parity for the local player):
    // the ground state + get-up input live in PlayerMovement — here a
    // readable camera punch (never a head-cam spin) and a clean drop of
    // any melee attack in progress (a knocked-down bot stops attacking
    // too; without this an interrupted Ground Slam would leave the hammer
    // stuck in SLAM_DIVE forever, waiting for a landing that never comes).
    this.playerCombatant.onKnockdown = (magnitude) => {
      this.fpsCamera.addShake(Math.min(0.4 + magnitude * 0.015, 0.9));
      this.hammer.reset();
      this.spear.reset();
      this.hexSniper.reset(); // a downed shooter releases the tongue
      this.meleeHoldPending = false;
    };

    // Hit-confirmation feedback (hitmarker + sound + victim reaction) —
    // LOCAL PLAYER only; weapons report every applied damage tick to it.
    // The HitmarkerHUD is kept as a field: in multiplayer the SERVER's
    // HIT_CONFIRMED events drive it directly (source of truth).
    this.hitmarkerHud = new HitmarkerHUD();
    this.damageNumbersHud = new DamageNumbersHUD();
    this.hitFeedback = new HitFeedbackManager(
      this.hitmarkerHud,
      this.particles,
      this.playerCombatant,
    );
    this.hitFeedback.damageNumbers = this.damageNumbersHud;
    this.rifle.feedback = this.hitFeedback;

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
    this.obliterreur.feedback = this.hitFeedback;
    this.obliterreur.onCameraShake = (amount) => this.fpsCamera.addShake(amount);

    // ---- REVOLVER (primary alternative — equipped from the Loadout menu):
    // LMB single shot, RMB fan fire (empties the cylinder), R explosive
    // throw + immediate holographic rematerialization of a fresh revolver.
    this.revolver = new RevolverWeapon(
      this.scene,
      this.fpsCamera.camera,
      this.combatants,
      this.particles,
      this.shockwave,
    );
    this.revolver.owner = this.playerCombatant;
    this.revolver.setFeedback(this.hitFeedback);
    this.revolver.onCameraShake = (amount) => this.fpsCamera.addShake(amount);
    this.revolverHud = new RevolverHUD();

    // ---- BASS BLASTER (musical SMG — equipped from the Loadout menu):
    // LMB full-auto note projectiles cycling Do→Do' colors, each shot
    // playing a positional micro-fragment of the selected music track;
    // R = musical note-swirl reload; ↑/↓ = track selection. In multiplayer
    // every shot is reported to the server (BASS_FIRE) with its grain.
    this.bassBlaster = new BassBlasterWeapon(
      this.scene,
      this.fpsCamera.camera,
      this.particles,
    );
    this.bassBlaster.owner = this.playerCombatant;
    this.bassBlaster.setFeedback(this.hitFeedback);
    this.bassBlaster.onCameraShake = (amount) => this.fpsCamera.addShake(amount);
    this.bassBlasterHud = new BassBlasterHUD();
    this.musicSelector = new MusicSelectorHUD();

    // ---- LANCE-POISON (primary alternative — equipped from the Loadout
    // menu): hold LMB → continuous short-range toxic spray. The voxel tank
    // displays the REAL charge and its liquid reacts to the player's
    // acceleration (morph-target inertia — see PoisonLiquidController).
    this.poison = new PoisonWeapon(this.fpsCamera.camera, this.particles);
    this.poison.owner = this.playerCombatant;
    this.poison.feedback = this.hitFeedback;
    this.poison.onCameraShake = (amount) => this.fpsCamera.addShake(amount);
    this.poisonHud = new PoisonHUD();

    // ---- HEX SNIPER (primary alternative — equipped from the Loadout
    // menu): LMB projects the creature's tongue (no max range — first
    // collision or map bounds; a grabbed player is physically reeled in),
    // RMB is a vigorous bite (two dedup'd contact windows, wall-occluded).
    // The world adapter implements the kit's five callbacks on the REAL
    // Rapier physics; bot/target rosters are read lazily (built later).
    const hexAdapter = new HexSniperWorldAdapter(
      this.physics,
      this.player.collider,
      this.player.body,
      () => this.botManager.bots,
      () => this.targets.targets,
    );
    // Common FP viewmodel system: shared Potato arms + dedicated FP scene
    // rendered AFTER the world with ONE depth clear (see frame()).
    this.viewmodelSystem = new ViewmodelSystem(window.innerWidth / window.innerHeight);
    this.hexSniper = new HexSniperWeapon(
      this.fpsCamera.camera,
      this.scene,
      hexAdapter,
      this.viewmodelSystem,
    );
    this.hexSniper.owner = this.playerCombatant;
    this.hexSniper.feedback = this.hitFeedback;
    this.hexSniper.onCameraShake = (amount) => this.fpsCamera.addShake(amount);
    // Arrows → weapon track cycle → UI mirrors the new active index.
    this.musicSelector.onCycle = (delta) => {
      this.bassBlaster.cycleTrack(delta);
      this.musicSelector.setActiveIndex(this.bassBlaster.music.currentTrackIndex);
    };

    // ---- Audio: pure observation of existing gameplay events ----
    this.gameAudio = new GameAudio();
    this.movement.sfx = this.gameAudio.movementSfx;
    this.rifle.onOverheat = () => this.gameAudio.overheat();
    this.hitFeedback.onBodyHitSound = () => this.gameAudio.hitBody();
    this.hitFeedback.onHeadshotSound = () => this.gameAudio.hitHead();
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
    // Revolver: ballistic gunshot sample + layered throw / explosion /
    // holographic-materialize cues (pure observers, gameplay untouched).
    this.revolver.onShot = (fanFire) => this.gameAudio.revolverShot(fanFire);
    this.revolver.onThrow = () => this.gameAudio.revolverThrow();
    this.revolver.onExplosion = (pos) => this.gameAudio.revolverExplosion(pos);
    this.revolver.onMaterializeStart = () => this.gameAudio.revolverMaterialize();
    // Bass Blaster: per-note pitched blip layered under the music grain,
    // reload swirl cues and spatial wall "plinks" (pure observers).
    this.bassBlaster.onShot = (note) => this.gameAudio.bassBlasterShot(note.pitch);
    this.bassBlaster.onReloadStart = () => this.gameAudio.bassBlasterReloadStart();
    this.bassBlaster.onReloadEnd = () => this.gameAudio.bassBlasterReloadEnd();
    this.bassBlaster.onWorldImpact = (pos, note) =>
      this.gameAudio.bassBlasterNoteImpact(pos, note.pitch);
    // Lance-Poison: reuse the existing energy/steam palette (pure observers).
    this.poison.onSprayStart = () => this.gameAudio.obliterreurActivate();
    this.poison.onSprayStop = () => this.gameAudio.obliterreurBeamEnd(true);
    this.poison.onReloadStart = () => this.gameAudio.bassBlasterReloadStart();
    this.poison.onReloadEnd = () => this.gameAudio.bassBlasterReloadEnd();
    // Hex Sniper: reuse the existing energy/impact palette (pure observers).
    this.hexSniper.onTongueStart = () => this.gameAudio.revolverThrow(); // whip cast
    this.hexSniper.onTongueGrab = () => this.gameAudio.phaseTraversal(); // energy latch
    this.hexSniper.onPlayerArrived = () => this.gameAudio.slamImpact(1); // heavy arrival
    this.hexSniper.onBiteStart = () => this.gameAudio.hammerSwing(); // jaw whoosh

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
      this.revolver.reset(); // fan fire dropped, fresh 6/6 for the respawn
      this.bassBlaster.reset(); // reload cancelled, notes cleared, fresh 30/30
      this.poison.reset(); // spray stopped, tank refilled for the respawn
      this.hexSniper.reset(); // tongue released mid-flight/pull, clean Idle
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
      // Medkits also top up the Bass Blaster's magazine: random 25–75%
      // of its capacity (clamped — never above a full magazine).
      const refillFraction =
        PickupConfig.medkitAmmoRefillMinFraction +
        Math.random() *
          (PickupConfig.medkitAmmoRefillMaxFraction -
            PickupConfig.medkitAmmoRefillMinFraction);
      this.bassBlaster.refillAmmo(refillFraction);
    };
    this.pickups.onCoinCollected = () => {
      // No economy yet: sound + disappear. A wallet hooks in here later.
      this.gameAudio.coinPickup();
    };

    // ---- Death ragdolls (corpses): one sink for bots AND remote players.
    // Owned by the Game — updated right after each physics step.
    this.corpses = new CorpseManager(this.scene, this.physics);

    // ---- Bots ----
    this.botManager = new BotManager(
      this.scene,
      this.physics,
      this.particles,
      this.nav,
      this.spawner,
      this.combatants,
      this.corpses,
    );
    this.botManager.onBotKilled = (bot, killer, method, hitZone) => {
      if (killer === this.playerCombatant) {
        this.combatHud.notifyKill();
        // LOCAL PLAYER kill only (bot-vs-bot never touches the combo):
        // +1 combo, timer refilled, bar punch, medals queued (combo medal
        // first, then the kill-method medal — HOMERUN / SMASHED).
        const count = this.combo.registerKill();
        this.comboHud.notifyKill();
        this.medals.onPlayerKill(count, method, hitZone === HitZone.HEAD);
        // Killstreak progress: every LOCKED slot advances by one kill.
        this.killstreaks.onPlayerKill();
        this.killstreakHud.notifyKill();
        // Kill-confirmed chime — the grisant payoff that begs for a chain.
        this.gameAudio.killConfirm();
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
      if (this.multiplayer) return; // bots stay disabled in multiplayer
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
      // The FP camera keeps its own projection (reference vertical FOV) —
      // its aspect must follow every resize too (16:9, 4:3, 21:9…).
      this.viewmodelSystem.setAspect(window.innerWidth / window.innerHeight);
    });
  }

  static async create(container: HTMLElement): Promise<Game> {
    const physics = await PhysicsWorld.create();
    // Load the SELECTED map BEFORE the Game constructor: the NavGrid and
    // the spawn system are built from the physics world during
    // construction, so every static collider must exist first. The map id
    // is persisted (menu MAP row / lobby join) and loaded exactly once per
    // page life — switching maps reloads the page (same pattern as the
    // graphics-quality preset).
    const mapId = loadMapSelection();
    const map =
      mapId === MapId.YARD ? await YardMap.create(physics) : await JungleMap.create(physics);
    return new Game(container, physics, map, mapId);
  }

  get domElement(): HTMLElement {
    return this.renderer.domElement;
  }

  requestPointerLock(): void {
    // User gesture → safe point to unlock the AudioContext (autoplay policy)
    // and kick off SFX preloading (cached — only the first call fetches).
    this.gameAudio.unlock();
    void this.gameAudio.preload();
    // SOLO: (re)apply the persisted loadout on every re-entry.
    // MULTIPLAYER: loadout changes made from the Escape menu only apply
    // on the NEXT RESPAWN (see onLocalRespawned) — never mid-life.
    if (!this.multiplayer) this.applyLoadout();
    this.input.requestPointerLock();
  }

  /**
   * One-time GPU warm-up: waits for every weapon GLB, then renders ONE
   * forced-visible frame so every shader is compiled and every texture is
   * uploaded while the menu / transition still covers the canvas.
   * Transient combat visuals that only exist mid-fight (thrown revolver
   * clone, shockwave rings, particles) are spawned far below the map for
   * that frame. Without this, the FIRST melee swing / revolver throw /
   * weapon reveal compiled shaders mid-fight — a visible freeze.
   */
  async warmUpRendering(): Promise<void> {
    if (this.gpuWarmedUp) return;
    this.gpuWarmedUp = true;

    // 1. Every async weapon asset must be parsed and attached first
    // (viewmodelSystem.ready = the shared FP arms rig; hexSniper.ready
    // resolves after its GLB is mounted on those arms). Errors are caught
    // per-weapon inside each loader — a failed asset never blocks warm-up.
    await Promise.all([
      this.rifle.ready,
      this.hammerViewmodel.ready,
      this.spearViewmodel.ready,
      this.obliterreur.ready,
      this.revolver.ready,
      this.bassBlaster.ready,
      this.poison.ready,
      this.viewmodelSystem.ready.catch((err) =>
        console.error("ViewmodelSystem: FP arms failed to load", err),
      ),
      this.hexSniper.ready,
    ]);

    // 2. Transient visuals that never exist at rest: a thrown-revolver
    // clone (opaque SHARED template materials ≠ the viewmodel's cloned
    // transparent ones) + a shockwave ring + particles, far below the map.
    const far = new THREE.Vector3(0, -400, 0);
    const temp: THREE.Object3D[] = [];
    try {
      const template = await loadRevolverTemplate();
      const thrown = template.clone(true);
      thrown.position.copy(far);
      temp.push(thrown);
    } catch {
      /* revolver asset failed — nothing to warm */
    }
    // FIRST-KILL PATH: a real kill spawns visuals that exist nowhere at
    // rest — a CORPSE (skinned clone re-skinned with the CorpseManager's
    // pooled TRANSPARENT fade materials: a different program cache key
    // than the living, opaque characters → the first corpse used to pay a
    // synchronous shader recompile, the "first kill freeze") and the LOOT
    // (medkit + coin GLBs + additive halo sprites: programs AND textures
    // never seen before). Warm both far below the map right now.
    let releaseCorpseMats: (() => void) | null = null;
    try {
      const asset = await loadCharacterAsset();
      const corpse = skeletonClone(asset.template);
      stripEnemyOutline(corpse); // real corpses never keep the red outline
      corpse.position.copy(far);
      releaseCorpseMats = this.corpses.warmUp(corpse);
      temp.push(corpse);
    } catch {
      /* character asset failed — nothing to warm */
    }
    try {
      for (const loot of await this.pickups.createWarmUpVisuals()) {
        loot.position.copy(far);
        temp.push(loot);
      }
    } catch {
      /* pickup assets failed — nothing to warm */
    }
    for (const obj of temp) this.scene.add(obj);
    this.shockwave.spawn(far, 1, 0.5, this.phaseColor);
    this.particles.burst(far, 4, 1, 0.3, this.phaseColor, 0);
    this.shockwave.update(0.01);
    this.particles.update(0.01);

    // 3. Forced-visible renders: hidden viewmodels (hammer, spear,
    // revolver, obliterreur, bass blaster), beams / impact meshes and
    // pooled VFX meshes all get their programs compiled + textures
    // uploaded right now. LIGHTS ARE NEVER TOUCHED: forcing a hidden
    // light visible would change the scene light count, and light-count
    // changes recompile every lit material (a freeze). A few frames are
    // rendered so drivers that link programs lazily finish before play.
    const saved: { obj: THREE.Object3D; visible: boolean; culled: boolean }[] = [];
    this.scene.traverse((obj) => {
      if ((obj as THREE.Light).isLight) return; // keep the light count real
      saved.push({ obj, visible: obj.visible, culled: obj.frustumCulled });
      obj.visible = true;
      obj.frustumCulled = false;
    });
    this.scene.updateMatrixWorld(true);
    for (let i = 0; i < 2; i++) {
      this.renderer.render(this.scene, this.fpsCamera.camera);
    }

    // FP scene warm-up: force the arms + mounted weapon visible for a few
    // frames so their shaders compile and textures upload NOW — the first
    // HexSniper equip must never freeze mid-fight. FP lights are permanent
    // (never toggled), so the FP light count is already the runtime one.
    const fpWasVisible = this.viewmodelSystem.visible;
    this.viewmodelSystem.setVisible(true);
    this.viewmodelSystem.syncCamera(this.fpsCamera.camera);
    for (let i = 0; i < 2; i++) this.viewmodelSystem.render(this.renderer);
    this.viewmodelSystem.setVisible(fpWasVisible);

    // End the remote-VFX warm-up (multiplayer) and render again so the
    // scene is compiled in its REAL runtime state (all FX lights are
    // pooled now — the light count never changes — but the warm-up owns
    // transient meshes/materials that must be gone before the bake below).
    this.multiplayer?.vfx.finishWarmUp();
    for (let i = 0; i < 2; i++) {
      this.renderer.render(this.scene, this.fpsCamera.camera);
    }

    for (const s of saved) {
      s.obj.visible = s.visible;
      s.obj.frustumCulled = s.culled;
    }

    // STATIC shadows (LOW): bake the shadow map ONCE, now that every
    // transient warm-up object is back to its real visibility — only the
    // static map casters render into it. Characters don't cast shadows on
    // this preset (see PotatoCharacter), so the bake never goes stale.
    if (this.staticShadows) {
      this.renderer.shadowMap.needsUpdate = true;
      this.renderer.render(this.scene, this.fpsCamera.camera);
    }

    // 4. Cleanup: transient warm objects removed, pools back at rest.
    // The corpse fade clones return to the CorpseManager pool with their
    // compiled programs kept warm — the first real corpse reuses them.
    for (const obj of temp) this.scene.remove(obj);
    releaseCorpseMats?.();
    this.shockwave.update(10);
    this.particles.update(10);

    // 5. Audio buffers decode in the background (no gesture required).
    void this.gameAudio.preload();
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
    // Primary swap: a clean slate — active vortex cancelled, anchors gone,
    // revolver back to a full ready cylinder.
    if (selection.primary !== this.primaryWeapon) {
      this.primaryWeapon = selection.primary;
      this.obliterreur.reset();
      this.revolver.reset();
      this.bassBlaster.reset();
      this.poison.reset(); // fresh full tank + liquid motion memory cleared
      this.hexSniper.reset(); // unequip cancels any tongue/bite in progress
    }
    // MULTIPLAYER: the server must know the equipped primary (loadout ids
    // are IDENTICAL strings to NetworkWeaponId — no mapping table).
    this.sendNetworkEquip();
    const melee = selection.melee;
    if (melee === this.meleeWeapon) return;
    this.meleeWeapon = melee;
    this.hammer.reset();
    this.spear.reset();
    this.meleeHoldPending = false;
  }

  /**
   * Switch this Game instance to MULTIPLAYER mode (call BEFORE start()).
   * Same map / player controller / weapons as solo — only bots are
   * disabled and a network controller mirrors the other players.
   * The SERVER-assigned spawn is applied to the local physics body.
   */
  async enableMultiplayer(client: MultiplayerClient): Promise<void> {
    this.multiplayerClient = client;
    this.multiplayer = new MultiplayerGameController(
      client,
      this.scene,
      this.fpsCamera,
      this.player,
      this.movement,
    );
    await this.multiplayer.preload();
    // Remote plasma beams are visually blocked by the static world.
    this.multiplayer.setRaycastTargets(this.staticHittables);
    // Remote obliterreur beams emit the same suction/spark particles.
    this.multiplayer.setParticles(this.particles);
    // Remote deaths snapshot a physical ragdoll corpse (visual only —
    // the server's combat state stays the single source of truth).
    this.multiplayer.remotes.setCorpseManager(this.corpses);

    // Phase 2 multiplayer runs with 0 bots (solo mode keeps them working).
    // The Escape-menu bots panel is FULLY removed (inline display:none —
    // never a class the panel's own CSS could override).
    this.botManager.setBotCount(0);
    this.rebuildHittables();
    const botsMenuEl = document.getElementById("bots-menu");
    if (botsMenuEl) botsMenuEl.style.display = "none";

    // Apply the loadout selected in the MAIN MENU before entering the map
    // (afterwards, Escape-menu loadout changes only apply on respawn).
    this.applyLoadout();

    // Instantiate the remote avatars NOW (the roster is already known
    // from the lobby) so their skinned meshes + nametags compile during
    // the warm-up render below instead of on the first gameplay frame.
    this.multiplayer.update(0);

    // GPU warm-up: everything (viewmodels, melee weapons, thrown revolver,
    // shockwaves, particles) is loaded, compiled and uploaded BEFORE the
    // player enters the map — gameplay must be fluid from frame one.
    await this.warmUpRendering();

    // Spawn where the server decided (position + facing, velocity zeroed).
    this.multiplayer.applyServerSpawn();

    // ---- PHASE 4: SERVER-AUTHORITATIVE COMBAT STATE ----

    // Leaderboard source switches to the SERVER K/D/A (room.state.players):
    // ALL real players appear on every client, host has zero priority.
    // The local MatchStatsManager stops driving the HUD (solo/bots only).
    this.matchStats.onStatsChanged = null;
    this.multiplayer.onStatsChanged = (stats) => this.leaderboardHud.refresh(stats);

    // Server-owned HP mirrored into the existing local Health (HUD +
    // damage feedback reuse). The client NEVER writes HP back to the server.
    this.multiplayer.onLocalHealthChanged = (health) => {
      const h = this.playerCombatant.health;
      if (!h.alive) return; // death/respawn transitions own the resets
      if (health < h.current) {
        const amount = h.current - health;
        h.current = Math.max(1, health); // never let LOCAL math flip death
        h.onDamaged?.(amount, null); // reuse the existing damage feedback
      } else {
        h.current = Math.min(h.max, health);
      }
    };

    // Death is decided BY THE SERVER (isAlive/PLAYER_DIED) — reuse the
    // whole existing death flow (control loss, weapons reset, feedback).
    this.multiplayer.onLocalDied = () => {
      this.playerCombatant.health.kill(null);
    };

    // Server respawn: the controller already teleported the body + camera;
    // restore HP/protection and hand control back (weapons re-enabled).
    this.multiplayer.onLocalRespawned = () => {
      this.playerDeathTimer = 0;
      // The loadout picked from the Escape menu applies HERE — changes
      // are effective on the NEXT respawn, never mid-life.
      this.applyLoadout();
      this.playerCombatant.health.reset(cc.spawnProtectionDuration);
      this.gameAudio.playerRespawn();
      // Equip is refused while dead — re-assert it after every respawn.
      this.sendNetworkEquip(true);
      this.netPlasmaWasFiring = false;
      this.netPoisonWasSpraying = false;
    };

    // Server-confirmed kill by the local player → existing kill feedback
    // (combo + medals + killstreak progress, exactly like the solo flow).
    this.multiplayer.onLocalKill = (isHeadshot, damageType) =>
      this.handleNetworkKill(isHeadshot, damageType);

    // ---- PHASE 5: SERVER-AUTHORITATIVE WEAPONS ----

    // The SERVER's HIT_CONFIRMED is the only hitmarker source in MP
    // (local prediction cannot hit remote players — they have no local
    // Combatant, so there is no double feedback to suppress).
    this.multiplayer.onHitConfirmed = (event) => this.handleNetworkHitConfirmed(event);

    // Victim-side: remember the attacker position briefly so the existing
    // directional damage indicator works when the HP mirror reports it.
    this.multiplayer.onDamageTaken = (event) => {
      if (typeof event.ax === "number") {
        this.netAttackerPos.set(event.ax, event.ay ?? 0, event.az ?? 0);
        this.netAttackerAge = 0;
      }
    };

    // Server knockback → local physics impulse (never a teleport).
    this.multiplayer.onApplyImpulse = (x, y, z) =>
      this.playerCombatant.applyImpulse(this.netImpulse.set(x, y, z));

    // Local weapon events → WEAPON_ACTION sends (wrap, never replace).
    this.wrapNetworkWeaponCallbacks();
    // Tell the server which primary we start with.
    this.sendNetworkEquip(true);

    // F1 — Network Debug HUD (diagnostics for real Internet sessions).
    this.netDebugHud = new NetworkDebugHUD(() =>
      this.multiplayer ? this.multiplayer.getNetworkDebugReport() : null,
    );
  }

  /** Tear down the multiplayer session (leave game / connection lost). */
  disableMultiplayer(): void {
    this.netDebugHud?.dispose();
    this.netDebugHud = null;
    this.multiplayer?.dispose();
    this.multiplayer = null;
    this.multiplayerClient = null;
    this.lastSentEquip = "";
    this.netPlasmaWasFiring = false;
    this.netPoisonWasSpraying = false;
    const botsMenuEl = document.getElementById("bots-menu");
    if (botsMenuEl) botsMenuEl.style.display = "";
    // Back to LOCAL mode: the MatchStatsManager drives the leaderboard again.
    this.matchStats.onStatsChanged = () =>
      this.leaderboardHud.refresh(this.matchStats.getSortedStats());
    this.matchStats.onStatsChanged();
  }

  start(): void {
    this.releaseMenuPreview();
    this.lastTime = performance.now();
    this.nextFrameAt = 0;
    this.hud.resetFrameStats();
    // Replace the callback of the running preview/transition chain. Never
    // stop/restart it from inside its callback (see beginMenuPlayTransition).
    this.renderer.setAnimationLoop((timestamp) => this.frame(timestamp));
  }

  // ------------------------------------------------------------------
  // MAIN MENU PREVIEW — the real map rendered as a living menu backdrop
  // ------------------------------------------------------------------

  /** Non-null while the cinematic menu preview loop owns the renderer. */
  private menuPreview: {
    camera: THREE.PerspectiveCamera;
    elapsed: number;
    onResize: () => void;
  } | null = null;

  /**
   * Start the cinematic MENU PREVIEW: an elevated camera slowly orbiting
   * the actual map (real lighting / assets / sky), rendered by the SAME
   * renderer and scene the gameplay uses — no second scene, no duplicate
   * GPU resources. Physics / AI / combat are NOT stepped: the world is
   * purely observed, so nothing can happen to the player from the menu.
   */
  startMenuPreview(): void {
    if (this.menuPreview) return;
    const camera = new THREE.PerspectiveCamera(
      48,
      window.innerWidth / window.innerHeight,
      0.1,
      400,
    );
    const onResize = () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
    };
    window.addEventListener("resize", onResize);
    this.menuPreview = { camera, elapsed: 0, onResize };

    // Shadows: render one fresh pass for the preview even on the LOW
    // preset (autoUpdate=false) — the scene is static afterwards.
    if (this.staticShadows) this.renderer.shadowMap.needsUpdate = true;

    this.lastTime = performance.now();
    this.renderer.setAnimationLoop(() => this.menuPreviewFrame());
  }

  private readonly menuLookAt = new THREE.Vector3(0, 1.0, 0);

  private menuPreviewFrame(): void {
    const p = this.menuPreview;
    if (!p) return;
    const now = performance.now();
    // Same optional frame-rate cap as gameplay; keep the menu GPU budget low.
    if (this.frameCapSkip(now)) return;
    const dt = Math.min((now - this.lastTime) / 1000, 1 / 20);
    this.lastTime = now;
    p.elapsed += dt;

    // Slow cinematic orbit inside the dome: elevated, slightly angled
    // top-down, with a gentle radius drift + height bob so the shot
    // never feels mechanical.
    const angle = 0.55 + p.elapsed * 0.035; // very slow orbit
    const radius = 30 + Math.sin(p.elapsed * 0.11) * 2.5;
    const height = 12.2 + Math.sin(p.elapsed * 0.17) * 0.7;
    p.camera.position.set(
      Math.cos(angle) * radius,
      height,
      Math.sin(angle) * radius * 0.82,
    );
    p.camera.lookAt(this.menuLookAt);

    // The animated backdrop keeps living behind the map — and on YARD the
    // acid/fans/cameras loop breathes in the menu preview too (no player
    // feet → no hazard/interaction checks).
    this.spaceSky?.update(dt, p.elapsed, p.camera);
    this.yardEffects?.update(dt, null);

    this.renderer.render(this.scene, p.camera);
  }

  /**
   * CLICK TO PLAY transition: fly the cinematic camera down to the
   * player's first-person eye pose (position + orientation + FOV), then
   * hand the renderer back. Resolves when the flight is complete — the
   * caller then runs start() and gameplay begins seamlessly.
   */
  beginMenuPlayTransition(durationMs = 950): Promise<void> {
    const p = this.menuPreview;
    if (!p) return Promise.resolve();

    // Compute the exact gameplay camera pose (player eye at spawn).
    this.updateCamera(0);
    this.fpsCamera.camera.updateMatrixWorld(true);
    const targetPos = this.fpsCamera.camera.getWorldPosition(new THREE.Vector3());
    const targetQuat = this.fpsCamera.camera.getWorldQuaternion(new THREE.Quaternion());
    const targetFov = this.fpsCamera.camera.fov;

    const startPos = p.camera.position.clone();
    const startQuat = p.camera.quaternion.clone();
    const startFov = p.camera.fov;
    const t0 = performance.now();

    return new Promise((resolve) => {
      this.renderer.setAnimationLoop(() => {
        if (this.menuPreview !== p) return;
        // Same frame-rate cap as gameplay (LOW) — time-based easing, so
        // skipped ticks never change the flight duration.
        const nowMs = performance.now();
        if (this.frameCapSkip(nowMs)) return;
        const t = Math.min((nowMs - t0) / durationMs, 1);
        // Smooth ease-in-out (accelerate → glide in).
        const e = t * t * (3 - 2 * t);
        p.camera.position.lerpVectors(startPos, targetPos, e);
        p.camera.quaternion.slerpQuaternions(startQuat, targetQuat, e);
        p.camera.fov = startFov + (targetFov - startFov) * e;
        p.camera.updateProjectionMatrix();
        this.renderer.render(this.scene, p.camera);
        if (t >= 1) {
          // Three r185 queues the next rAF AFTER this callback returns,
          // even if setAnimationLoop(null) was called inside it. Stopping
          // here then restarting after await would leave TWO rAF chains.
          // Only release preview resources; start() replaces this callback
          // on the SAME running chain. The guard above makes it idle if
          // the caller delays the handoff.
          this.releaseMenuPreview();
          resolve();
        }
      });
    });
  }

  /**
   * Live frame-rate cap change (Escape-menu FPS LIMIT button). Unlike the
   * graphics preset (MSAA is fixed at context creation → reload), the cap
   * is pure loop pacing — it applies instantly to the menu preview, the
   * play transition and gameplay. Infinity/0 = uncapped.
   */
  setFpsCap(maxFps: number): void {
    this.frameIntervalMs =
      Number.isFinite(maxFps) && maxFps > 0 ? 1000 / maxFps : 0;
    this.nextFrameAt = 0; // re-anchor the deadline on the next tick
  }

  /**
   * External stop (multiplayer preparation). Do NOT call from a renderer
   * callback: Three queues another rAF after that callback returns.
   */
  stopMenuPreview(): void {
    if (!this.menuPreview) return;
    this.renderer.setAnimationLoop(null);
    this.releaseMenuPreview();
  }

  /** Release preview resources WITHOUT stopping the shared animation chain. */
  private releaseMenuPreview(): void {
    const p = this.menuPreview;
    if (!p) return;
    this.menuPreview = null;
    window.removeEventListener("resize", p.onResize);
  }

  /** Rebuild the beam raycast list after the bot roster changes. */
  private rebuildHittables(): void {
    this.hittables.length = 0;
    for (const h of this.staticHittables) this.hittables.push(h);
    this.hittables.push(this.playerCombatant.hitProxy);
    for (const bot of this.botManager.bots) this.hittables.push(bot.model.group);
  }

  /**
   * Frame-cap deadline gate (see frameIntervalMs). Returns true when this
   * rAF tick must be SKIPPED (deadline not reached yet). On a rendered
   * frame the deadline advances by exactly one interval — anti-spiral: if
   * the frame was slow (or the tab hidden) and we're already more than one
   * interval late, re-anchor to now instead of accumulating a debt that
   * would force a burst of back-to-back frames.
   */
  private frameCapSkip(now: number): boolean {
    if (this.frameIntervalMs <= 0) return false; // uncapped (HIGH)
    if (this.nextFrameAt === 0) {
      this.nextFrameAt = now + this.frameIntervalMs; // first frame anchors
      return false;
    }
    // 2 ms early-acceptance tolerance: on a HEALTHY 60 Hz rAF loop, vsync
    // jitter makes ticks land ±fractions of a ms around the deadline — a
    // strict compare would reject a 0.1 ms-early tick and halve the rate
    // to 30 (beat). 2 ms accepts jittery on-time ticks but still rejects
    // the genuinely-early ticks of a >60 Hz loop (8–12 ms ahead).
    if (now < this.nextFrameAt - 2) return true; // too early — skip tick
    this.nextFrameAt += this.frameIntervalMs;
    if (this.nextFrameAt < now) this.nextFrameAt = now + this.frameIntervalMs;
    return false;
  }

  private frame(timestamp: number): void {
    const now = performance.now();
    // Count ALL callbacks (including capped ticks), but never simulate or
    // render twice for one rAF timestamp. The HUD exposes duplicates rather
    // than allowing them to masquerade as extra FPS.
    if (!this.hud.sampleAnimationFrame(timestamp)) return;

    // FRAME-RATE CAP (LOW preset — see frameIntervalMs): skip rAF ticks
    // ahead of the render deadline. Nothing is lost on a skipped tick:
    // lastTime is NOT advanced (the next processed frame's dt covers the
    // skipped time), mouse deltas keep accumulating in the InputManager,
    // and edge inputs (wasPressed…) stay pending until input.endFrame() —
    // which only runs on processed frames.
    if (this.frameCapSkip(now)) return;

    // RAW frame delta (for the FPS/frame-time stats ONLY — feeding the
    // clamped dt to the counter capped it at 30 FPS and hid every drop).
    const rawDt = (now - this.lastTime) / 1000;
    // Clamp dt so a background tab doesn't teleport the player.
    const dt = Math.min(rawDt, 1 / 30);
    this.lastTime = now;
    this.elapsed += dt;

    // SOLO: the game is PAUSED while the pointer is unlocked (Escape menu):
    // no AI, no physics, no damage — bots can't kill you in the menu.
    // MULTIPLAYER: the match NEVER pauses. Escape / focus loss only releases
    // the inputs (the InputManager clears every key on unlock) while
    // physics, knockback, damage, weapon timers and network sends keep
    // running — otherwise the other players would see a frozen, hovering,
    // unhittable ghost until this client clicks back in.
    const running = this.multiplayer !== null || this.input.pointerLocked;
    const playerAlive = this.playerCombatant.health.alive;

    if (running) {
      this.fpsCamera.handleMouse(this.input.mouseDX, this.input.mouseDY);
      // Assist-window clock: game time, so the Escape menu never expires
      // recent damage contributions while everything is frozen.
      this.matchStats.setTime(this.elapsed);
      this.playerCombatant.health.update(dt);

      if (playerAlive) {
        // Melee is blocked for the whole MOLE STRIKE (burrow → eruption)
        // and while KNOCKED DOWN (§ ragdoll — a downed bot can't attack).
        if (!this.moleStrike.blocksWeapons && !this.movement.isKnockedDown) {
          this.handleMeleeInput(dt);
        }
        this.movement.update(dt);
        // AFTER movement: E while burrowed emerges here instead of dashing
        // (the movement itself refuses to dash while UNDERGROUND).
        // No killstreak can be triggered from the ground (§ ragdoll).
        if (!this.movement.isKnockedDown) this.handleKillstreakInput();

        // Ground Slam AoE: fires on the REAL ground contact of the dive
        // (reported by the movement state machine) — never on a timer.
        const slamImpact = this.movement.consumeSlamImpact();
        if (slamImpact) this.hammer.onSlamLanded(slamImpact);

        // Spear rush lifecycle: the movement reports WHY the charge ended
        // (wall / timeout — a tip hit is stopped by the weapon itself).
        const rushEnd = this.movement.consumeSpearRushEnd();
        if (rushEnd) {
          this.spear.onRushEnded(rushEnd);
          this.netSendAimedAction(WeaponActionType.SPEAR_RUSH_STOP);
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
      // HEX SNIPER simulation at the game's physics step, BEFORE the step:
      // the tongue sweep sees the current world and the pull writes the
      // victim's setNextKinematicTranslation, integrated by step() below.
      // Runs even while the viewmodel is hidden — an active attack is never
      // dropped just because it is off-screen.
      this.hexSniper.fixedUpdate(dt);
      this.physics.step(dt);
      // Corpses: bodies were just integrated — sync visuals, lifetimes,
      // fades and the max-corpse cap (cheap when no corpse exists).
      this.corpses.update(dt);
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

    // YARD: single mixer (bubbles/fans/cameras/terminal) + acid shader
    // clock. Decorative motion keeps living in the Escape menu (like the
    // sky); the hazard check only receives the feet WHILE RUNNING so the
    // acid can never kill a paused solo player. Feet = capsule center − 0.9.
    if (this.yardEffects) {
      let feet: THREE.Vector3 | null = null;
      if (running && playerAlive) {
        this.player.getPosition(this.feetPos);
        this.feetPos.y -= cfg.standHalfHeight + cfg.capsuleRadius;
        feet = this.feetPos;
      }
      this.yardEffects.update(dt, feet);

      // Terminal prompt + F to interact (blocked while dead / paused).
      // While an interactable is in range, F is the INTERACT key — the
      // weapon inspect (same key) is suppressed via interactNearby.
      if (feet) {
        const item = this.yardEffects.nearby(feet, this.player.collider);
        this.interactHud?.setPrompt(item ? item.label : null);
        this.interactNearby = item !== null;
        if (item && this.input.wasPressed("KeyF")) {
          this.yardEffects.interact(feet, this.player.collider);
        }
      } else {
        this.interactHud?.setPrompt(null);
        this.interactNearby = false;
      }
    } else {
      this.interactNearby = false;
    }

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
      // when another primary (OBLITERREUR / REVOLVER) is equipped.
      const obliEquipped = this.primaryWeapon === "OBLITERREUR";
      const revolverEquipped = this.primaryWeapon === "REVOLVER";
      const bassEquipped = this.primaryWeapon === "BASS_BLASTER";
      const poisonEquipped = this.primaryWeapon === "POISON_SPRAYER";
      const hexEquipped = this.primaryWeapon === "HEX_SNIPER";
      // KNOCKED DOWN (§ ragdoll) blocks EVERY weapon — exactly like a
      // ragdolled bot never fires. In-flight projectiles / explosions of
      // course keep ticking; only NEW actions are gated.
      const meleeBlocked =
        this.hammer.blocksFiring ||
        this.spear.blocksFiring ||
        this.moleStrike.blocksWeapons ||
        this.movement.isKnockedDown;
      const wantFire =
        playerAlive &&
        this.input.pointerLocked &&
        this.input.isMouseDown(0) &&
        !meleeBlocked &&
        !obliEquipped &&
        !revolverEquipped &&
        !bassEquipped &&
        !poisonEquipped &&
        !hexEquipped;
      this.rifle.setViewmodelHidden(
        this.hammer.isBusy ||
          this.spear.isBusy ||
          this.moleStrike.active ||
          obliEquipped ||
          revolverEquipped ||
          bassEquipped ||
          poisonEquipped ||
          hexEquipped,
      );
      this.rifle.update(dt, wantFire, this.hittables, this.elapsed);
      // MULTIPLAYER: plasma has no callbacks — edge-detect isFiring here
      // (START/STOP) + a silent ~10 Hz aim refresh while the beam is on.
      if (this.multiplayer) this.updateNetworkPlasma(dt);

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

      // REVOLVER: LMB single shot, RMB committed fan fire, R explosive
      // throw. Perfect accuracy is inside the weapon (camera-center ray);
      // thrown projectiles / explosions keep ticking even while blocked.
      this.revolver.setViewmodelHidden(
        !revolverEquipped || this.hammer.isBusy || this.spear.isBusy || this.moleStrike.active,
      );
      this.revolver.update(dt, {
        firePressed: revolverEquipped && this.input.wasMousePressed(0),
        fanFirePressed: revolverEquipped && this.input.wasMousePressed(2),
        throwPressed: revolverEquipped && this.input.wasPressed("KeyR"),
        canAct: revolverEquipped && playerAlive && !meleeBlocked,
        hittables: this.hittables,
        time: this.elapsed,
      });

      // BASS BLASTER: LMB full-auto note projectiles + music grains,
      // R musical reload, ↑/↓ track selection. In multiplayer each shot
      // sends a BASS_FIRE action (see wrapNetworkWeaponCallbacks); the
      // in-flight notes keep ticking even while blocked.
      this.bassBlaster.setViewmodelHidden(
        !bassEquipped || this.hammer.isBusy || this.spear.isBusy || this.moleStrike.active,
      );
      this.bassBlaster.update(dt, {
        fireHeld:
          bassEquipped &&
          this.input.pointerLocked &&
          this.input.isMouseDown(0) &&
          !meleeBlocked,
        reloadPressed: bassEquipped && this.input.wasPressed("KeyR"),
        canAct: bassEquipped && playerAlive && !meleeBlocked,
        hittables: this.hittables,
        time: this.elapsed,
      });
      // Track selection arrows (expand the selector panel on interaction).
      if (bassEquipped && this.input.pointerLocked) {
        if (this.input.wasPressed("ArrowUp")) this.musicSelector.interact(-1);
        if (this.input.wasPressed("ArrowDown")) this.musicSelector.interact(1);
      }

      // LANCE-POISON: hold LMB → continuous short-range toxic spray,
      // R → tank refill (progressive — the liquid visibly rises). The
      // living tank (fill + inertial surface + bubbles) is fed the REAL
      // physics velocity every frame, even while not firing.
      this.poison.setViewmodelHidden(
        !poisonEquipped || this.hammer.isBusy || this.spear.isBusy || this.moleStrike.active,
      );
      this.poison.update(dt, {
        fireHeld:
          poisonEquipped &&
          this.input.pointerLocked &&
          this.input.isMouseDown(0) &&
          !meleeBlocked,
        reloadPressed: poisonEquipped && this.input.wasPressed("KeyR"),
        canAct: poisonEquipped && playerAlive && !meleeBlocked,
        hittables: this.hittables,
        velocity: this.movement.velocity,
        time: this.elapsed,
      });
      // MULTIPLAYER: poison has no per-shot callback — edge-detect the
      // continuous stream exactly like the plasma (START/STOP + ~10 Hz aim).
      if (this.multiplayer) this.updateNetworkPoison(dt);

      // HEX SNIPER: LMB fires the tongue (near-instant sniper shot; a
      // reeled-in player is bitten INSTANTLY on arrival — a missed tongue
      // never bites and re-arms the shot the moment it returns),
      // RMB HELD = classic sniper ADS ×4 (crosshair zoom — no bite on RMB).
      // Visual mixer/tether update runs once per render frame (inside).
      this.hexSniper.setViewmodelHidden(
        !hexEquipped || this.hammer.isBusy || this.spear.isBusy || this.moleStrike.active,
      );
      this.hexSniper.update(dt, {
        firePressed:
          hexEquipped && playerAlive && !meleeBlocked && this.input.wasMousePressed(0),
        zoomHeld: this.input.isMouseDown(2),
        // F = affectionate inspection (classic FPS inspect key). F is
        // shared with the Yard terminal interaction: when an interactable
        // is in range (interactNearby), the terminal wins and the inspect
        // is suppressed — otherwise F is free for the weapon. Visual only.
        inspectPressed:
          hexEquipped && !this.interactNearby && this.input.wasPressed("KeyF"),
        canAct: hexEquipped && playerAlive && !meleeBlocked && this.input.pointerLocked,
        grounded: this.movement.grounded,
        verticalVelocity: this.movement.velocity.y,
        jumpSequence: this.movement.jumpSequence,
        sliding: this.movement.state === MoveState.SLIDING,
        speed: this.movement.horizontalSpeed,
      });


      this.botManager.updateWeapons(dt, this.hittables, this.elapsed);
      this.handlePhaseEffects();
      this.particles.update(dt);
      this.shockwave.update(dt);

      // Combo window countdown + medal queue presentation (paused with
      // the game so the Escape menu never eats your combo).
      this.combo.update(dt);
      this.medals.update(dt);
      this.hitFeedback.update(dt);
      this.damageNumbersHud.update(dt, this.fpsCamera.camera);
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

    this.hud.update(rawDt, this.movement, this.scene);
    this.weaponHud.update(dt, this.rifle.heat, this.rifle.hittingTarget);
    this.dashHud.update(dt, this.movement);
    this.spearHud.setVisible(this.meleeWeapon === "SPEAR");
    this.spearHud.update(this.spear);
    this.revolverHud.setVisible(this.primaryWeapon === "REVOLVER");
    this.revolverHud.update(this.revolver);
    this.bassBlasterHud.setVisible(this.primaryWeapon === "BASS_BLASTER");
    this.bassBlasterHud.update(this.bassBlaster);
    this.musicSelector.setVisible(this.primaryWeapon === "BASS_BLASTER");
    this.musicSelector.update(dt);
    this.poisonHud.setVisible(this.primaryWeapon === "POISON_SPRAYER");
    this.poisonHud.update(this.poison);
    this.combatHud.update(dt, this.playerCombatant.health, this.playerDeathTimer);
    // Knockdown banner (§ ragdoll): down → "KNOCKED DOWN", recoverable →
    // pulsing "PRESS SPACE TO GET UP" (a death always hides it).
    this.combatHud.setKnockdown(
      playerAlive && this.movement.isKnockedDown,
      this.movement.canGetUp,
    );
    this.comboHud.update(this.combo);

    // Multiplayer (Phase 2): remote avatars + fixed-rate transform send.
    // Runs its own network accumulator — never one send per render frame.
    this.multiplayer?.update(dt);
    this.netDebugHud?.update(dt); // F1 overlay (throttled; free when hidden)
    this.netAttackerAge += dt; // network damage-direction memory decays

    // FX light pool: assign this frame's light requests (weapon flashes,
    // impacts, explosions…) to the 2 physical pooled lights — MUST run
    // after every VFX update and before the render.
    fxLights.commit();

    // LOW preset: the shadow map is STATIC (baked once at load — see
    // warmUpRendering). No per-frame refresh: the caster re-render was the
    // single most expensive fixed pass AND its every-other-frame cadence
    // created the short/long frame judder that felt like 30 FPS.
    this.renderer.render(this.scene, this.fpsCamera.camera);
    // Debug HUD GPU stats: renderer.info is reset by every render() call,
    // so the WORLD pass numbers must be captured right here.
    this.hud.sampleRenderInfo(this.renderer);
    // FP pass (migrated viewmodel weapons — HexSniper): follows the FINAL
    // game-camera pose, ONE depth clear, arms + weapon drawn together over
    // the world color. Legacy camera-attached viewmodels already rendered
    // inside the world pass above (no double draw — each weapon renders on
    // exactly one path).
    this.viewmodelSystem.syncCamera(this.fpsCamera.camera);
    this.viewmodelSystem.render(this.renderer);
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

    // MULTIPLAYER: the SERVER owns the respawn timer and the spawn point.
    // The countdown shown on screen tracks the server clock; the actual
    // respawn happens when the server flips isAlive / sends the event.
    if (this.multiplayer) {
      const remaining = this.multiplayer.getRespawnCountdown();
      this.playerDeathTimer =
        remaining !== null ? remaining : Math.max(this.playerDeathTimer, 0.05);
      return;
    }

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
    if (attacker === this.playerCombatant) return null;
    if (attacker) {
      attacker.getPosition(this.attackerPos);
    } else if (this.multiplayer && this.netAttackerAge < 0.5) {
      // MULTIPLAYER: the HP mirror reports damage with a null attacker —
      // a FRESH server DAMAGE_TAKEN position drives the indicator instead.
      this.attackerPos.copy(this.netAttackerPos);
    } else {
      return null;
    }
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
    // MULTIPLAYER: death is SERVER-authoritative — no manual R respawn and
    // no local kill. Falling out of the world just recovers to a spawn pad
    // (position is client-reported in this phase).
    if (this.multiplayer) {
      if (fellOut) {
        const spawn = this.spawner.pickSpawn(this.combatants, this.playerCombatant);
        this.movement.respawn(spawn.pos);
      }
      return;
    }
    // R = manual respawn — EXCEPT with the Revolver (explosive throw) or
    // the Bass Blaster (musical reload) equipped, where R belongs to the
    // weapon (the kill plane still works normally).
    const manualRespawn =
      this.input.wasPressed("KeyR") &&
      this.primaryWeapon !== "REVOLVER" &&
      this.primaryWeapon !== "BASS_BLASTER" &&
      this.primaryWeapon !== "POISON_SPRAYER";
    if (fellOut || manualRespawn) {
      // Suicide / kill plane → normal death + respawn flow.
      this.playerCombatant.health.kill(null);
    }
  }

  // ------------------------------------------------------------------
  // Phase 5 — networked weapons (multiplayer only)
  // ------------------------------------------------------------------

  /**
   * Wrap the local weapon callbacks ONCE so every validated local action
   * is also reported to the server (origin + direction only — the server
   * computes every hit). Existing audio/VFX wiring keeps running first.
   */
  private wrapNetworkWeaponCallbacks(): void {
    if (this.netCallbacksWrapped) return;
    this.netCallbacksWrapped = true;

    const prevShot = this.revolver.onShot;
    this.revolver.onShot = (fanFire) => {
      prevShot?.(fanFire);
      this.netSendAimedAction(WeaponActionType.REVOLVER_FIRE);
    };
    const prevThrow = this.revolver.onThrow;
    this.revolver.onThrow = () => {
      prevThrow?.();
      this.netSendAimedAction(WeaponActionType.REVOLVER_THROW);
    };

    const prevSwing = this.hammer.onSwingStart;
    this.hammer.onSwingStart = () => {
      prevSwing?.();
      this.netSendAimedAction(WeaponActionType.HAMMER_SWEEP);
    };
    const prevSlamStart = this.hammer.onSlamStart;
    this.hammer.onSlamStart = () => {
      prevSlamStart?.();
      this.netSendAimedAction(WeaponActionType.HAMMER_SLAM_START);
    };
    const prevSlamImpact = this.hammer.onSlamImpact;
    this.hammer.onSlamImpact = (pos, hitCount) => {
      prevSlamImpact?.(pos, hitCount);
      // The REAL impact point travels in px/py/pz (server validates it).
      this.netSendAimedAction(WeaponActionType.HAMMER_SLAM_IMPACT, pos);
    };

    const prevSweep = this.spear.onSweepStart;
    this.spear.onSweepStart = () => {
      prevSweep?.();
      this.netSendAimedAction(WeaponActionType.SPEAR_SWEEP);
    };
    const prevRushStart = this.spear.onRushStart;
    this.spear.onRushStart = () => {
      prevRushStart?.();
      this.netSendAimedAction(WeaponActionType.SPEAR_RUSH_START);
    };
    const prevRushImpact = this.spear.onRushImpact;
    this.spear.onRushImpact = (pos) => {
      prevRushImpact?.(pos);
      // Tip-hit ends the charge here (WALL/timeout end in the frame loop).
      this.netSendAimedAction(WeaponActionType.SPEAR_RUSH_STOP);
    };

    const prevPlaced = this.obliterreur.onPointPlaced;
    this.obliterreur.onPointPlaced = (index, point) => {
      prevPlaced?.(index, point);
      // The EXACT local hit point + SLOT travel with the action so the
      // server (and every remote client) anchor the very same point in
      // the very same slot — the placement can never desynchronize.
      this.netSendAimedAction(WeaponActionType.OBLITERREUR_PLACE, point, index);
    };
    const prevBeamStart = this.obliterreur.onBeamStart;
    this.obliterreur.onBeamStart = () => {
      prevBeamStart?.();
      this.netSendAimedAction(WeaponActionType.OBLITERREUR_FIRE);
    };

    // MOLE STRIKE: burrow/emerge are server-validated actions — the
    // server owns the invulnerability window AND the eruption AoE.
    const prevBurrow = this.moleStrike.onBurrowStart;
    this.moleStrike.onBurrowStart = (feet) => {
      prevBurrow?.(feet);
      this.netSendAimedAction(WeaponActionType.MOLE_BURROW, feet);
    };
    const prevEmerge = this.moleStrike.onEmerge;
    this.moleStrike.onEmerge = (feet) => {
      prevEmerge?.(feet);
      this.netSendAimedAction(WeaponActionType.MOLE_EMERGE, feet);
    };

    // BASS BLASTER: every fired note reports its MUSIC GRAIN metadata
    // (track index / playhead offset / note index) in px/py/pz so the
    // server echoes it and every remote client replays the exact same
    // spatialized fragment riding on the note.
    this.bassBlaster.onNetShot = (noteIndex, trackIndex, grainOffset) => {
      this.netSendAimedAction(
        WeaponActionType.BASS_FIRE,
        this.netGrain.set(trackIndex, grainOffset, noteIndex),
      );
    };
  }

  /** Send one aimed WEAPON_ACTION (camera eye origin + facing direction). */
  private netSendAimedAction(
    action: string,
    extraPoint?: THREE.Vector3,
    pointIndex?: number,
  ): void {
    if (!this.multiplayer || !this.multiplayerClient?.isConnected) return;
    const cam = this.fpsCamera.camera;
    cam.getWorldPosition(this.netOrigin);
    cam.getWorldDirection(this.netDir);
    // VIEW TIME: the server-clock timestamp at which remote players are
    // DISPLAYED right now — the server rewinds its hit history to this
    // exact moment (clamped), so hits match what this player sees.
    const vt = this.multiplayer.getViewTimestamp();
    this.multiplayerClient.sendWeaponAction(action, {
      ox: this.netOrigin.x,
      oy: this.netOrigin.y,
      oz: this.netOrigin.z,
      dx: this.netDir.x,
      dy: this.netDir.y,
      dz: this.netDir.z,
      ...(extraPoint ? { px: extraPoint.x, py: extraPoint.y, pz: extraPoint.z } : {}),
      ...(pointIndex !== undefined ? { pi: pointIndex } : {}),
      ...(vt !== null ? { vt } : {}),
    });
  }

  /** WEAPON_EQUIP for the current primary (dedup unless forced). */
  private sendNetworkEquip(force = false): void {
    if (!this.multiplayer || !this.multiplayerClient?.isConnected) return;
    // Loadout ids match NetworkWeaponId one-to-one (Bass Blaster included).
    const weapon: string = this.primaryWeapon;
    if (!force && weapon === this.lastSentEquip) return;
    this.lastSentEquip = weapon;
    this.multiplayerClient.sendWeaponEquip(weapon);
  }

  /** Plasma has no local callback: edge-detect + 10 Hz silent aim. */
  private updateNetworkPlasma(dt: number): void {
    const firing = this.rifle.isFiring;
    if (firing !== this.netPlasmaWasFiring) {
      this.netPlasmaWasFiring = firing;
      this.netPlasmaAimTimer = 0;
      this.netSendAimedAction(
        firing ? WeaponActionType.PLASMA_START : WeaponActionType.PLASMA_STOP,
      );
    } else if (firing) {
      this.netPlasmaAimTimer += dt;
      if (this.netPlasmaAimTimer >= 0.1) {
        this.netPlasmaAimTimer = 0;
        this.netSendAimedAction("PLASMA_AIM"); // silent server aim refresh
      }
    }
  }

  /** Poison mirrors the plasma flow: edge-detect + 10 Hz silent aim. */
  private updateNetworkPoison(dt: number): void {
    const spraying = this.poison.isSpraying;
    if (spraying !== this.netPoisonWasSpraying) {
      this.netPoisonWasSpraying = spraying;
      this.netPoisonAimTimer = 0;
      this.netSendAimedAction(
        spraying ? WeaponActionType.POISON_START : WeaponActionType.POISON_STOP,
      );
    } else if (spraying) {
      this.netPoisonAimTimer += dt;
      if (this.netPoisonAimTimer >= 0.1) {
        this.netPoisonAimTimer = 0;
        this.netSendAimedAction("POISON_AIM"); // silent server aim refresh
      }
    }
  }

  /** Scratch pose for the damage-number anchor of a remote victim. */
  private readonly netHitPose = { pos: new THREE.Vector3(), yaw: 0, pitch: 0 };

  /** SERVER hit confirmation → hitmarker + hit sound (lightly throttled). */
  private handleNetworkHitConfirmed(event: HitConfirmedEvent): void {
    const zone = event.hitZone === "HEAD" ? HitZone.HEAD : HitZone.BODY;

    // Floating damage number on the victim's avatar — NOT throttled: the
    // HUD merges rapid ticks per target into one growing number itself.
    if (event.damageDealt > 0 && this.multiplayer) {
      if (this.multiplayer.remotes.getPose(event.targetId, this.netHitPose)) {
        this.netHitPose.pos.y += 1.5; // above the avatar's head
        this.damageNumbersHud.addHit(
          event.targetId,
          event.damageDealt,
          zone,
          this.netHitPose.pos,
          null,
          event.killed,
        );
      } else {
        // Killing blow can arrive after the avatar was hidden — merge it
        // into the still-visible number instead of losing the damage.
        this.damageNumbersHud.addOrphanHit(event.targetId, event.damageDealt, event.killed);
      }
    }

    // Continuous plasma confirms ~20 Hz — keep the feedback readable.
    if (!event.killed && this.elapsed - this.lastNetHitFeedback < 0.08) return;
    this.lastNetHitFeedback = this.elapsed;
    this.hitmarkerHud.show(zone);
    if (zone === HitZone.HEAD) this.gameAudio.hitHead();
    else this.gameAudio.hitBody();
  }

  /** SERVER-confirmed kill → the full solo kill feedback chain. */
  private handleNetworkKill(isHeadshot: boolean, damageType: string): void {
    this.gameAudio.killConfirm();
    this.combatHud.notifyKill();
    const count = this.combo.registerKill();
    this.comboHud.notifyKill();
    this.medals.onPlayerKill(count, networkKillMethod(damageType), isHeadshot);
    this.killstreaks.onPlayerKill();
    this.killstreakHud.notifyKill();
  }

  private updateCamera(dt: number): void {
    this.player.getPosition(this.playerPos);
    this.fpsCamera.getRight(this.rightDir);

    // HEX SNIPER ADS (RMB held): classic sniper ×4 optical zoom with the
    // existing crosshair. Evaluated HERE (every frame, even in the Escape
    // menu where mouse buttons are already cleared) so the zoom can never
    // stay stuck on death / unequip / pause. Sensitivity follows inside
    // FPSCamera.handleMouse.
    this.fpsCamera.zoom =
      this.primaryWeapon === "HEX_SNIPER" &&
      this.playerCombatant.health.alive &&
      this.input.pointerLocked &&
      this.input.isMouseDown(2) &&
      !this.hammer.blocksFiring &&
      !this.spear.blocksFiring &&
      !this.moleStrike.blocksWeapons &&
      !this.movement.isKnockedDown
        ? hexCfg.zoomFactor
        : 1;

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

/** Server DamageType string → the local KillMethod driving kill medals. */
function networkKillMethod(damageType: string): KillMethod {
  switch (damageType) {
    case "REVOLVER":
      return KillMethod.REVOLVER;
    case "REVOLVER_EXPLOSION":
      return KillMethod.REVOLVER_EXPLOSION;
    case "HAMMER":
      return KillMethod.HAMMER_SWING;
    case "SPEAR":
      return KillMethod.SPEAR_SWEEP;
    case "OBLITERREUR":
      return KillMethod.OBLITERREUR;
    case "MOLE_STRIKE":
      return KillMethod.MOLE_STRIKE;
    case "BASS_BLASTER":
      return KillMethod.BASS_BLASTER;
    case "HEX_SNIPER":
      return KillMethod.HEX_SNIPER_BITE;
    default:
      return KillMethod.PLASMA;
  }
}
