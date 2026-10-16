// Interface DOM de l'écran de fin : construction, chorégraphie d'entrée, graphique de
// momentum interactif, cartes rival / proie, vote de la prochaine map.

import { avatarEl } from './avatar.js';
import { makeFormatters } from './stats.js';
import { ease, clamp, lerp } from './anim.js';

const NS = 'http://www.w3.org/2000/svg';

const ICONS = {
  swords: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4l9.5 9.5M4 4h4.2M4 4v4.2M20 4l-9.5 9.5M20 4h-4.2M20 4v4.2M8 16l-3 3M16 16l3 3M6.5 13.5l4 4M17.5 13.5l-4 4"/></svg>',
  burst: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 1.8l2.3 5.6 5.7-2.2-2.5 5.5 5.2 2.9-5.8 1.6 1.2 5.9-4.9-3.5L12 23l-1.2-5.4-4.9 3.5 1.2-5.9-5.8-1.6 5.2-2.9L4 5.2l5.7 2.2z"/></svg>',
  flame: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12.6 1.5c.6 3.6-1.3 5.3-3.1 7.3-1.6 1.8-3 3.7-3 6.5A6.6 6.6 0 0 0 13 22c3.9-.3 6.5-3.3 6.5-7 0-2.6-1.2-4.5-2.4-6-.3 1.6-1.1 2.7-2.3 3.2.7-4.2-.4-7.9-2.2-10.7zM12.4 20.3c-1.8 0-3.1-1.4-3.1-3.2 0-1.9 1.4-2.9 2.6-4.3.3 1.5 1.4 2.3 2.3 2.2-.1 1 .3 1.7 1 2.2.4 1.9-.9 3.1-2.8 3.1z"/></svg>',
  target: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="2.2" fill="currentColor"/><path d="M12 1.5v4M12 18.5v4M1.5 12h4M18.5 12h4"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 1.8l8.5 3.1v6.3c0 5.4-3.6 9.6-8.5 11-4.9-1.4-8.5-5.6-8.5-11V4.9z"/></svg>',
  crown: '<svg viewBox="0 0 26 20" fill="currentColor" stroke="#0e0d12" stroke-width="2" stroke-linejoin="round"><path d="M2 6l5.5 4.5L13 2l5.5 8.5L24 6l-2.4 12H4.4z"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5l5 5 10-11"/></svg>',
};

const ACCOLADE = {
  sniper: { icon: 'target', color: '#22e3f0' },
  streak: { icon: 'flame', color: '#f5893a' },
  damage: { icon: 'burst', color: '#ffd60a' },
  survivor: { icon: 'shield', color: '#9de20a' },
};

export const DEFAULT_STRINGS = {
  victory: 'VICTOIRE',
  defeat: 'DÉFAITE',
  place: (p) => (p === 1 ? '1<sup>er</sup>' : `${p}<sup>e</sup>`),
  of: (n) => `/ ${n}`,
  score: 'SCORE',
  performance: 'PERFORMANCE',
  highlights: 'TEMPS FORTS',
  personalStats: 'Votre partie',
  matchOver: 'FIN DE PARTIE',
  playerCount: (n) => `${n} JOUEURS`,
  quit: 'Quitter',
  skip: 'Passer',
  leaderboard: 'CLASSEMENT',
  player: 'JOUEUR',
  kills: 'ÉLIM.',
  deaths: 'MORTS',
  kdr: 'KDR',
  accuracy: 'PRÉCISION',
  you: 'VOUS',
  kdrTile: 'Ratio K/D',
  kdrSub: (k, d) => `${k} élim. · ${d} morts`,
  accTile: 'Précision',
  accSub: (h, f) => `${h} / ${f} tirs touchés`,
  accNone: 'Aucun tir',
  dmgTile: 'Dégâts',
  dmgSub: (v) => `${v} / min`,
  assistTile: 'Assistances',
  assistSub: 'éliminations aidées',
  streakTile: 'Série max',
  streakSub: "élim. d'affilée",
  momentum: 'MOMENTUM',
  momentumUp: 'Vous dominez',
  momentumDown: 'Sous pression',
  peak: (n) => (n >= 2 ? `Série ×${n}` : 'Meilleur moment'),
  trough: 'Passage à vide',
  tipKill: (n) => `Élimine ${n}`,
  tipDeath: (n) => (n ? `Éliminé par ${n}` : 'Mort'),
  tipAssist: (n) => `Aide sur ${n}`,
  tipNone: 'Rien à signaler',
  rival: 'VOTRE RIVAL',
  rivalDesc: (n) => `vous a éliminé <b>${n}</b> fois`,
  rivalNone: 'Personne ne vous a eu',
  rivalNoneSub: 'Intouchable cette partie.',
  nemesis: 'NÉMÉSIS',
  prey: 'VOTRE PROIE',
  preyDesc: (n) => `éliminé <b>${n}</b> fois`,
  preyNone: 'Aucune élimination',
  preyNoneSub: 'La prochaine sera la bonne.',
  meShort: 'VOUS',
  duelUnknown: 'Duels indisponibles',
  duelUnknownSub: 'Pas de journal des éliminations.',
  noMomentum: 'Pas de données pour cette partie',
  nextMap: 'PROCHAINE MAP',
  voteHint: 'Votez : clic ou <kbd>1</kbd>–<kbd>4</kbd>',
  voteHintTouch: 'Touchez une map pour voter',
  votes: (n) => (n > 1 ? 'VOTES' : 'VOTE'),
  yourVote: 'VOTRE VOTE',
  voteFor: (n) => `Voter pour ${n}`,
  chosen: (n) => `Prochaine map : <b>${n}</b>`,
  winner: 'PROCHAINE MAP',
  accolades: {
    sniper: 'Meilleure précision',
    streak: 'Plus longue série',
    damage: 'Le plus de dégâts',
    survivor: 'Le moins de morts',
  },
};

const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const svgEl = (tag, attrs = {}) => {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
};

export class UI {
  constructor(root, host) {
    this.root = root;
    this.host = host;
    this.unit = 1;
    this.layoutMode = 'wide';
    this.stage = null;
    this._onKey = this._onKey.bind(this);
  }

  get S() { return this.host.strings; }
  get T() { return this.host.tweens; }
  px(n) { return `${(n * this.unit).toFixed(2)}px`; }

  // ------------------------------------------------------------ mise en page

  layout() {
    const r = this.root.getBoundingClientRect();
    const w = Math.max(1, r.width); const h = Math.max(1, r.height);
    const tall = w / h < 1.22 || w < 1040;
    const narrow = tall && w < 640;
    this.layoutMode = tall ? 'tall' : 'wide';
    this.root.dataset.layout = this.layoutMode;
    if (narrow) this.root.dataset.narrow = ''; else delete this.root.dataset.narrow;
    this.unit = tall ? clamp((w - 32) / (narrow ? 540 : 760), 0.42, 1.25) : Math.min((w - 96) / 1720, (h - 100) / 932);
    this.root.style.setProperty('--u', `${this.unit}px`);
    this._syncBackplate();
    if (this.chart) this._renderChart(this.chart.revealed ? 1 : this.chart.progress);
  }

  _syncBackplate() {
    if (!this.stage || !this.backplate || this.layoutMode !== 'tall') return;
    const r = this.stage.getBoundingClientRect();
    const o = this.root.getBoundingClientRect();
    this.backplate.style.setProperty('--es-mobile-top', `${r.top - o.top}px`);
    this.backplate.style.setProperty('--es-mobile-height', `${r.height}px`);
  }

  titleSlotRect() {
    if (!this.slot) return null;
    const r = this.slot.getBoundingClientRect();
    const o = this.root.getBoundingClientRect();
    return { left: r.left - o.left, top: r.top - o.top, width: r.width, height: r.height };
  }

  // ------------------------------------------------------------ construction

  build(match) {
    this.destroy();
    this.match = match;
    this.mode = match.outcome;
    this.f = makeFormatters(this.host.opts.locale);
    const S = this.S;

    this.backplate = el('div', 'es-modal-backplate');
    this.backplate.setAttribute('aria-hidden', 'true');
    this.root.appendChild(this.backplate);
    this.root.classList.remove('es-results-ready');
    this.scroller = el('div', 'es-scroller');
    this.stage = el('div', 'es-stage');
    this.scroller.appendChild(this.stage);
    this.root.appendChild(this.scroller);
    this.scroller.addEventListener('scroll', () => this._syncBackplate(), { passive: true });
    this.stageObserver = new ResizeObserver(() => this._syncBackplate());
    this.stageObserver.observe(this.stage);

    this._buildHead();
    this._buildBoard();
    this._buildMe();
    this._buildVote();

    this.skipBtn = el('button', 'es-skip', `${esc(S.skip)}<kbd>Espace</kbd>`);
    this.skipBtn.type = 'button';
    this.skipBtn.addEventListener('click', () => this.host.skip());
    this.root.appendChild(this.skipBtn);
    this.previousFocus = document.activeElement;
    this.skipBtn.focus({ preventScroll: true });

    window.addEventListener('keydown', this._onKey);
    this.layout();
  }

  _buildHead() {
    const S = this.S; const m = this.match; const f = this.f;
    const head = el('header', 'es-head');
    const title = this.mode === 'victory' ? S.victory : S.defeat;
    const parts = [esc(m.mode)];
    if (m.mapName) parts.push(esc(m.mapName).toUpperCase());
    head.innerHTML = `
      <div class="es-title-slot" aria-hidden="true"></div>
      <h1 class="es-sr">${esc(title)}</h1>
      <span class="es-head-label es-pre">${esc(S.matchOver)}</span>
      <div class="es-pills">
        <div class="es-pill es-pill-place es-pre"><b>${S.place(m.me.placement)}</b><span>${esc(S.of(m.total))}</span></div>
        <div class="es-pill es-pill-wood es-pre">${parts.join('<i></i>')}<i></i><span class="es-clock">${f.time(m.duration)}</span></div>
        <div class="es-pill es-pill-score es-pre"><span>${esc(S.score)}</span><b data-v>0</b></div>
      </div>
      <button class="es-quit es-pre" type="button">${esc(S.quit)}</button>`;
    this.root.setAttribute('aria-label', title);
    const mascot = el('div', 'es-mascot es-pre');
    mascot.setAttribute('aria-hidden', 'true');
    mascot.appendChild(avatarEl(m.me, this.mode === 'victory' ? 'happy' : 'ko'));
    mascot.insertAdjacentHTML('beforeend', `<span class="es-mascot-spark">${ICONS.burst}</span>`);
    head.prepend(mascot);
    this.mascot = mascot;
    this.headLabel = head.querySelector('.es-head-label');
    this.slot = head.querySelector('.es-title-slot');
    this.pills = [...head.querySelectorAll('.es-pill')];
    this.quitBtn = head.querySelector('.es-quit');
    this.quitBtn.addEventListener('click', () => this.host.opts.onQuit?.());
    this.stage.appendChild(head);
  }

  _buildBoard() {
    const S = this.S; const m = this.match;
    const wrap = el('div', 'es-wrap es-board-wrap es-pre');
    const board = el('section', 'es-panel es-board es-cols');
    board.setAttribute('aria-label', S.leaderboard);
    board.innerHTML = `
      <div class="es-tab"><span>${esc(S.leaderboard)}</span><i class="es-tab-dot"></i></div>
      <span class="es-board-count">${esc(S.playerCount(m.total))}</span>
      <div class="es-board-head" aria-hidden="true"><span>#</span><span class="es-h-name">${esc(S.player)}</span><span>${esc(S.kills)}</span><span>${esc(S.deaths)}</span><span>${esc(S.kdr)}</span><span>${esc(S.accuracy)}</span><span class="es-h-score">${esc(S.score)}</span></div>`;
    const list = el('ol', 'es-rows');
    this.rows = [];
    for (const p of m.players) {
      const li = el('li', `es-row es-pre${p.isMe ? ' es-me' : ''}`);
      li.dataset.rank = String(p.placement);
      const rank = el('span', 'es-rank', String(p.placement));
      if (p.placement === 1) rank.insertAdjacentHTML('beforeend', `<span class="es-crown es-pre">${ICONS.crown}</span>`);
      const name = el('span', 'es-name');
      name.appendChild(el('span', 'es-name-txt', esc(p.name)));
      if (p.isMe) name.appendChild(el('span', 'es-you', esc(S.you)));
      const badges = el('span', 'es-badges');
      for (const key of (m.accolades.get(p.id) ?? []).slice(0, 2)) {
        const a = ACCOLADE[key];
        const b = el('span', 'es-badge es-pre', ICONS[a.icon]);
        b.style.setProperty('--b', a.color);
        b.title = S.accolades[key] ?? key;
        badges.appendChild(b);
      }
      name.appendChild(badges);
      li.append(rank, avatarEl(p, 'happy'), name);
      const k = el('span', 'es-num', '0');
      const d = el('span', 'es-num es-dim', '0');
      const kdr = el('span', 'es-num', this.f.dec2(0));
      const acc = el('span', 'es-acc', `<span class="es-bar"><i></i></span><b>${p.accuracy == null ? '—' : '0 %'}</b>`);
      const score = el('span', 'es-score', '0');
      li.append(k, d, kdr, acc, score);
      li.setAttribute('aria-label', `${p.placement}. ${p.name} — ${p.kills} ${S.kills}, ${p.deaths} ${S.deaths}, ${S.kdr} ${this.f.dec2(p.kdr)}, ${S.score} ${p.score}`);
      list.appendChild(li);
      this.rows.push({ li, p, k, d, kdr, accBar: acc.querySelector('i'), accTxt: acc.querySelector('b'), score, badges: [...badges.children], crown: rank.querySelector('.es-crown') });
    }
    board.appendChild(list);
    wrap.appendChild(board);
    this.boardWrap = wrap;
    this.stage.appendChild(wrap);
  }

  _buildMe() {
    const S = this.S; const m = this.match; const me = m.me; const f = this.f;
    const col = el('div', 'es-me-col');
    const switcher = el('div', 'es-view-switch es-pre');
    switcher.setAttribute('role', 'tablist');
    switcher.setAttribute('aria-label', S.personalStats);
    const uid = `es-${Math.random().toString(36).slice(2, 9)}`;
    switcher.innerHTML = `<button type="button" role="tab" id="${uid}-stats-tab" aria-controls="${uid}-stats" aria-selected="true" data-view="stats">${esc(S.performance)}</button><button type="button" role="tab" id="${uid}-details-tab" aria-controls="${uid}-details" aria-selected="false" tabindex="-1" data-view="details">${esc(S.highlights)}</button>`;
    this.viewSwitch = switcher;
    col.appendChild(switcher);
    const tiles = el('div', 'es-tiles');
    tiles.id = `${uid}-stats`;
    tiles.setAttribute('role', 'tabpanel');
    tiles.setAttribute('aria-labelledby', `${uid}-stats-tab`);
    this.statsView = tiles;
    const mins = Math.max(1, m.duration / 60);
    const specs = [
      { key: 'kdr', icon: ICONS.swords, color: '#22e3f0', label: S.kdrTile, value: me.kdr, fmt: f.dec2, sub: S.kdrSub(me.kills, me.deaths) },
      me.accuracy == null
        ? { key: 'acc', ring: 0, label: S.accTile, value: null, sub: S.accNone }
        : { key: 'acc', ring: me.accuracy, label: S.accTile, value: me.accuracy * 100, fmt: (v) => `${f.int(v)}<small>%</small>`, sub: S.accSub(me.shotsHit ?? 0, me.shotsFired ?? 0) },
      me.damage != null
        ? { key: 'dmg', icon: ICONS.burst, color: '#ffd60a', label: S.dmgTile, value: me.damage, fmt: f.int, sub: S.dmgSub(f.int(me.damage / mins)) }
        : { key: 'ast', icon: ICONS.shield, color: '#9de20a', label: S.assistTile, value: me.assists, fmt: f.int, sub: S.assistSub },
      { key: 'streak', icon: ICONS.flame, color: '#f5893a', label: S.streakTile, value: me.bestStreak, fmt: (v) => `×${f.int(v)}`, sub: me.bestStreak == null ? '' : S.streakSub },
    ];
    this.tiles = specs.map((s) => {
      const wrap = el('div', 'es-wrap es-pre');
      const tile = el('div', 'es-panel es-tile');
      tile.dataset.stat = s.key;
      let iconHtml;
      if (s.ring != null) {
        iconHtml = `<div class="es-tile-icon es-ring"><svg viewBox="0 0 42 42"><circle cx="21" cy="21" r="15" fill="none" stroke="#2e2f3e" stroke-width="7"/><circle class="es-ring-fg" cx="21" cy="21" r="15" fill="none" stroke="#22e3f0" stroke-width="7" stroke-linecap="round" stroke-dasharray="94.25" stroke-dashoffset="94.25"/></svg></div>`;
      } else {
        iconHtml = `<div class="es-tile-icon" style="--c:${s.color}">${s.icon}</div>`;
      }
      tile.innerHTML = `${iconHtml}<div class="es-tile-label">${esc(s.label)}</div><div class="es-tile-value">${s.value == null ? '—' : (s.fmt ? s.fmt(0) : '0')}</div><div class="es-tile-sub">${esc(s.sub)}</div>`;
      wrap.appendChild(tile);
      tiles.appendChild(wrap);
      this._tilt(tile, 7);
      return { wrap, tile, spec: s, valueEl: tile.querySelector('.es-tile-value'), ringEl: tile.querySelector('.es-ring-fg') };
    });
    col.appendChild(tiles);

    const lower = el('div', 'es-lower');
    lower.id = `${uid}-details`;
    lower.hidden = true;
    lower.setAttribute('role', 'tabpanel');
    lower.setAttribute('aria-labelledby', `${uid}-details-tab`);
    this.detailsView = lower;
    switcher.querySelectorAll('button').forEach((button) => {
      button.addEventListener('click', () => this._selectView(button.dataset.view));
      button.addEventListener('keydown', (e) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
        e.preventDefault();
        const next = e.key === 'Home' ? 'stats' : e.key === 'End' ? 'details' : button.dataset.view === 'stats' ? 'details' : 'stats';
        this._selectView(next);
        switcher.querySelector(`[data-view="${next}"]`).focus();
      });
    });
    // momentum
    const cw = el('div', 'es-wrap es-chart-wrap es-pre');
    const chart = el('section', 'es-panel es-chart');
    chart.setAttribute('aria-label', S.momentum);
    chart.innerHTML = `<div class="es-tab"><span>${esc(S.momentum)}</span></div>
      <div class="es-legend" aria-hidden="true"><span><i></i>${esc(S.momentumUp)}</span><span class="es-neg"><i></i>${esc(S.momentumDown)}</span></div>
      <div class="es-plot"></div>`;
    cw.appendChild(chart);
    lower.appendChild(cw);
    this.chartWrap = cw;
    this.plot = chart.querySelector('.es-plot');

    // duels
    const duels = el('div', 'es-duels');
    this.rivalFlip = this._duelCard('rival');
    this.preyFlip = this._duelCard('prey');
    duels.append(this.rivalFlip.flip, this.preyFlip.flip);
    lower.appendChild(duels);
    col.appendChild(lower);
    this.stage.appendChild(col);
  }

  _selectView(view) {
    if (!this.entered || this.activeView === view) return;
    this.activeView = view;
    const details = view === 'details';
    this.statsView.hidden = details;
    this.detailsView.hidden = !details;
    this.viewSwitch.querySelectorAll('button').forEach((button) => {
      const selected = button.dataset.view === view;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    this._syncBackplate();
    if (details && !this.highlightsEntered) this._enterHighlights();
    if (details && this.chart) this._renderChart(this.chart.revealed ? 1 : this.chart.progress);
    this.host.sfx.play('pop', { pitch: details ? 1.2 : 1 });
    if (!this.host.opts.reducedMotion) this.T.animate(details ? this.detailsView : this.statsView, [
      { opacity: 0, transform: 'translateY(9px) scale(.975)' },
      { opacity: 1, transform: 'none' },
    ], { duration: 330, easing: 'cubic-bezier(.2,1.3,.4,1)', fill: 'none' });
  }

  _duelCard(kind) {
    const S = this.S; const m = this.match; const f = this.f;
    const flip = el('div', 'es-flip es-pre');
    flip.appendChild(el('div', 'es-flip-back', '?'));
    const card = el('section', `es-panel es-duel es-${kind}`);
    const data = kind === 'rival' ? m.rival : m.prey;
    const tab = kind === 'rival' ? `<div class="es-tab es-red">${esc(S.rival)}</div>` : `<div class="es-tab es-green">${esc(S.prey)}</div>`;
    let ratio = 0.5;
    if (!data || data.unknown) {
      const title = data?.unknown ? S.duelUnknown : (kind === 'rival' ? S.rivalNone : S.preyNone);
      const sub = data?.unknown ? S.duelUnknownSub : (kind === 'rival' ? S.rivalNoneSub : S.preyNoneSub);
      card.innerHTML = `${tab}<div class="es-duel-empty"><b>${esc(title)}</b>${esc(sub)}</div>`;
      flip.appendChild(card);
      this._tilt(card, 6);
      return { flip, card, data: null };
    }
    const p = data.player;
    const mine = data.myKills; const theirs = data.theirKills;
    ratio = mine + theirs > 0 ? mine / (mine + theirs) : 0.5;
    card.innerHTML = `${tab}
      <div class="es-duel-info">
        <div class="es-duel-name">${esc(p.name)}</div>
        <div class="es-duel-desc">${kind === 'rival' ? S.rivalDesc(f.int(theirs)) : S.preyDesc(f.int(mine))}</div>
        <div class="es-vs"><b class="es-vs-me">${f.int(mine)}</b><div class="es-vs-bar"><i></i></div><b class="es-vs-them">${f.int(theirs)}</b></div>
        <div class="es-vs-labels"><span>${esc(S.meShort)}</span><span>${esc(p.name.toUpperCase().slice(0, 14))}</span></div>
      </div>
      ${kind === 'rival' ? `<div class="es-stamp">${esc(S.nemesis)}</div>` : ''}`;
    card.insertBefore(avatarEl(p, kind === 'rival' ? 'smug' : 'ko'), card.querySelector('.es-duel-info'));
    flip.appendChild(card);
    this._tilt(card, 6);
    return { flip, card, data, ratio, bar: card.querySelector('.es-vs-bar i'), stamp: card.querySelector('.es-stamp') };
  }

  _buildVote() {
    const S = this.S;
    const maps = (this.match.raw.maps ?? []).slice(0, 4);
    this.maps = maps;
    const sec = el('section', 'es-vote');
    sec.setAttribute('aria-label', S.nextMap);
    const headWrap = el('div', 'es-wrap es-pre');
    const head = el('div', 'es-panel es-vote-head');
    head.innerHTML = `<div class="es-tab"><span>${esc(S.nextMap)}</span></div>
      <div class="es-timer"><svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="50" fill="none" stroke="#2e2f3e" stroke-width="12"/><circle class="es-timer-fg" cx="60" cy="60" r="50" fill="none" stroke="#22e3f0" stroke-width="12" stroke-linecap="round" stroke-dasharray="314.16" stroke-dashoffset="0"/></svg><b>${Math.ceil(this.host.opts.voteDuration ?? 0) || '–'}</b></div>
      <p class="es-vote-hint" aria-live="polite">${this._coarse() ? esc(S.voteHintTouch) : S.voteHint}</p>`;
    headWrap.appendChild(head);
    this.timerEl = head.querySelector('.es-timer');
    this.timerFg = head.querySelector('.es-timer-fg');
    this.timerTxt = head.querySelector('.es-timer b');
    this.voteHint = head.querySelector('.es-vote-hint');
    const grid = el('div', 'es-maps');
    grid.style.setProperty('--es-map-cols', String(Math.max(1, maps.length)));
    this.mapCards = maps.map((mp, i) => {
      const wrap = el('div', 'es-map-wrap es-pre');
      const btn = el('button', 'es-map');
      btn.type = 'button';
      btn.dataset.id = mp.id;
      btn.setAttribute('aria-label', S.voteFor(mp.name));
      // Real map screenshot (src/endscreen/maps/*.webp — see tools/endscreen).
      const art = mp.image ? `background-image:url('${esc(mp.image)}')` : 'background:#475b80';
      btn.innerHTML = `<span class="es-map-art" style="${art}"></span><span class="es-map-glare"></span>
        <kbd class="es-map-key">${i + 1}</kbd>
        <span class="es-map-count"><span data-c>0</span><small>${esc(S.votes(0))}</small></span>
        <span class="es-map-foot"><b class="es-map-name">${esc(String(mp.name).toUpperCase())}</b>${mp.subtitle ? `<span class="es-map-sub">${esc(mp.subtitle)}</span>` : ''}<span class="es-voters"></span></span>
        <span class="es-map-bar"><i></i></span><span class="es-map-badge">${esc(S.yourVote)}</span>`;
      btn.addEventListener('click', () => this.vote(mp.id));
      this._tiltMap(btn);
      wrap.appendChild(btn);
      grid.appendChild(wrap);
      return { wrap, btn, map: mp, count: btn.querySelector('[data-c]'), voters: btn.querySelector('.es-voters'), bar: btn.querySelector('.es-map-bar i') };
    });
    sec.append(headWrap, grid);
    this.voteHeadWrap = headWrap;
    this.mapsGrid = grid;
    this.stage.appendChild(sec);
    this.votes = new Map(maps.map((mp) => [mp.id, { ids: new Set(), extra: 0 }]));
    this.myVote = null;
    this.voteDone = false;
    this.voteEndsAt = null;
  }

  _coarse() { return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches; }

  // ------------------------------------------------------------ interactions

  _tilt(node, max) {
    if (this.host.opts.reducedMotion) return;
    node.addEventListener('pointermove', (e) => {
      const r = node.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5; const y = (e.clientY - r.top) / r.height - 0.5;
      node.style.transform = `perspective(${this.px(900)}) rotateX(${(-y * max).toFixed(2)}deg) rotateY(${(x * max).toFixed(2)}deg)`;
    });
    node.addEventListener('pointerleave', () => { node.style.transform = ''; });
    node.style.transition = 'transform .2s ease-out';
  }

  _tiltMap(btn) {
    if (this.host.opts.reducedMotion) return;
    btn.addEventListener('pointermove', (e) => {
      const r = btn.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width; const y = (e.clientY - r.top) / r.height;
      btn.style.setProperty('--rx', `${((0.5 - y) * 12).toFixed(2)}deg`);
      btn.style.setProperty('--ry', `${((x - 0.5) * 14).toFixed(2)}deg`);
      btn.style.setProperty('--gx', `${(x * 100).toFixed(1)}%`);
      btn.style.setProperty('--gy', `${(y * 100).toFixed(1)}%`);
    });
    btn.addEventListener('pointerleave', () => { btn.style.removeProperty('--rx'); btn.style.removeProperty('--ry'); });
  }

  _onKey(e) {
    if (!this.stage || e.defaultPrevented) return;
    if (e.key === 'Tab') {
      const controls = [...this.root.querySelectorAll('button:not(:disabled)')].filter((b) => b.tabIndex >= 0 && b.getClientRects().length && !b.closest('.es-pre') && !b.closest('[hidden]'));
      const first = controls[0]; const last = controls[controls.length - 1];
      if (first && (!this.root.contains(document.activeElement) || (e.shiftKey && document.activeElement === first) || (!e.shiftKey && document.activeElement === last))) {
        e.preventDefault(); (e.shiftKey ? last : first).focus();
      }
    }
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if ((e.code === 'Space' || e.key === 'Enter') && this.host.introPlaying) { e.preventDefault(); this.host.skip(); return; }
    const n = Number(e.key);
    if (n >= 1 && n <= this.mapCards.length && this.entered) { this.vote(this.mapCards[n - 1].map.id); }
  }

  // ------------------------------------------------------------ entrée animée

  enter() {
    const T = this.T; const S = this.S; const f = this.f; const m = this.match;
    const V = this.mode === 'victory';
    const rm = this.host.opts.reducedMotion;
    const sfx = (n, o) => this.host.sfx.play(n, o);
    const show = (node) => node && node.classList.remove('es-pre');
    const anim = (node, kf, o) => { show(node); return rm ? T.animate(node, [{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: 'ease-out' }) : T.animate(node, kf, o); };
    const px = (n) => this.px(n);
    this.entered = true;
    this.activeView = 'stats';
    this.root.classList.add('es-results-ready');
    this.skipBtn.hidden = true;
    anim(this.mascot, [{ transform: 'rotate(-15deg) scale(.55)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 680, easing: 'cubic-bezier(.2,1.5,.4,1)' });
    anim(this.headLabel, [{ opacity: 0 }, { opacity: 1 }], { duration: 500 });
    T.at(0.25, () => anim(this.viewSwitch, [{ opacity: 0 }, { opacity: 1 }], { duration: 400 }));
    T.at(0.75, () => this.quitBtn.focus({ preventScroll: true }));

    // en-tête
    this.pills.forEach((p, i) => T.at(0.05 + i * 0.08, () => {
      anim(p, [{ transform: `translateY(${px(26)}) scale(.55)`, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 480, easing: 'cubic-bezier(.2,1.5,.4,1)' });
      sfx('pop', { pitch: 1.2 + i * 0.1 });
    }));
    T.at(0.3, () => anim(this.quitBtn, [{ opacity: 0 }, { opacity: 1 }], { duration: 400 }));
    const scoreEl = this.pills[2].querySelector('[data-v]');
    this._count(scoreEl, m.me.score, { delay: 0.25, dur: 1.2, fmt: f.int });

    // classement
    T.at(0.1, () => {
      anim(this.boardWrap, [
        { transform: `translateX(${px(-150)}) rotateY(26deg)`, opacity: 0 },
        { transform: `translateX(${px(10)}) rotateY(-3deg)`, opacity: 1, offset: 0.7 },
        { transform: 'none', opacity: 1 },
      ], { duration: 720, easing: 'cubic-bezier(.2,.8,.3,1)' });
      sfx('whoosh', { dur: 0.35 });
    });
    const stagger = V ? 0.065 : 0.085;
    this.rows.forEach((r, i) => {
      const d = 0.34 + i * stagger;
      T.at(d, () => {
        anim(r.li, V
          ? [{ transform: 'rotateX(-100deg)', opacity: 0 }, { transform: 'rotateX(16deg)', opacity: 1, offset: 0.62 }, { transform: 'rotateX(0deg)', opacity: 1 }]
          : [{ transform: `translate(${px(-70)}, ${px(-14)})`, opacity: 0 }, { transform: `translate(${px(5)}, ${px(2)})`, opacity: 1, offset: 0.72 }, { transform: 'none', opacity: 1 }],
        { duration: 540, easing: 'cubic-bezier(.25,.9,.35,1)' });
        sfx('tick', { pitch: 1 + (this.rows.length - i) * 0.04 });
      });
      const p = r.p;
      this._count(r.k, p.kills, { delay: d + 0.05, dur: 0.9, fmt: f.int });
      this._count(r.d, p.deaths, { delay: d + 0.05, dur: 0.9, fmt: f.int });
      this._count(r.kdr, p.kdr, { delay: d + 0.05, dur: 1.0, fmt: f.dec2 });
      this._count(r.score, p.score, { delay: d + 0.05, dur: 1.1, fmt: f.int });
      if (p.accuracy != null) {
        T.add({ delay: d + 0.12, duration: 1.0, ease: ease.outCubic, onUpdate: (k) => {
          r.accBar.style.width = `${(p.accuracy * 100 * k).toFixed(1)}%`;
          r.accTxt.textContent = `${f.int(p.accuracy * 100 * k)} %`;
        } });
      }
    });
    const rowsEnd = 0.34 + this.rows.length * stagger;
    const me = this.rows.find((r) => r.p.isMe);
    if (me) T.at(rowsEnd + 0.35, () => {
      me.li.classList.add('es-shine');
      if (!rm) T.animate(me.li, [{ transform: 'scale(1)' }, { transform: 'scale(1.035)', offset: 0.35 }, { transform: 'scale(1)' }], { duration: 520, easing: 'ease-out', fill: 'none' });
      sfx(V ? 'pop' : 'tick', { pitch: 1.6 });
    });
    this.rows.forEach((r) => r.crown && T.at(rowsEnd + 0.15, () => {
      anim(r.crown, [{ transform: `translate(-50%, ${px(-30)}) scale(.2) rotate(-30deg)`, opacity: 0 }, { transform: 'translate(-50%, 0) scale(1) rotate(0)', opacity: 1 }], { duration: 520, easing: 'cubic-bezier(.2,1.6,.4,1)' });
    }));
    let bi = 0;
    this.rows.forEach((r) => r.badges.forEach((b) => {
      T.at(rowsEnd + 0.5 + bi++ * 0.07, () => {
        anim(b, [{ transform: 'scale(0) rotate(-90deg)', opacity: 0 }, { transform: 'scale(1) rotate(0)', opacity: 1 }], { duration: 420, easing: 'cubic-bezier(.2,1.7,.4,1)' });
        sfx('pop', { pitch: 1.8 });
      });
    }));

    // tuiles
    this.tiles.forEach((t, i) => {
      const d = 0.22 + i * 0.09;
      T.at(d, () => anim(t.wrap, V
        ? [{ transform: `translateY(${px(46)}) rotateX(-55deg) scale(.82)`, opacity: 0 }, { transform: 'none', opacity: 1 }]
        : [{ transform: `translateY(${px(-40)}) scale(.94)`, opacity: 0 }, { transform: `translateY(${px(5)})`, opacity: 1, offset: 0.75 }, { transform: 'none', opacity: 1 }],
      { duration: 620, easing: V ? 'cubic-bezier(.2,1.35,.45,1)' : 'cubic-bezier(.5,0,.4,1)' }));
      const s = t.spec;
      if (s.value != null) {
        T.add({ delay: d + 0.15, duration: 1.15, ease: ease.outExpo, onUpdate: (k) => { t.valueEl.innerHTML = s.fmt(s.value * k); } });
      }
      if (t.ringEl && s.ring) {
        T.add({ delay: d + 0.15, duration: 1.15, ease: ease.outExpo, onUpdate: (k) => { t.ringEl.setAttribute('stroke-dashoffset', (94.25 * (1 - s.ring * k)).toFixed(2)); } });
      }
    });

    // vote
    T.at(0.95, () => anim(this.voteHeadWrap, [{ transform: `translateY(${px(60)}) scale(.8)`, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 560, easing: 'cubic-bezier(.2,1.4,.4,1)' }));
    this.mapCards.forEach((c, i) => {
      const rz = (i - 1.5) * 5;
      T.at(1.08 + i * 0.09, () => {
        anim(c.wrap, [
          { transform: `translateY(${px(240)}) rotateX(58deg) rotateZ(${rz}deg) scale(.82)`, opacity: 0 },
          { transform: `translateY(${px(-12)}) rotateX(-6deg) rotateZ(${-rz * 0.2}deg) scale(1.02)`, opacity: 1, offset: 0.66 },
          { transform: 'none', opacity: 1 },
        ], { duration: 720, easing: 'cubic-bezier(.2,.9,.3,1)' });
        sfx('pop', { pitch: 0.9 + i * 0.12 });
      });
    });
    T.at(1.55, () => this._startTimer());
    this._renderVotes();
  }

  // Rejoue la chorégraphie originale à la première ouverture de cet onglet,
  // afin que ses effets et bruitages ne soient pas joués hors champ.
  _enterHighlights() {
    this.highlightsEntered = true;
    const T = this.T;
    const rm = this.host.opts.reducedMotion;
    const sfx = (n, o) => this.host.sfx.play(n, o);
    const px = (n) => this.px(n);
    const anim = (node, kf, o) => {
      node?.classList.remove('es-pre');
      return rm ? T.animate(node, [{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: 'ease-out' }) : T.animate(node, kf, o);
    };
    // momentum
    T.at(0.42, () => anim(this.chartWrap, [
      { transform: `translateY(${px(60)}) rotateX(35deg)`, opacity: 0 },
      { transform: 'none', opacity: 1 },
    ], { duration: 640, easing: 'cubic-bezier(.2,1.1,.4,1)' }));
    this._initChart();
    T.add({ delay: 0.72, duration: rm ? 0.01 : 1.5, ease: ease.inOutSine, onUpdate: (k) => this._renderChart(k), onComplete: () => { this.chart.revealed = true; this._renderChart(1); } });

    // duels
    const flipIn = (c, d) => {
      T.at(d, () => {
        anim(c.flip, [
          { transform: 'rotateY(180deg) scale(.86)', opacity: 0 },
          { opacity: 1, offset: 0.12 },
          { transform: 'rotateY(-14deg) scale(1.02)', opacity: 1, offset: 0.72 },
          { transform: 'none', opacity: 1 },
        ], { duration: 900, easing: 'cubic-bezier(.3,.6,.3,1)' });
        sfx('whoosh', { dur: 0.3 });
      });
      if (c.bar) {
        T.add({ delay: d + 0.75, duration: 0.8, ease: ease.outBack, onUpdate: (k) => { c.bar.style.width = `${(lerp(0.5, c.ratio, k) * 100).toFixed(1)}%`; } });
      }
      if (c.stamp) {
        T.at(d + 1.0, () => {
          anim(c.stamp, [
            { transform: 'rotate(-11deg) scale(2.8)', opacity: 0 },
            { transform: 'rotate(-11deg) scale(.9)', opacity: 1, offset: 0.7 },
            { transform: 'rotate(-11deg) scale(1)', opacity: 1 },
          ], { duration: 340, easing: 'cubic-bezier(.55,0,.8,.3)' });
          T.at(0.25, () => {
            sfx('stamp');
            if (!rm) T.animate(c.card, [{ translate: '0 0' }, { translate: `${px(-4)} ${px(3)}` }, { translate: `${px(3)} ${px(-2)}` }, { translate: '0 0' }], { duration: 220, fill: 'none' });
          });
        });
      }
    };
    flipIn(this.rivalFlip, 0.85);
    flipIn(this.preyFlip, 1.05);

  }

  _count(node, to, { delay = 0, dur = 1, fmt, e = ease.outCubic }) {
    this.T.add({ delay, duration: dur, ease: e, onUpdate: (k) => { node.textContent = fmt(to * k); } });
  }

  // ------------------------------------------------------------ graphique momentum

  _initChart() {
    const m = this.match.momentum;
    this.chart = { progress: 0, revealed: false, hoverI: -1, m };
    this.plot.innerHTML = '';
    if (m.empty) {
      this.chart.empty = true;
      this.plot.appendChild(el('div', 'es-duel-empty es-chart-empty', `<b>—</b>${esc(this.S.noMomentum)}`));
      return;
    }
    const svg = svgEl('svg', { 'aria-hidden': 'true' });
    this.plot.appendChild(svg);
    this.chart.svg = svg;
    this.tip = el('div', 'es-tip');
    this.plot.appendChild(this.tip);
    this.plot.addEventListener('pointermove', (e) => this._hover(e));
    this.plot.addEventListener('pointerleave', () => this._hover(null));
  }

  _geom() {
    const w = Math.max(10, this.plot.clientWidth); const h = Math.max(10, this.plot.clientHeight);
    const U = this.unit;
    const padL = 8 * U; const padR = 10 * U; const padT = 34 * U; const rail = 20 * U; const axis = 24 * U;
    const top = padT; const bottom = h - rail - axis - 6 * U;
    const mid = (top + bottom) / 2;
    const m = this.match.momentum;
    const dur = this.match.duration;
    const x = (t) => padL + (t / dur) * (w - padL - padR);
    const y = (v) => mid - (v / m.range) * ((bottom - top) / 2);
    return { w, h, U, padL, padR, top, bottom, mid, rail, axis, x, y, railY: bottom + 6 * U + rail / 2 };
  }

  _renderChart(k) {
    if (!this.chart || this.chart.empty) return;
    this.chart.progress = k;
    if (this.detailsView?.hidden) return;
    const g = this._geom();
    const { w, h, U, x, y, mid, top, bottom } = g;
    const m = this.match.momentum;
    const svg = this.chart.svg;
    svg.setAttribute('viewBox', `0 0 ${w.toFixed(1)} ${h.toFixed(1)}`);
    const id = this.chart.uid ??= `esm${Math.random().toString(36).slice(2, 8)}`;
    let line = '';
    for (let i = 0; i < m.t.length; i++) line += `${i ? 'L' : 'M'}${x(m.t[i]).toFixed(1)} ${y(m.v[i]).toFixed(1)}`;
    const area = `${line}L${x(m.t[m.t.length - 1]).toFixed(1)} ${mid.toFixed(1)}L${x(m.t[0]).toFixed(1)} ${mid.toFixed(1)}Z`;
    const revealX = g.padL + (w - g.padL - g.padR) * k;
    const dur = this.match.duration;
    const step = dur > 900 ? 300 : dur > 420 ? 120 : dur > 180 ? 60 : 30;
    let ticks = '';
    for (let t = 0; t <= dur + 0.01; t += step) {
      const xx = x(t);
      ticks += `<line x1="${xx.toFixed(1)}" x2="${xx.toFixed(1)}" y1="${top}" y2="${bottom}" stroke="#2a2b39" stroke-width="${U}"/>`;
      ticks += `<text x="${xx.toFixed(1)}" y="${(h - 4 * U).toFixed(1)}" fill="#8f8ba3" font-size="${(14 * U).toFixed(1)}" font-weight="800" style="font-family:var(--es-font-body)" text-anchor="${t === 0 ? 'start' : t + step > dur + 0.01 ? 'end' : 'middle'}">${this.f.time(t)}</text>`;
    }
    const ev = this.match.events;
    let rail = `<line x1="${g.padL}" x2="${(w - g.padR).toFixed(1)}" y1="${g.railY.toFixed(1)}" y2="${g.railY.toFixed(1)}" stroke="#2e2f3e" stroke-width="${2 * U}" stroke-linecap="round"/>`;
    for (const e of ev) {
      const xx = x(e.t);
      if (xx > revealX + 0.5) continue;
      const pop = clamp((revealX - xx) / (24 * U));
      const s = (0.4 + 0.6 * ease.outBack(pop)) * U;
      if (e.type === 'kill') rail += `<circle cx="${xx.toFixed(1)}" cy="${g.railY.toFixed(1)}" r="${(4.4 * s).toFixed(2)}" fill="#22e3f0" stroke="#0e0d12" stroke-width="${2 * U}"/>`;
      else if (e.type === 'death') rail += `<path d="M${(xx - 4 * s).toFixed(1)} ${(g.railY - 4 * s).toFixed(1)}l${(8 * s).toFixed(1)} ${(8 * s).toFixed(1)}m0 ${(-8 * s).toFixed(1)}l${(-8 * s).toFixed(1)} ${(8 * s).toFixed(1)}" stroke="#f5893a" stroke-width="${3 * U}" stroke-linecap="round"/>`;
      else rail += `<circle cx="${xx.toFixed(1)}" cy="${g.railY.toFixed(1)}" r="${(2.8 * s).toFixed(2)}" fill="#f7f0e2" stroke="#0e0d12" stroke-width="${1.5 * U}"/>`;
    }
    const pk = m.peak; const tr = m.trough;
    const showPk = k >= 1 && pk.v > 0.3;
    const showTr = k >= 1 && tr.v < -0.3;
    const headI = Math.min(m.t.length - 1, Math.round(k * (m.t.length - 1)));
    const hover = this.chart.hoverI;
    svg.innerHTML = `
      <defs>
        <linearGradient id="${id}up" x1="0" y1="${top}" x2="0" y2="${mid}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#22e3f0" stop-opacity=".62"/><stop offset="1" stop-color="#22e3f0" stop-opacity=".06"/></linearGradient>
        <linearGradient id="${id}dn" x1="0" y1="${mid}" x2="0" y2="${bottom}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#f5893a" stop-opacity=".06"/><stop offset="1" stop-color="#f5893a" stop-opacity=".62"/></linearGradient>
        <clipPath id="${id}a"><rect x="0" y="-50" width="${revealX.toFixed(1)}" height="${(mid + 50).toFixed(1)}"/></clipPath>
        <clipPath id="${id}b"><rect x="0" y="${mid.toFixed(1)}" width="${revealX.toFixed(1)}" height="${(h - mid + 50).toFixed(1)}"/></clipPath>
        <clipPath id="${id}r"><rect x="0" y="-50" width="${revealX.toFixed(1)}" height="${h + 100}"/></clipPath>
      </defs>
      ${ticks}
      <line x1="${g.padL}" x2="${(w - g.padR).toFixed(1)}" y1="${mid.toFixed(1)}" y2="${mid.toFixed(1)}" stroke="#4a4b5e" stroke-width="${1.5 * U}"/>
      <path d="${area}" fill="url(#${id}up)" clip-path="url(#${id}a)"/>
      <path d="${area}" fill="url(#${id}dn)" clip-path="url(#${id}b)"/>
      <path d="${line}" fill="none" stroke="#0e0d12" stroke-width="${6.5 * U}" stroke-linejoin="round" stroke-linecap="round" clip-path="url(#${id}r)"/>
      <path d="${line}" fill="none" stroke="#22e3f0" stroke-width="${3.2 * U}" stroke-linejoin="round" stroke-linecap="round" clip-path="url(#${id}a)"/>
      <path d="${line}" fill="none" stroke="#f5893a" stroke-width="${3.2 * U}" stroke-linejoin="round" stroke-linecap="round" clip-path="url(#${id}b)"/>
      ${rail}
      ${k < 1 && k > 0 ? `<circle cx="${x(m.t[headI]).toFixed(1)}" cy="${y(m.v[headI]).toFixed(1)}" r="${7 * U}" fill="#fff" stroke="#0e0d12" stroke-width="${3 * U}"/><circle cx="${x(m.t[headI]).toFixed(1)}" cy="${y(m.v[headI]).toFixed(1)}" r="${16 * U}" fill="#fff" opacity=".18"/>` : ''}
      ${showPk ? this._annotation(x(pk.t), y(pk.v), this.S.peak(m.streakAtPeak), '#22e3f0', 'up', g) : ''}
      ${showTr ? this._annotation(x(tr.t), y(tr.v), this.S.trough, '#f5893a', 'down', g) : ''}
      ${hover >= 0 ? `<line x1="${x(m.t[hover]).toFixed(1)}" x2="${x(m.t[hover]).toFixed(1)}" y1="${top}" y2="${bottom}" stroke="#f7f0e2" stroke-opacity=".5" stroke-width="${1.5 * U}"/><circle cx="${x(m.t[hover]).toFixed(1)}" cy="${y(m.v[hover]).toFixed(1)}" r="${6.5 * U}" fill="${m.v[hover] >= 0 ? '#22e3f0' : '#f5893a'}" stroke="#0e0d12" stroke-width="${3 * U}"/>` : ''}`;
  }

  _annotation(px, py, text, color, dir, g) {
    const U = g.U;
    const fs = 15 * U;
    const tw = text.length * fs * 0.52 + 22 * U;
    const th = 28 * U;
    let bx = clamp(px - tw / 2, g.padL, g.w - g.padR - tw);
    let by = dir === 'up' ? py - th - 16 * U : py + 16 * U;
    if (dir === 'up' && by < 2 * U) by = py + 16 * U;
    if (dir === 'down' && by + th > g.bottom) by = py - th - 16 * U;
    const tip = by < py ? `M${(px - 6 * U).toFixed(1)} ${(by + th).toFixed(1)}L${px.toFixed(1)} ${(by + th + 8 * U).toFixed(1)}L${(px + 6 * U).toFixed(1)} ${(by + th).toFixed(1)}Z`
      : `M${(px - 6 * U).toFixed(1)} ${by.toFixed(1)}L${px.toFixed(1)} ${(by - 8 * U).toFixed(1)}L${(px + 6 * U).toFixed(1)} ${by.toFixed(1)}Z`;
    bx = Math.max(bx, 0);
    return `<g>
      <circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${7.5 * U}" fill="${color}" stroke="#0e0d12" stroke-width="${3 * U}"/>
      <path d="${tip}" fill="#f7f0e2" stroke="#0e0d12" stroke-width="${2.5 * U}" stroke-linejoin="round"/>
      <rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${tw.toFixed(1)}" height="${th.toFixed(1)}" rx="${th / 2}" fill="#f7f0e2" stroke="#0e0d12" stroke-width="${3 * U}"/>
      <text x="${(bx + tw / 2).toFixed(1)}" y="${(by + th / 2 + fs * 0.36).toFixed(1)}" fill="#302f30" font-size="${fs.toFixed(1)}" style="font-family:var(--es-font-display)" text-anchor="middle">${esc(text)}</text>
    </g>`;
  }

  _hover(e) {
    if (!this.chart || !this.chart.revealed || this.chart.empty) return;
    const m = this.match.momentum;
    if (!e) {
      this.chart.hoverI = -1;
      this.tip.style.opacity = '0';
      this._renderChart(1);
      return;
    }
    const g = this._geom();
    const r = this.plot.getBoundingClientRect();
    const px = e.clientX - r.left;
    const t = clamp((px - g.padL) / (g.w - g.padL - g.padR)) * this.match.duration;
    const i = Math.round((t / this.match.duration) * (m.t.length - 1));
    if (i === this.chart.hoverI) return;
    this.chart.hoverI = i;
    this._renderChart(1);
    const ti = m.t[i];
    const win = Math.max(6, this.match.duration / 60);
    const near = this.match.events.filter((ev) => Math.abs(ev.t - ti) <= win).slice(0, 3);
    const S = this.S;
    const lines = near.map((ev) => {
      const n = ev.other ? esc(ev.other.name) : '';
      if (ev.type === 'kill') return `<div class="es-k">● ${S.tipKill(n)}</div>`;
      if (ev.type === 'death') return `<div class="es-d">✕ ${S.tipDeath(n)}</div>`;
      return `<div>• ${S.tipAssist(n)}</div>`;
    }).join('') || `<div>${esc(S.tipNone)}</div>`;
    this.tip.innerHTML = `<b>${this.f.time(ti)}</b> · ${esc(S.momentum.toLowerCase())} ${this.f.signed1(m.v[i])}${lines}`;
    const tx = clamp(g.x(ti), 80 * this.unit, g.w - 80 * this.unit);
    this.tip.style.left = `${tx}px`;
    this.tip.style.top = `${Math.max(g.top, g.y(m.v[i]))}px`;
    this.tip.style.opacity = '1';
  }

  // ------------------------------------------------------------ vote

  _startTimer() {
    const d = this.host.opts.voteDuration;
    if (!d || this.voteDone) return;
    this.voteDuration = d;
    this.voteEndsAt = this.T.now + d;
    this.lastSec = null;
  }

  vote(mapId) {
    if (this.voteDone || !this.votes.has(mapId)) return;
    const meId = this.match.me.id;
    if (this.myVote === mapId) return;
    for (const v of this.votes.values()) v.ids.delete(meId);
    this.votes.get(mapId).ids.add(meId);
    this.myVote = mapId;
    this.host.sfx.play('vote');
    const card = this.mapCards.find((c) => c.map.id === mapId);
    if (card && !this.host.opts.reducedMotion) {
      this.T.animate(card.btn, [{ scale: '1' }, { scale: '1.06', offset: 0.35 }, { scale: '1' }], { duration: 360, easing: 'ease-out', fill: 'none' });
    }
    this._renderVotes();
    this.host.opts.onVote?.(mapId);
  }

  // votes : { mapId: [playerIds] } ou { mapId: nombre }
  setVotes(votes) {
    if (!votes || this.voteDone) return;
    const meId = this.match.me.id;
    for (const [id, v] of this.votes) {
      const src = votes[id];
      if (src == null) continue;
      if (Array.isArray(src)) { v.ids = new Set(src); v.extra = 0; } else { v.ids = new Set(); v.extra = Math.max(0, Number(src) || 0); }
    }
    const mine = [...this.votes].find(([, v]) => v.ids.has(meId));
    if (mine) this.myVote = mine[0];
    else if (this.myVote && this.votes.get(this.myVote).extra === 0) this.votes.get(this.myVote).ids.add(meId);
    this._renderVotes();
  }

  _renderVotes() {
    if (!this.mapCards) return;
    const counts = this.mapCards.map((c) => { const v = this.votes.get(c.map.id); return v.ids.size + v.extra; });
    const total = counts.reduce((a, b) => a + b, 0);
    const byId = new Map(this.match.players.map((p) => [p.id, p]));
    this.mapCards.forEach((c, i) => {
      const v = this.votes.get(c.map.id);
      const n = counts[i];
      if (c.count.textContent !== String(n)) {
        c.count.textContent = String(n);
        c.count.nextElementSibling.textContent = this.S.votes(n);
        if (this.entered && !this.host.opts.reducedMotion) this.T.animate(c.count.parentElement, [{ scale: '1' }, { scale: '1.3', offset: 0.4 }, { scale: '1' }], { duration: 320, fill: 'none' });
      }
      c.bar.style.width = `${total ? (n / total) * 100 : 0}%`;
      c.btn.classList.toggle('es-voted', this.myVote === c.map.id);
      c.btn.setAttribute('aria-pressed', String(this.myVote === c.map.id));
      const ids = [...v.ids].filter((id) => byId.has(id));
      const have = new Set([...c.voters.children].map((x) => x.dataset.id));
      const want = new Set(ids.slice(0, 7));
      for (const node of [...c.voters.children]) if (!want.has(node.dataset.id)) node.remove();
      for (const id of want) {
        if (have.has(id)) continue;
        const a = avatarEl(byId.get(id), 'happy');
        a.dataset.id = id;
        c.voters.appendChild(a);
        if (this.entered && !this.host.opts.reducedMotion) this.T.animate(a, [{ transform: 'scale(0) translateY(10px)' }, { transform: 'scale(1)' }], { duration: 380, easing: 'cubic-bezier(.2,1.6,.4,1)' });
      }
    });
  }

  endVote(winnerId) {
    if (this.voteDone || !this.mapCards?.length) return;
    this.voteDone = true;
    this.voteEndsAt = null;
    let win = winnerId;
    if (!win || !this.votes.has(win)) {
      let best = -1; let tied = [];
      for (const c of this.mapCards) {
        const v = this.votes.get(c.map.id);
        const n = v.ids.size + v.extra;
        if (n > best) { best = n; tied = [c.map.id]; } else if (n === best) tied.push(c.map.id);
      }
      win = tied[Math.floor(Math.random() * tied.length)];
    }
    this.winner = win;
    this.mapsGrid.classList.add('es-done');
    const card = this.mapCards.find((c) => c.map.id === win);
    for (const c of this.mapCards) {
      c.btn.disabled = true;
      c.btn.style.removeProperty('--rx'); c.btn.style.removeProperty('--ry');
      c.btn.classList.add(c === card ? 'es-winner' : 'es-loser');
    }
    if (card) {
      const rib = el('div', 'es-win-ribbon', `<div class="es-tab"><span>${esc(this.S.winner)}</span></div>`);
      card.wrap.appendChild(rib);
      if (!this.host.opts.reducedMotion) this.T.animate(rib, [{ transform: 'translateX(-50%) translateY(20px) scale(.4)', opacity: 0 }, { transform: 'translateX(-50%) scale(1)', opacity: 1 }], { duration: 480, easing: 'cubic-bezier(.2,1.6,.4,1)' });
      this.voteHint.innerHTML = this.S.chosen(esc(String(card.map.name).toUpperCase()));
    }
    this.timerTxt.innerHTML = ICONS.check;
    this.timerTxt.querySelector('svg').style.cssText = `width:${this.px(56)};height:${this.px(56)};color:#9de20a;filter:drop-shadow(0 ${this.px(3)} 0 #0e0d12)`;
    this.timerFg.setAttribute('stroke-dashoffset', '0');
    this.timerFg.setAttribute('stroke', '#9de20a');
    this.host.sfx.play('reveal');
    this.host.onVoteResolved(win);
  }

  // ------------------------------------------------------------ boucle

  frame(now) {
    if (this.voteEndsAt != null && !this.voteDone) {
      const left = Math.max(0, this.voteEndsAt - now);
      const k = left / this.voteDuration;
      this.timerFg.setAttribute('stroke-dashoffset', (314.16 * (1 - k)).toFixed(2));
      const sec = Math.ceil(left);
      if (sec !== this.lastSec) {
        this.lastSec = sec;
        this.timerTxt.textContent = String(sec);
        const hurry = sec <= 5;
        this.timerEl.classList.toggle('es-hurry', hurry);
        this.timerFg.setAttribute('stroke', hurry ? '#f5893a' : '#22e3f0');
        if (hurry && sec > 0) {
          this.host.sfx.play('countdown', { last: false });
          if (!this.host.opts.reducedMotion) this.T.animate(this.timerEl, [{ scale: '1' }, { scale: '1.12', offset: 0.3 }, { scale: '1' }], { duration: 300, fill: 'none' });
        }
      }
      if (left <= 0) {
        this.voteEndsAt = null;
        if (this.host.opts.autoEndVote !== false) this.endVote();
      }
    }
  }

  destroy() {
    window.removeEventListener('keydown', this._onKey);
    this.stageObserver?.disconnect();
    this.scroller?.remove();
    this.backplate?.remove();
    this.root.classList.remove('es-results-ready');
    if (this.previousFocus?.isConnected) this.previousFocus.focus?.({ preventScroll: true });
    this.previousFocus = null;
    this.skipBtn?.remove();
    this.stage = null;
    this.chart = null;
    this.highlightsEntered = false;
    this.entered = false;
    this.mapCards = [];
    this.rows = [];
  }
}
