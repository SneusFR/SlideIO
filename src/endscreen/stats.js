// Calculs dérivés de fin de partie : classement, KDR, précision, rival, proie,
// meilleure série, momentum et distinctions. Fonctions pures, sans DOM.

const DEFAULT_COLORS = ['#F27A3A', '#9B6BDF', '#8BD346', '#FFD23F', '#E8485C', '#FF8FB8', '#B07A4A', '#5B8DEF'];

export function computeMatch(data) {
  if (!data || !Array.isArray(data.players) || data.players.length === 0) {
    throw new Error('EndScreen: data.players est requis (au moins un joueur).');
  }
  const meId = data.localPlayerId ?? data.players[0].id;
  const feed = (Array.isArray(data.killFeed) ? data.killFeed : [])
    .filter((e) => e && typeof e.t === 'number')
    .slice()
    .sort((a, b) => a.t - b.t);

  const hasFeed = feed.length > 0;
  const duration = Math.max(1, data.duration ?? (hasFeed ? feed[feed.length - 1].t + 5 : 60));

  const players = data.players.map((p, i) => {
    const kills = num(p.kills);
    const deaths = num(p.deaths);
    const assists = num(p.assists);
    const shotsFired = p.shotsFired == null ? null : num(p.shotsFired);
    const shotsHit = p.shotsHit == null ? null : num(p.shotsHit);
    return {
      ...p,
      name: String(p.name ?? `Joueur ${i + 1}`),
      color: p.color ?? DEFAULT_COLORS[i % DEFAULT_COLORS.length],
      kills,
      deaths,
      assists,
      score: p.score == null ? kills : num(p.score),
      damage: p.damage == null ? null : num(p.damage),
      shotsFired,
      shotsHit,
      kdr: kills / Math.max(1, deaths),
      accuracy: shotsFired ? clamp01((shotsHit ?? 0) / shotsFired) : null,
      bestStreak: p.bestStreak != null ? num(p.bestStreak) : (hasFeed ? streakFromFeed(feed, p.id) : null),
      isMe: p.id === meId,
    };
  });

  // `rank` (optional, 1 = first) lets the game impose its OWN ranking rules
  // (leaderboard comparator) so both screens always agree.
  const ranked = players.every((p) => typeof p.rank === 'number');
  players.sort((a, b) => (ranked ? a.rank - b.rank : 0) ||
    b.score - a.score || b.kills - a.kills || a.deaths - b.deaths || a.name.localeCompare(b.name));
  players.forEach((p, i) => { p.placement = i + 1; });

  const byId = new Map(players.map((p) => [p.id, p]));
  const me = byId.get(meId) ?? players[0];
  me.isMe = true;

  const outcome = data.outcome === 'victory' || data.outcome === 'defeat'
    ? data.outcome
    : (me.placement === 1 ? 'victory' : 'defeat');

  // Duels : qui m'a tué / qui j'ai tué
  const killedMe = new Map();
  const iKilled = new Map();
  for (const e of feed) {
    if (e.victim === me.id && e.killer != null && e.killer !== me.id) inc(killedMe, e.killer);
    if (e.killer === me.id && e.victim != null && e.victim !== me.id) inc(iKilled, e.victim);
  }
  const pickTop = (map, last) => {
    let best = null;
    for (const [id, n] of map) {
      if (!byId.has(id)) continue;
      if (!best || n > best.n || (n === best.n && (last.get(id) ?? 0) > (last.get(best.id) ?? 0))) best = { id, n };
    }
    return best;
  };
  const lastSeen = new Map();
  feed.forEach((e, i) => { lastSeen.set(e.killer, i); lastSeen.set(e.victim, i); });

  let rival = null;
  if (data.rival && byId.has(data.rival.id)) {
    rival = { player: byId.get(data.rival.id), theirKills: num(data.rival.killsOnYou), myKills: num(data.rival.yourKills) };
  } else {
    const top = pickTop(killedMe, lastSeen);
    if (top) rival = { player: byId.get(top.id), theirKills: top.n, myKills: iKilled.get(top.id) ?? 0 };
  }

  let prey = null;
  if (data.prey && byId.has(data.prey.id)) {
    prey = { player: byId.get(data.prey.id), myKills: num(data.prey.yourKills), theirKills: num(data.prey.killsOnYou) };
  } else {
    // la proie est une autre personne que le rival quand c'est possible
    const pool = new Map(iKilled);
    if (rival && pool.size > 1) pool.delete(rival.player.id);
    const top = pickTop(pool, lastSeen);
    if (top) prey = { player: byId.get(top.id), myKills: top.n, theirKills: killedMe.get(top.id) ?? 0 };
  }

  const events = [];
  for (const e of feed) {
    if (e.killer === me.id && e.victim !== me.id) events.push({ t: e.t, type: 'kill', other: byId.get(e.victim) ?? null });
    else if (e.victim === me.id) events.push({ t: e.t, type: 'death', other: e.killer === me.id ? null : (byId.get(e.killer) ?? null) });
    else if (Array.isArray(e.assisters) && e.assisters.includes(me.id)) events.push({ t: e.t, type: 'assist', other: byId.get(e.victim) ?? null });
  }

  const momentum = Array.isArray(data.momentum) && data.momentum.length > 1
    ? momentumFromSeries(data.momentum, duration)
    : momentumFromEvents(events, duration);
  momentum.empty = !hasFeed && !(Array.isArray(data.momentum) && data.momentum.length > 1);
  // sans journal des éliminations, on ne sait pas qui a tué qui : état "inconnu" plutôt qu'un faux "personne"
  if (!rival && !hasFeed && me.deaths > 0) rival = { unknown: true };
  if (!prey && !hasFeed && me.kills > 0) prey = { unknown: true };
  momentum.streakAtPeak = streakAround(events, momentum.peak.t);

  return {
    raw: data,
    mode: data.mode ?? 'FFA',
    mapName: data.mapName ?? data.map ?? '',
    duration,
    outcome,
    players,
    me,
    total: players.length,
    rival,
    prey,
    events,
    momentum,
    accolades: computeAccolades(players),
  };
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function inc(map, key) { map.set(key, (map.get(key) ?? 0) + 1); }

function streakFromFeed(feed, id) {
  let cur = 0;
  let best = 0;
  for (const e of feed) {
    if (e.killer === id && e.victim !== id) { cur += 1; best = Math.max(best, cur); }
    if (e.victim === id) cur = 0;
  }
  return best;
}

// Momentum : chaque élimination pousse la courbe vers le haut, chaque mort vers le bas,
// et l'effet s'estompe avec le temps (décroissance exponentielle).
export function momentumFromEvents(events, duration, samples = 180) {
  const tau = Math.min(60, Math.max(18, duration / 12));
  const t = [];
  const v = [];
  for (let i = 0; i < samples; i++) {
    const ti = (i / (samples - 1)) * duration;
    let m = 0;
    for (const e of events) {
      if (e.t > ti) break;
      const w = e.type === 'kill' ? 1 : e.type === 'death' ? -1 : 0.4;
      m += w * Math.exp(-(ti - e.t) / tau);
    }
    t.push(ti);
    v.push(m);
  }
  return finishMomentum(t, v);
}

function momentumFromSeries(series, duration) {
  const t = series.map((_, i) => (i / (series.length - 1)) * duration);
  return finishMomentum(t, series.map(num));
}

function finishMomentum(t, v) {
  let peak = { i: 0, t: t[0], v: v[0] };
  let trough = { i: 0, t: t[0], v: v[0] };
  v.forEach((val, i) => {
    if (val > peak.v) peak = { i, t: t[i], v: val };
    if (val < trough.v) trough = { i, t: t[i], v: val };
  });
  const range = Math.max(1.5, Math.abs(peak.v), Math.abs(trough.v)) * 1.18;
  return { t, v, peak, trough, range };
}

function streakAround(events, tPeak) {
  let cur = 0;
  let atPeak = 0;
  for (const e of events) {
    if (e.t > tPeak + 0.01) break;
    if (e.type === 'kill') cur += 1;
    else if (e.type === 'death') cur = 0;
    atPeak = cur;
  }
  return atPeak;
}

function computeAccolades(players) {
  const out = new Map(players.map((p) => [p.id, []]));
  const award = (key, pick, valid) => {
    const pool = players.filter(valid);
    if (!pool.length) return;
    const best = pool.reduce((a, b) => (pick(b) > pick(a) ? b : a));
    // pas de distinction en cas d'égalité parfaite en tête
    if (pool.filter((p) => pick(p) === pick(best)).length > 1) return;
    out.get(best.id).push(key);
  };
  award('sniper', (p) => p.accuracy, (p) => p.accuracy != null && (p.shotsFired ?? 0) >= 10);
  award('streak', (p) => p.bestStreak, (p) => p.bestStreak != null && p.bestStreak >= 3);
  award('damage', (p) => p.damage, (p) => p.damage != null && p.damage > 0);
  award('survivor', (p) => -p.deaths, (p) => p.kills > 0);
  return out;
}

// Formatage : virgule décimale et espace insécable en fr-FR.
export function makeFormatters(locale = 'fr-FR') {
  const fix = (s) => s.replace(/ /g, ' ');
  const int = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const dec2 = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const dec1 = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return {
    int: (n) => fix(int.format(Math.round(n))),
    dec2: (n) => fix(dec2.format(n)),
    dec1: (n) => fix(dec1.format(n)),
    signed1: (n) => (n > 0.05 ? '+' : n < -0.05 ? '−' : '') + fix(dec1.format(Math.abs(n))),
    time: (s) => {
      const t = Math.max(0, Math.round(s));
      return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
    },
  };
}
