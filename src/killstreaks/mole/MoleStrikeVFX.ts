import * as THREE from "three";
import { ParticleSystem } from "../../effects/ParticleSystem";
import { Shockwave } from "../../effects/Shockwave";
import { MoleStrikeConfig as cfg } from "./MoleStrikeConfig";

/**
 * All MOLE STRIKE visuals: dirt bursts, the burrow trail, the emergence
 * blast and a fullscreen brown "underground" vignette overlay.
 * Pure presentation — reuses the shared pooled ParticleSystem / Shockwave
 * and never touches gameplay state.
 */
export class MoleStrikeVFX {
  private readonly dirt = new THREE.Color(cfg.moleStrikeDirtColor);
  private readonly dirtDark = new THREE.Color(cfg.moleStrikeDirtDarkColor);
  private readonly blast = new THREE.Color(cfg.moleStrikeBlastColor);
  private readonly flash = new THREE.Color(cfg.moleStrikeFlashColor);
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly tmpVel = new THREE.Vector3();
  private readonly tmpPos = new THREE.Vector3();

  private readonly overlayEl: HTMLElement;
  private lastOverlayOpacity = -1;

  constructor(
    private readonly particles: ParticleSystem,
    private readonly shockwave: Shockwave,
  ) {
    injectOverlayStyles();
    this.overlayEl = document.createElement("div");
    this.overlayEl.className = "mole-overlay";
    document.body.appendChild(this.overlayEl);
  }

  /** Dive-in: dirt explodes outward + a small ground ring at the feet. */
  enterBurst(feetPos: THREE.Vector3): void {
    this.particles.burst(feetPos, 40, 6, 0.7, this.dirt, 12);
    this.particles.burst(feetPos, 24, 3.5, 0.55, this.dirtDark, 10);
    this.particles.ring(feetPos, this.up, 22, 0.7, 5, 0.5, this.dirt);
    this.shockwave.spawn(feetPos, 2.2, 0.4, this.dirt);
  }

  /** Continuous burrow trail: one small dirt spurt at the ground surface. */
  trailPuff(surfacePos: THREE.Vector3): void {
    this.tmpVel.set(
      (Math.random() - 0.5) * 2.2,
      1.5 + Math.random() * 2.5,
      (Math.random() - 0.5) * 2.2,
    );
    this.tmpPos.set(
      surfacePos.x + (Math.random() - 0.5) * 0.6,
      surfacePos.y + 0.05,
      surfacePos.z + (Math.random() - 0.5) * 0.6,
    );
    const color = Math.random() < 0.65 ? this.dirt : this.dirtDark;
    this.particles.spawn(this.tmpPos, this.tmpVel, 0.4 + Math.random() * 0.3, color, 9, 0.5);
  }

  /** Emergence: massive dirt eruption + expanding shockwave ring. */
  emergeBlast(feetPos: THREE.Vector3): void {
    this.shockwave.spawn(feetPos, cfg.moleStrikeRadius, 0.55, this.blast);
    this.particles.burst(feetPos, 70, 11, 0.9, this.dirt, 14);
    this.particles.burst(feetPos, 40, 7, 0.7, this.blast, 10);
    this.particles.burst(feetPos, 24, 14, 0.45, this.flash, 6);
    this.particles.ring(feetPos, this.up, 36, 1.2, 9, 0.6, this.dirt);
    this.particles.ring(feetPos, this.up, 26, 0.8, 6, 0.5, this.blast);
  }

  /** Fullscreen brown vignette while burrowed (0..1, throttled DOM write). */
  setOverlayOpacity(opacity: number): void {
    const o = Math.round(opacity * 100) / 100;
    if (o === this.lastOverlayOpacity) return;
    this.lastOverlayOpacity = o;
    this.overlayEl.style.opacity = String(o);
  }
}

let overlayStylesInjected = false;

function injectOverlayStyles(): void {
  if (overlayStylesInjected) return;
  overlayStylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    .mole-overlay {
      position: fixed;
      inset: 0;
      z-index: 14;
      pointer-events: none;
      opacity: 0;
      background:
        radial-gradient(ellipse at center,
          rgba(60, 38, 16, 0.25) 0%,
          rgba(46, 28, 10, 0.65) 60%,
          rgba(30, 17, 5, 0.92) 100%);
      transition: opacity 0.05s linear;
    }
  `;
  document.head.appendChild(style);
}