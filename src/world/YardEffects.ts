import * as THREE from "three";
import { PhysicsWorld, RAPIER } from "../physics/PhysicsWorld";
import type RAPIER_API from "@dimforge/rapier3d-compat";
import type { YardMap, YardHazard, YardInteractable } from "./YardMap";

/**
 * YARD 01 map-local visual animations + interaction hooks — the project
 * adaptation of the pack's yardEffects.js (see the .reference.js source).
 *
 * ONE instance per loaded map. Owns the SINGLE AnimationMixer that plays
 * the export's 4-second loop (6 acid bubbles, 6 ripples, fans, cameras and
 * terminal elements — 18 animated objects). No second system may play the
 * same clips.
 *
 * The acid surface (mesh named exactly "ACID_LIQUID_SURFACE") gets a
 * lightweight wave/glint effect injected through onBeforeCompile — no
 * fluid sim, no realtime reflection/refraction, opaque liquid (no
 * transparent sorting). Compatible with the project's MeshStandard
 * pipeline (three 0.185, WebGLRenderer + ACES).
 *
 * Interactions: nearby()/interact() test the two terminals with distance +
 * Rapier line-of-sight (the player's own collider is excluded so its body
 * never blocks the visibility ray). Callbacks are LOCAL hooks — in
 * multiplayer any real effect must go through the server.
 */
export class YardEffects {
  readonly mixer: THREE.AnimationMixer;
  /** The acid surface mesh (kept for debugging / external checks). */
  readonly water: THREE.Mesh;

  /** LOCAL hazard hook (solo: kill the player; MP: feedback only). */
  onHazard: ((hazard: YardHazard) => void) | null = null;
  /** LOCAL interaction hook (terminal activated). Extension point — no
   *  major mechanic is invented here; MP effects belong to the server. */
  onInteract: ((item: YardInteractable) => void) | null = null;

  private readonly material: THREE.Material;
  private readonly previousCompile: THREE.Material["onBeforeCompile"];
  private readonly previousKey: () => string;
  private readonly clock = { value: 0 };
  private elapsed = 0;
  private nextHazardTime = 0;
  private disposed = false;

  private readonly hazards: YardHazard[];
  private readonly interactables: YardInteractable[];
  private readonly eye = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();

  constructor(
    private readonly yard: YardMap,
    private readonly physics: PhysicsWorld,
  ) {
    this.hazards = yard.hazards;
    this.interactables = yard.interactables;

    // ---- Single mixer: play the export's animation loop once, here ----
    this.mixer = new THREE.AnimationMixer(yard.root);
    for (const clip of yard.animations) this.mixer.clipAction(clip).play();

    // ---- Acid surface: lightweight wave + glint via onBeforeCompile ----
    const water = yard.root.getObjectByName("ACID_LIQUID_SURFACE") as THREE.Mesh | null;
    if (!water?.isMesh) throw new Error("YardEffects: ACID_LIQUID_SURFACE missing from the export");
    this.water = water;
    water.castShadow = false; // opaque liquid — never a shadow caster
    const material = (Array.isArray(water.material) ? water.material[0] : water.material) as THREE.Material;
    this.material = material;
    this.previousCompile = material.onBeforeCompile;
    this.previousKey = material.customProgramCacheKey.bind(material);

    const previousCompile = this.previousCompile;
    const clock = this.clock;
    material.onBeforeCompile = function (shader, renderer) {
      previousCompile.call(this, shader, renderer);
      shader.uniforms.uYardTime = clock;
      shader.vertexShader = "uniform float uYardTime; varying vec3 vYardWater;\n" + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace("#include <begin_vertex>", `
        #include <begin_vertex>
        float wave = sin(position.x * 1.7 + uYardTime * 1.6)
                   * cos((position.y + position.z) * 1.3 - uYardTime);
        transformed += objectNormal * wave * 0.028;
        vYardWater = (modelMatrix * vec4(transformed, 1.0)).xyz;
      `);
      shader.fragmentShader = "uniform float uYardTime; varying vec3 vYardWater;\n" + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace("#include <color_fragment>", `
        #include <color_fragment>
        vec2 flow = vYardWater.xz;
        float ripple = 0.52 * sin(flow.x * 0.88 + flow.y * 0.34 + uYardTime * 0.7 + sin(flow.y * 0.44 - uYardTime * 0.4))
                     + 0.30 * sin(flow.y * 1.24 - flow.x * 0.14 - uYardTime * 0.65)
                     + 0.18 * sin((flow.x + flow.y) * 1.96 + uYardTime);
        float glint = smoothstep(0.72, 0.96, ripple);
        diffuseColor.rgb *= 0.88 + 0.12 * ripple;
        diffuseColor.rgb += vec3(0.15, 0.22, 0.065) * glint;
      `);
    };
    material.customProgramCacheKey = () => "yard-acid-waves-v1";
    material.needsUpdate = true;
  }

  /**
   * Advance the animation loop + the acid shader clock, then run the
   * LOCAL hazard check on the player's FEET position (world coordinates).
   * Hazard hits are throttled (0.8 s) — the callback fires once, not
   * every frame while dying. In multiplayer the SERVER performs its own
   * authoritative acid check; this one only drives local feedback.
   */
  update(deltaSeconds: number, playerFeet: THREE.Vector3 | null): void {
    if (this.disposed) return;
    if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) return;
    const dt = Math.min(deltaSeconds, 0.1);
    this.elapsed += dt;
    this.clock.value = this.elapsed;
    this.mixer.update(dt);

    if (!playerFeet || this.elapsed < this.nextHazardTime) return;
    for (const hazard of this.hazards) {
      if (
        playerFeet.x >= hazard.min[0] && playerFeet.x <= hazard.max[0] &&
        playerFeet.y >= hazard.min[1] && playerFeet.y <= hazard.max[1] &&
        playerFeet.z >= hazard.min[2] && playerFeet.z <= hazard.max[2]
      ) {
        this.nextHazardTime = this.elapsed + 0.8;
        this.onHazard?.(hazard);
        break;
      }
    }
  }

  /**
   * Nearest interactable within reach of the player's EYES (feet + 1.65 m),
   * or null. `requiresLineOfSight` terminals are additionally checked with
   * a Rapier raycast that EXCLUDES the player's own collider (their body
   * must never block the visibility test).
   */
  nearby(
    playerFeet: THREE.Vector3,
    playerCollider?: RAPIER_API.Collider,
  ): YardInteractable | null {
    if (this.disposed) return null;
    this.eye.set(playerFeet.x, playerFeet.y + 1.65, playerFeet.z);
    let nearest: YardInteractable | null = null;
    let best = Infinity;
    for (const item of this.interactables) {
      this.target.fromArray(item.position);
      const distance = this.eye.distanceTo(this.target);
      if (distance > item.radius || distance >= best) continue;
      if (item.requiresLineOfSight) {
        this.direction.subVectors(this.target, this.eye).normalize();
        const hit = this.physics.world.castRay(
          new RAPIER.Ray(
            { x: this.eye.x, y: this.eye.y, z: this.eye.z },
            { x: this.direction.x, y: this.direction.y, z: this.direction.z },
          ),
          Math.max(0, distance - 0.03),
          true,
          undefined,
          undefined,
          playerCollider,
        );
        if (hit) continue; // a wall blocks the terminal
      }
      nearest = item;
      best = distance;
    }
    return nearest;
  }

  /**
   * Player pressed the interact key: triggers the nearest reachable
   * terminal (if any). Returns true when an interaction fired.
   */
  interact(playerFeet: THREE.Vector3, playerCollider?: RAPIER_API.Collider): boolean {
    const item = this.nearby(playerFeet, playerCollider);
    if (!item) return false;
    this.onInteract?.(item);
    return true;
  }

  /** Stop the mixer and restore the acid material's original compile hooks. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.yard.root);
    this.material.onBeforeCompile = this.previousCompile;
    this.material.customProgramCacheKey = this.previousKey;
    this.material.needsUpdate = true;
  }
}
