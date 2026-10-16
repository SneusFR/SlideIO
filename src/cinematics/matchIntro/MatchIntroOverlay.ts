import type { MatchIntroPlayer } from "./MatchIntroTypes";
import { INTRO_GOLD } from "./MatchIntroTypes";
import type { IntroFrame, IntroLayout, TagFrame } from "./MatchIntroTimeline";
import { lerp } from "./MatchIntroTimeline";

/**
 * MATCH INTRO — DOM text layer: names, stats pills, "TOI" tag, MVP badge
 * + crown, empty-slot "?" marks, the opening title and the "VS" stamp.
 * Same sticker language as the HUD (Luckiest Guy, dark-wood stroke, hard
 * offset shadow). Every element is positioned per frame from the
 * timeline (transform / opacity only — no layout thrash: the natural
 * size of each tag is measured once).
 */

const STYLE_ID = "match-intro-style";
const CSS = /* css */ `
.mi-layer{position:fixed;inset:0;overflow:hidden;user-select:none;-webkit-user-select:none;contain:strict;}
.mi-layer canvas{position:absolute;inset:0;width:100%;height:100%;display:block;}
.mi-text{position:absolute;inset:0;pointer-events:none;font-family:"Luckiest Guy","Baloo 2",cursive;color:#fff6e0;}
.mi-abs{position:absolute;left:0;top:0;will-change:transform,opacity;transform-origin:50% 50%;white-space:nowrap;}
.mi-tag{display:flex;flex-direction:column;align-items:center;}
.mi-name{font-size:9.5vh;line-height:1;letter-spacing:.02em;padding:0 .12em;color:#fff6e0;
  -webkit-text-stroke:.12em #3a2814;paint-order:stroke fill;
  text-shadow:0 .08em 0 #3a2814,.03em .12em 0 rgba(20,12,4,.55);}
.mi-stats{display:flex;gap:.45em;margin-top:.18em;font-size:3.3vh;}
.mi-pill{display:inline-flex;align-items:baseline;gap:.3em;padding:.2em .62em .06em;border:.15em solid #3a2814;border-radius:.65em;
  background:linear-gradient(180deg,#ffffff,#fbf3dd 60%,#efe2c0);color:#3a2814;box-shadow:0 .17em 0 #3a2814;}
.mi-pill small{font-family:"Baloo 2","Segoe UI",sans-serif;font-weight:800;font-size:.62em;letter-spacing:.06em;opacity:.8;}
.mi-pill.mi-lvl{background:linear-gradient(180deg,#fff3b0,#facc15 65%,#e0a90b);}
.mi-you{position:absolute;top:-.55em;right:-.35em;font-size:2.7vh;padding:.16em .5em .02em;background:linear-gradient(180deg,#d8f59a,#a8d94a 60%,#78ac1e);
  border:.15em solid #3a2814;border-radius:.55em;color:#3a2814;box-shadow:0 .15em 0 #3a2814;transform:rotate(9deg);}
.mi-mvp .mi-name{color:${INTRO_GOLD};font-size:11vh;}
.mi-badge{display:flex;align-items:center;gap:.35em;margin-bottom:.12em;font-size:3.4vh;padding:.22em .7em .06em;color:#3a2814;
  background:linear-gradient(180deg,#fff3b0,#facc15 65%,#e0a90b);border:.16em solid #3a2814;border-radius:.6em;box-shadow:0 .18em 0 #3a2814;transform-origin:50% 100%;}
.mi-badge svg{height:1.15em;width:auto;margin-top:-.15em;}
.mi-star{position:absolute;left:-14%;top:-48%;width:128%;height:196%;z-index:-1;overflow:visible;transform-origin:50% 50%;}
.mi-q{font-size:15vh;color:rgba(255,246,224,.14);-webkit-text-stroke:.05em rgba(58,40,20,.75);paint-order:stroke fill;}
.mi-title{display:flex;flex-direction:column;align-items:center;}
.mi-title .mi-count{font-size:14vh;line-height:1;color:#fff6e0;-webkit-text-stroke:.12em #3a2814;paint-order:stroke fill;text-shadow:0 .08em 0 #3a2814;}
.mi-title .mi-map{font-size:5.2vh;color:${INTRO_GOLD};-webkit-text-stroke:.12em #3a2814;paint-order:stroke fill;text-shadow:0 .1em 0 #3a2814;margin-top:.1em;}
.mi-vs{font-size:19vh;line-height:1;color:${INTRO_GOLD};-webkit-text-stroke:.1em #3a2814;paint-order:stroke fill;
  text-shadow:0 .07em 0 #3a2814,0 0 .35em rgba(250,204,21,.55);}
.mi-ring{width:34vh;height:34vh;margin:-17vh 0 0 -17vh;border-radius:50%;border:1.3vh solid #fff6e0;box-shadow:0 0 0 .6vh #3a2814,inset 0 0 0 .6vh #3a2814;}
.mi-skip{position:absolute;left:2.4vh;top:2.2vh;display:flex;align-items:center;gap:.6vh;font-family:"Baloo 2","Segoe UI",sans-serif;font-weight:700;
  font-size:2vh;color:rgba(255,246,224,.85);text-shadow:0 .12em 0 rgba(20,12,4,.8);}
.mi-skip kbd{font-family:"Luckiest Guy","Baloo 2",cursive;font-size:1.6vh;padding:.3vh .9vh .1vh;color:#3a2814;
  background:linear-gradient(180deg,#fff,#fbf3dd 60%,#efe2c0);border:.25vh solid #3a2814;border-radius:.8vh;box-shadow:0 .35vh 0 #3a2814;}
`;

const CROWN_SVG = `<svg viewBox="0 0 40 28" aria-hidden="true"><path d="M3 24 L1 6 L11 14 L20 2 L29 14 L39 6 L37 24 Z" fill="#facc15" stroke="#3a2814" stroke-width="3" stroke-linejoin="round"/><rect x="3" y="22" width="34" height="5" rx="2" fill="#e0a90b" stroke="#3a2814" stroke-width="3"/></svg>`;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

function el(cls: string, text?: string): HTMLDivElement {
  const d = document.createElement("div");
  d.className = cls;
  if (text !== undefined) d.textContent = text;
  return d;
}

const starPath = (() => {
  const pts: string[] = [];
  const spikes = 14;
  for (let i = 0; i < spikes * 2; i++) {
    const a = (i / (spikes * 2)) * Math.PI * 2 - Math.PI / 2;
    const r = i % 2 === 0 ? 1 : 0.7 + 0.08 * Math.sin(i * 2.3);
    pts.push(`${(100 + Math.cos(a) * 98 * r).toFixed(1)},${(50 + Math.sin(a) * 48 * r).toFixed(1)}`);
  }
  return pts.join(" ");
})();
function starSvg(fill: string): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 200 100");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("class", "mi-star");
  const poly = document.createElementNS(NS, "polygon");
  poly.setAttribute("points", starPath);
  poly.setAttribute("fill", fill);
  poly.setAttribute("stroke", "#3a2814");
  poly.setAttribute("stroke-width", "5");
  poly.setAttribute("stroke-linejoin", "round");
  poly.setAttribute("vector-effect", "non-scaling-stroke");
  svg.appendChild(poly);
  return svg;
}

const PILL_ROT = [-3, 2, -1.5, 1.5];

interface TagEls {
  root: HTMLDivElement;
  star: SVGSVGElement;
  pills: HTMLElement[];
  lvl: HTMLElement;
  kd: HTMLElement;
  kills: HTMLElement | null;
  wins: HTMLElement | null;
  badge: HTMLDivElement | null;
  natural: { w: number; h: number } | null;
  lastText: string;
}

export class MatchIntroOverlay {
  readonly root: HTMLDivElement;
  readonly text: HTMLDivElement;
  private readonly tags: TagEls[] = [];
  private readonly qs: HTMLDivElement[] = [];
  private readonly title: HTMLDivElement;
  private readonly vs: HTMLDivElement;
  private readonly ring: HTMLDivElement;
  private readonly skip: HTMLDivElement | null;
  private readonly players: MatchIntroPlayer[];

  /** `players` in presentation order (MVP last); `accents` = blade colors (hex). */
  constructor(players: MatchIntroPlayer[], opts: { mapName?: string; skippable: boolean; zIndex: number; accents: string[] }) {
    ensureStyle();
    this.players = players;
    this.root = el("mi-layer");
    this.root.style.zIndex = String(opts.zIndex);
    // Input is captured only while playing (MatchIntroCinematic.play / finish).
    this.root.style.pointerEvents = "none";
    this.text = el("mi-text");
    this.root.appendChild(this.text);

    const n = players.length;
    for (let i = 0; i < n - 1; i++) {
      const q = el("mi-abs mi-q", "?");
      this.text.appendChild(q);
      this.qs.push(q);
    }
    players.forEach((p, i) => {
      const isMvp = i === n - 1;
      const root = el(`mi-abs mi-tag${isMvp ? " mi-mvp" : ""}`);
      const star = starSvg(isMvp ? "#ff8a3d" : opts.accents[i] ?? "#5cc8ff");
      root.appendChild(star);
      let badge: HTMLDivElement | null = null;
      if (isMvp && n > 1) {
        badge = el("mi-badge");
        badge.innerHTML = `${CROWN_SVG}<span>MEILLEUR JOUEUR</span>`;
        root.appendChild(badge);
      }
      root.appendChild(el("mi-name", p.name.toUpperCase()));
      const stats = el("mi-stats");
      const pill = (cls: string, label: string) => {
        const s = document.createElement("span");
        s.className = `mi-pill ${cls}`;
        const sm = document.createElement("small");
        sm.textContent = label;
        const b = document.createElement("b");
        s.append(sm, b);
        stats.appendChild(s);
        return b;
      };
      const lvl = pill("mi-lvl", "LVL");
      const kd = pill("mi-kd", "K/D");
      const kills = isMvp && typeof p.kills === "number" ? pill("mi-kills", "KILLS") : null;
      const wins = isMvp && typeof p.wins === "number" ? pill("mi-wins", "VICT.") : null;
      root.appendChild(stats);
      const pills = Array.from(stats.children) as HTMLElement[];
      if (p.isLocal) root.appendChild(el("mi-you", "TOI"));
      this.text.appendChild(root);
      root.style.opacity = "0";
      this.tags.push({ root, star, pills, lvl, kd, kills, wins, badge, natural: null, lastText: "" });
    });

    this.title = el("mi-abs mi-title");
    this.title.appendChild(el("mi-count", n > 1 ? `${n} JOUEURS` : "1 JOUEUR"));
    if (opts.mapName) this.title.appendChild(el("mi-map", opts.mapName.toUpperCase()));
    this.text.appendChild(this.title);

    this.ring = el("mi-abs mi-ring");
    this.vs = el("mi-abs mi-vs", "VS");
    this.text.append(this.ring, this.vs);

    this.skip = null;
    if (opts.skippable) {
      const skip = el("mi-skip");
      skip.innerHTML = `<kbd>ESPACE</kbd><span>passer</span>`;
      this.text.appendChild(skip);
      this.skip = skip;
    }
  }

  private place(node: HTMLElement, x: number, y: number, scale: number, rot: number, opacity: number): void {
    node.style.opacity = opacity <= 0.001 ? "0" : opacity.toFixed(3);
    node.style.visibility = opacity <= 0.001 ? "hidden" : "inherit";
    if (opacity <= 0.001) return;
    node.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -50%) rotate(${rot.toFixed(2)}deg) scale(${scale.toFixed(4)})`;
  }

  /** Map a normalized point through the global zoom + shake (same as the blades). */
  private static map(x: number, y: number, f: IntroFrame, w: number, h: number): [number, number] {
    return [(0.5 + (x - 0.5) * f.zoom + f.shake[0]) * w, (0.5 + (y - 0.5) * f.zoom + f.shake[1]) * h];
  }

  update(f: IntroFrame, lay: IntroLayout, w: number, h: number): void {
    const n = this.players.length;
    // ---- empty-slot "?" marks
    for (let k = 0; k < this.qs.length; k++) {
      const ph = f.placeholders[k];
      const slot = lay.slots[k];
      if (!ph || !slot) continue;
      const [x, y] = MatchIntroOverlay.map(slot.focus[0], slot.focus[1], f, w, h);
      const size = slot.row === 0 ? 1.15 : 0.72;
      this.place(this.qs[k], x, y, size * f.zoom, -6, ph.visible ? ph.question * (1 - f.exit) : 0);
    }
    // ---- tags
    for (let i = 0; i < n; i++) {
      const tf = f.tags[i];
      const els = this.tags[i];
      const p = this.players[i];
      if (!tf || tf.mode === "hidden" || tf.opacity <= 0.001) {
        this.place(els.root, 0, 0, 1, 0, 0);
        continue;
      }
      if (!els.natural) {
        // Measure ONCE at scale 1 (offset size ignores transforms).
        els.natural = { w: els.root.offsetWidth || 1, h: els.root.offsetHeight || 1 };
      }
      const isMvp = i === n - 1;
      const bigFit = Math.min(1, ((isMvp ? 0.56 : 0.44) * w) / els.natural.w);
      const slotFit = Math.min(isMvp ? 0.78 : 0.42, (tf.fitWidth * w * 0.86) / els.natural.w);
      const scale = lerp(tf.scale * bigFit, slotFit, tf.toSlot) * f.zoom;
      const [x, y] = MatchIntroOverlay.map(tf.x, tf.y, f, w, h);
      this.place(els.root, x, y, scale, tf.rot, tf.opacity * (1 - f.exit));
      // counters (DOM text only when it changes)
      const k = tf.stats;
      const lvl = Math.round(p.level * k);
      const kd = (p.kd * k).toFixed(2);
      const kills = typeof p.kills === "number" ? Math.round(p.kills * k).toLocaleString("fr-FR") : "";
      const wins = typeof p.wins === "number" ? String(Math.round(p.wins * k)) : "";
      const key = `${lvl}|${kd}|${kills}|${wins}`;
      if (key !== els.lastText) {
        els.lastText = key;
        els.lvl.textContent = String(lvl);
        els.kd.textContent = kd;
        if (els.kills) els.kills.textContent = kills;
        if (els.wins) els.wins.textContent = wins;
      }
      // stats pills pop one after the other
      els.pills.forEach((pill, j) => {
        const x = Math.max(0, Math.min(1, (tf.stats - j * 0.14) / 0.3));
        const c1 = 2.2;
        const e = x <= 0 ? 0 : 1 + (c1 + 1) * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
        pill.style.transform = `rotate(${PILL_ROT[j % PILL_ROT.length]}deg) scale(${e.toFixed(3)})`;
      });
      const st = Math.max(0, tf.burst);
      els.star.style.opacity = st <= 0.001 ? "0" : Math.min(1, st * 1.4).toFixed(3);
      els.star.style.transform = `scale(${st.toFixed(3)}) rotate(${(8 * Math.sin(f.t * 3 + i)).toFixed(2)}deg)`;
      if (els.badge) {
        const b = Math.max(0, tf.badge);
        els.badge.style.opacity = Math.min(1, b).toFixed(3);
        els.badge.style.transform = `scale(${b.toFixed(3)}) rotate(${(-4 + 4 * (1 - Math.min(1, b))).toFixed(2)}deg)`;
      }
    }
    // ---- opening title
    this.place(this.title, 0.5 * w, f.title.y * h, f.title.scale, -4, f.title.opacity);
    // ---- VS stamp + shockwave ring
    const [vx, vy] = MatchIntroOverlay.map(f.vs.x, f.vs.y, f, w, h);
    this.place(this.vs, vx, vy, f.vs.scale * f.zoom, f.vs.rot, f.vs.opacity * (1 - f.exit));
    const ring = f.vs.ring;
    this.place(this.ring, vx, vy, (0.4 + 2.6 * ring) * f.zoom, 0, ring > 0 && ring < 1 ? (1 - ring) * 0.9 : 0);
    if (this.skip) this.skip.style.opacity = (0.85 * (1 - f.exit) * Math.min(1, f.t / 0.4)).toFixed(3);
    // ---- the text layer follows the exit wipe (same slanted cut)
    if (f.exit > 0) {
      const aspect = w / h;
      const edge = lerp(-0.25, 1.3, f.exit);
      const xt = (edge - (0.5 * 0.22) / aspect) * 100;
      const xb = (edge + (0.5 * 0.22) / aspect) * 100;
      this.text.style.clipPath = `polygon(${xt.toFixed(2)}% 0%, 100% 0%, 100% 100%, ${xb.toFixed(2)}% 100%)`;
    } else if (this.text.style.clipPath) {
      this.text.style.clipPath = "";
    }
  }

  /** Re-measure natural tag sizes (fonts loaded / viewport resized). */
  invalidateMeasures(): void {
    for (const t of this.tags) t.natural = null;
  }

  dispose(): void {
    this.root.remove();
  }
}

export type { TagFrame };
