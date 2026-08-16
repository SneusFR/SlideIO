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
import { RevolverWeapon } from "../weapons/revolver/RevolverWeapon";
import { RevolverHUD } from "../ui/RevolverHUD";
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
import { MultiplayerGameController } from "../network/MultiplayerGameController";
import type { MultiplayerClient } from "../network/MultiplayerClient";
import { KillMethod } from "../combat/KillMethod";
import { WeaponActionType } from "../../shared/combat/NetworkWeapons";
import type { HitConfirmedEvent } from "../../shared/combat/NetworkWeapons";

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

  // ---- REVOLVER (primary alternative — equipped via the Loadout menu) ----
  private revolver: RevolverWeapon;
  private revolverHud: RevolverHUD;

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

  /** Non-null while running in MULTIPLAYER mode (Phase 2 transform sync). */
  private multiplayer: MultiplayerGameController | null = null;
  /** The raw client, kept for weapon equip/action sends (Phase 5). */
  private multiplayerClient: MultiplayerClient | null = null;
  private playerCombatant: PlayerCombatant;
  private hitmarkerHud: HitmarkerHUD;
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
  /** True once the local weapon callbacks have been network-wrapped. */
  private netCallbacksWrapped = false;
  /** Latest server-reported attacker position (directional damage HUD). */
  private readonly netAttackerPos = new THREE.Vector3();
  private netAttackerAge = Infinity;
  /** Server hitmarker throttle (plasma streams confirm at ~20 Hz). */
  private lastNetHitFeedback = -1;
  private readonly netOrigin = new THREE.Vector3();
  private readonly netDir = new THREE.Vector3();
  private readonly netImpulse = new THREE.Vector3();

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

    // Hit-confirmation feedback (hitmarker + sound + victim reaction) —
    // LOCAL PLAYER only; weapons report every applied damage tick to it.
    // The HitmarkerHUD is kept as a field: in multiplayer the SERVER's
    // HIT_CONFIRMED events drive it directly (source of truth).
    this.hitmarkerHud = new HitmarkerHUD();
    this.hitFeedback = new HitFeedbackManager(
      this.hitmarkerHud,
      this.particles,
      this.playerCombatant,
    );
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
    // Primary swap: a clean slate — active vortex cancelled, anchors gone,
    // revolver back to a full ready cylinder.
    if (selection.primary !== this.primaryWeapon) {
      this.primaryWeapon = selection.primary;
      this.obliterreur.reset();
      this.revolver.reset();
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

    // Phase 2 multiplayer runs with 0 bots (solo mode keeps them working).
    this.botManager.setBotCount(0);
    this.rebuildHittables();
    document.getElementById("bots-menu")?.classList.add("hidden");

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
      this.playerCombatant.health.reset(cc.spawnProtectionDuration);
      this.gameAudio.playerRespawn();
      // Equip is refused while dead — re-assert it after every respawn.
      this.sendNetworkEquip(true);
      this.netPlasmaWasFiring = false;
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
  }

  /** Tear down the multiplayer session (leave game / connection lost). */
  disableMultiplayer(): void {
    this.multiplayer?.dispose();
    this.multiplayer = null;
    this.multiplayerClient = null;
    this.lastSentEquip = "";
    this.netPlasmaWasFiring = false;
    document.getElementById("bots-menu")?.classList.remove("hidden");
    // Back to LOCAL mode: the MatchStatsManager drives the leaderboard again.
    this.matchStats.onStatsChanged = () =>
      this.leaderboardHud.refresh(this.matchStats.getSortedStats());
    this.matchStats.onStatsChanged();
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
      // when another primary (OBLITERREUR / REVOLVER) is equipped.
      const obliEquipped = this.primaryWeapon === "OBLITERREUR";
      const revolverEquipped = this.primaryWeapon === "REVOLVER";
      const meleeBlocked =
        this.hammer.blocksFiring || this.spear.blocksFiring || this.moleStrike.blocksWeapons;
      const wantFire =
        playerAlive &&
        this.input.pointerLocked &&
        this.input.isMouseDown(0) &&
        !meleeBlocked &&
        !obliEquipped &&
        !revolverEquipped;
      this.rifle.setViewmodelHidden(
        this.hammer.isBusy ||
          this.spear.isBusy ||
          this.moleStrike.active ||
          obliEquipped ||
          revolverEquipped,
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
      this.botManager.updateWeapons(dt, this.hittables, this.elapsed);
      this.handlePhaseEffects();
      this.particles.update(dt);
      this.shockwave.update(dt);

      // Combo window countdown + medal queue presentation (paused with
      // the game so the Escape menu never eats your combo).
      this.combo.update(dt);
      this.medals.update(dt);
      this.hitFeedback.update(dt);
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
    this.revolverHud.setVisible(this.primaryWeapon === "REVOLVER");
    this.revolverHud.update(this.revolver);
    this.combatHud.update(dt, this.playerCombatant.health, this.playerDeathTimer);
    this.comboHud.update(this.combo);

    // Multiplayer (Phase 2): remote avatars + fixed-rate transform send.
    // Runs its own network accumulator — never one send per render frame.
    this.multiplayer?.update(dt);
    this.netAttackerAge += dt; // network damage-direction memory decays

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
    // R = manual respawn — EXCEPT with the Revolver equipped, where R is
    // the weapon's explosive throw (the kill plane still works normally).
    const manualRespawn =
      this.input.wasPressed("KeyR") && this.primaryWeapon !== "REVOLVER";
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
    this.multiplayerClient.sendWeaponAction(action, {
      ox: this.netOrigin.x,
      oy: this.netOrigin.y,
      oz: this.netOrigin.z,
      dx: this.netDir.x,
      dy: this.netDir.y,
      dz: this.netDir.z,
      ...(extraPoint ? { px: extraPoint.x, py: extraPoint.y, pz: extraPoint.z } : {}),
      ...(pointIndex !== undefined ? { pi: pointIndex } : {}),
    });
  }

  /** WEAPON_EQUIP for the current primary (dedup unless forced). */
  private sendNetworkEquip(force = false): void {
    if (!this.multiplayer || !this.multiplayerClient?.isConnected) return;
    const weapon: string = this.primaryWeapon; // ids match NetworkWeaponId
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

  /** SERVER hit confirmation → hitmarker + hit sound (lightly throttled). */
  private handleNetworkHitConfirmed(event: HitConfirmedEvent): void {
    const zone = event.hitZone === "HEAD" ? HitZone.HEAD : HitZone.BODY;
    // Continuous plasma confirms ~20 Hz — keep the feedback readable.
    if (!event.killed && this.elapsed - this.lastNetHitFeedback < 0.08) return;
    this.lastNetHitFeedback = this.elapsed;
    this.hitmarkerHud.show(zone);
    if (zone === HitZone.HEAD) this.gameAudio.hitHead();
    else this.gameAudio.hitBody();
  }

  /** SERVER-confirmed kill → the full solo kill feedback chain. */
  private handleNetworkKill(isHeadshot: boolean, damageType: string): void {
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
    default:
      return KillMethod.PLASMA;
  }
}
