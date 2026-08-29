import * as THREE from "three";
import { HitZone } from "../combat/HitZone";
import { Combatant } from "../combat/Combatant";
import { HitFeedbackConfig as hfc } from "../combat/HitFeedbackConfig";

/** One live floating number (pooled — never re-created per hit). */
interface DamageEntry {
  el: HTMLDivElement;
  inner: HTMLSpanElement;
  /** Merge key: the Combatant in solo, the sessionId string in multiplayer. */
  key: unknown;
  /** Live target to follow (solo bots) — null = frozen anchor (network). */
  target: Combatant | null;
  anchor: THREE.Vector3;
  total: number;
  /** Seconds since the LAST merged hit (drives merge window + lifetime). */
  sinceHit: number;
  head: boolean;
  /** Horizontal screen offset so the number sits BESIDE the enemy (px). */
  offsetX: number;
  /** Accumulated float-up drift (px). */
  rise: number;
  /** Goofy random tilt (deg). */
  tilt: number;
  active: boolean;
}

/**
 * Floating damage numbers next to the enemies (LOCAL player hits only).
 *
 * Cartoon style: big "Luckiest Guy" digits with a thick dark outline,
 * pop-in overshoot bounce, float-up + shrink/fade-out. Rapid ticks on the
 * same target MERGE into one growing number (retriggering the pop) so a
 * continuous plasma beam reads as one big count instead of digit spam.
 *
 * Readability at distance: the screen scale follows 1/distance but is
 * CLAMPED to a generous minimum — a far enemy still shows a clearly
 * legible number, it just stops growing when close.
 *
 * DOM-based: world anchor → screen projection each frame; a pooled set of
 * divs is repositioned via transform (no per-hit allocation, no layout).
 */
export class DamageNumbersHUD {
  private readonly root: HTMLDivElement;
  private readonly entries: DamageEntry[] = [];
  /** Active entry per merge key (a new number replaces the mapping). */
  private readonly byKey = new Map<unknown, DamageEntry>();

  private readonly proj = new THREE.Vector3();
  private readonly camPos = new THREE.Vector3();

  constructor() {
    this.root = document.createElement("div");
    this.root.id = "damage-numbers";
    document.body.appendChild(this.root);
  }

  /**
   * Report one applied damage tick. Ticks landing within the merge window
   * on the same key ACCUMULATE into the existing number (pop retriggered).
   * `target` (optional) makes the number FOLLOW the enemy while it lives.
   */
  addHit(
    key: unknown,
    damage: number,
    zone: HitZone,
    anchor: THREE.Vector3,
    target: Combatant | null = null,
  ): void {
    if (damage <= 0) return;
    const head = zone === HitZone.HEAD;

    const existing = this.byKey.get(key);
    if (
      existing &&
      existing.active &&
      existing.head === head &&
      existing.sinceHit < hfc.damageNumberMergeWindow
    ) {
      existing.total += damage;
      existing.sinceHit = 0;
      existing.anchor.copy(anchor);
      // Keep a merged (still growing) number close to the enemy.
      existing.rise = Math.min(existing.rise, 12);
      this.applyText(existing);
      this.retriggerPop(existing);
      return;
    }

    const entry = this.acquire();
    entry.key = key;
    entry.target = target;
    entry.anchor.copy(anchor);
    entry.total = damage;
    entry.sinceHit = 0;
    entry.head = head;
    entry.offsetX = (Math.random() < 0.5 ? -1 : 1) * (34 + Math.random() * 22);
    entry.rise = 0;
    entry.tilt = (Math.random() * 2 - 1) * 8;
    entry.active = true;
    entry.el.classList.toggle("dmg-head", head);
    this.byKey.set(key, entry);
    this.applyText(entry);
    this.retriggerPop(entry);
  }

  /**
   * Damage with NO position available (e.g. a network killing blow on an
   * already-removed avatar): merge into the existing number if one is
   * still live for this key, otherwise silently drop.
   */
  addOrphanHit(key: unknown, damage: number): void {
    const existing = this.byKey.get(key);
    if (!existing || !existing.active || damage <= 0) return;
    existing.total += damage;
    existing.sinceHit = 0;
    this.applyText(existing);
    this.retriggerPop(existing);
  }

  /** Per-frame: follow targets, project to screen, float up, fade out. */
  update(dt: number, camera: THREE.Camera): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camPos.setFromMatrixPosition(camera.matrixWorld);

    for (const entry of this.entries) {
      if (!entry.active) continue;
      entry.sinceHit += dt;
      if (entry.sinceHit >= hfc.damageNumberLifetime) {
        this.release(entry);
        continue;
      }

      // Follow a living target; freeze the anchor once it dies.
      if (entry.target && entry.target.health.alive) {
        entry.target.getEyePosition(entry.anchor);
        entry.anchor.y += 0.45;
      }
      entry.rise += hfc.damageNumberFloatSpeed * dt;

      this.proj.copy(entry.anchor).project(camera);
      if (this.proj.z > 1) {
        entry.el.style.display = "none"; // behind the camera
        continue;
      }

      // Distance scale, CLAMPED so far numbers stay clearly readable.
      const dist = entry.anchor.distanceTo(this.camPos);
      let scale = THREE.MathUtils.clamp(
        hfc.damageNumberRefDistance / Math.max(dist, 0.1),
        hfc.damageNumberMinScale,
        hfc.damageNumberMaxScale,
      );

      // Tail: shrink + fade over the last quarter of the lifetime.
      const t = entry.sinceHit / hfc.damageNumberLifetime;
      const tail = t > 0.75 ? (t - 0.75) / 0.25 : 0;
      scale *= 1 - tail * 0.35;

      const x = (this.proj.x * 0.5 + 0.5) * w + entry.offsetX;
      const y = (-this.proj.y * 0.5 + 0.5) * h - entry.rise;
      // NOTE: must be an explicit value — an empty string would fall back
      // to the stylesheet default `.dmg-num { display: none; }`.
      entry.el.style.display = "block";
      entry.el.style.opacity = String(1 - tail);
      entry.el.style.transform =
        `translate(${x}px, ${y}px) translate(-50%, -50%) ` +
        `scale(${scale.toFixed(3)}) rotate(${entry.tilt.toFixed(1)}deg)`;
    }
  }

  // ------------------------------------------------------------------
  // Pool management
  // ------------------------------------------------------------------

  private acquire(): DamageEntry {
    for (const entry of this.entries) if (!entry.active) return entry;
    if (this.entries.length < hfc.damageNumberMaxCount) {
      const entry = this.createEntry();
      this.entries.push(entry);
      return entry;
    }
    // Pool saturated: steal the OLDEST number (closest to fading anyway).
    let oldest = this.entries[0];
    for (const entry of this.entries) {
      if (entry.sinceHit > oldest.sinceHit) oldest = entry;
    }
    this.release(oldest);
    return oldest;
  }

  private createEntry(): DamageEntry {
    const el = document.createElement("div");
    el.className = "dmg-num";
    const inner = document.createElement("span");
    inner.className = "dmg-num-inner";
    el.appendChild(inner);
    this.root.appendChild(el);
    return {
      el,
      inner,
      key: null,
      target: null,
      anchor: new THREE.Vector3(),
      total: 0,
      sinceHit: 0,
      head: false,
      offsetX: 0,
      rise: 0,
      tilt: 0,
      active: false,
    };
  }

  private release(entry: DamageEntry): void {
    entry.active = false;
    entry.target = null;
    entry.el.style.display = "none";
    if (this.byKey.get(entry.key) === entry) this.byKey.delete(entry.key);
    entry.key = null;
  }

  private applyText(entry: DamageEntry): void {
    entry.inner.textContent = String(Math.max(1, Math.round(entry.total)));
  }

  /** Restart the pop-in bounce via the classic reflow trick. */
  private retriggerPop(entry: DamageEntry): void {
    entry.inner.classList.remove("dmg-pop");
    void entry.inner.offsetWidth;
    entry.inner.classList.add("dmg-pop");
  }
}

