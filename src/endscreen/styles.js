import { MODAL_CSS } from './modalStyles.js';

// Feuille de style injectée une seule fois. Toutes les tailles sont exprimées en "u" :
// 1u = 1px sur une maquette 1920x1080, mis à l'échelle selon la taille du conteneur.
// Couleurs et polices surchargeables via les variables --es-* sur .es-root.

const u = (n) => `calc(var(--u) * ${n})`;
const outline = (w, c = 'var(--es-ink)') =>
  [[0, w], [w, 0], [0, -w], [-w, 0], [w, w], [-w, w], [w, -w], [-w, -w]].map(([x, y]) => `${u(x)} ${u(y)} 0 ${c}`).join(',');

export const CSS = /* css */ `
.es-root{
  --es-ink:#0e0d12; --es-panel:#1b1b23; --es-panel-hi:#262735; --es-line:#2f3040; --es-row:#1b1b23;
  --es-cream:#f7f0e2; --es-cream-ink:#302f30; --es-muted:#a7a3b8; --es-faint:#6f6c80;
  --es-cyan:#22e3f0; --es-cyan-deep:#0aa6ba; --es-orange:#f5893a; --es-orange-deep:#c9561c;
  --es-yellow:#ffd60a; --es-green:#9de20a; --es-red:#ff5a6a; --es-pink:#ff6fa8;
  --es-wood:#76512f; --es-wood-dark:#4b3219; --es-wood-text:#facc15;
  --es-accent:var(--es-yellow);
  --es-font-display:'Lilita One','EndScreen Display','Arial Black',system-ui,sans-serif;
  --es-font-body:'Nunito','Segoe UI',system-ui,-apple-system,sans-serif;
  --u:1px;
  position:absolute; inset:0; overflow:hidden; z-index:1000;
  font-family:var(--es-font-body); color:var(--es-cream);
  -webkit-font-smoothing:antialiased; -moz-osx-font-smoothing:grayscale;
  user-select:none; -webkit-user-select:none; -webkit-tap-highlight-color:transparent;
  contain:layout paint;
}
.es-root.es-fixed{position:fixed}
.es-root[hidden]{display:none!important}
.es-root *,.es-root *::before,.es-root *::after{box-sizing:border-box}
.es-root.es-defeat{--es-accent:#ff7b86}
.es-canvas{position:absolute; inset:0; width:100%; height:100%; display:block}
.es-flash{position:absolute; inset:0; background:#fff; opacity:0; pointer-events:none; z-index:5; mix-blend-mode:screen}
.es-vignette{position:absolute; inset:0; pointer-events:none; z-index:1;
  background:radial-gradient(ellipse at 50% 45%, transparent 55%, rgba(6,5,12,.55) 100%)}
.es-scroller{position:absolute; inset:0; z-index:2; overflow:hidden}
.es-root[data-layout="tall"] .es-scroller{overflow-y:auto; overflow-x:hidden; -webkit-overflow-scrolling:touch}
.es-stage{position:absolute; left:50%; top:50%; width:${u(1920)}; height:${u(1080)};
  transform:translate(-50%,-50%); padding:${u(24)} ${u(40)} ${u(28)};
  display:grid; grid-template-columns:${u(840)} minmax(0,1fr); grid-template-rows:${u(214)} minmax(0,1fr) ${u(250)};
  grid-template-areas:"head head" "board me" "vote vote"; column-gap:${u(28)}; row-gap:${u(24)};
  perspective:${u(2200)}; pointer-events:none}
.es-stage > *{pointer-events:auto}
.es-sr{position:absolute!important; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap}
.es-pre{opacity:0; pointer-events:none}

/* ---------- en-tête ---------- */
.es-head{grid-area:head; position:relative; display:flex; flex-direction:column; align-items:center; justify-content:flex-end; gap:${u(14)}; pointer-events:none}
.es-title-slot{width:${u(1000)}; max-width:100%; height:${u(146)}; flex:none}
.es-pills{display:flex; align-items:center; justify-content:center; gap:${u(14)}; flex-wrap:wrap; pointer-events:auto}
.es-pill{display:inline-flex; align-items:center; gap:${u(10)}; height:${u(46)}; padding:0 ${u(20)}; border-radius:${u(99)};
  border:${u(4)} solid var(--es-ink); box-shadow:0 ${u(5)} 0 var(--es-ink); font:${u(24)}/1 var(--es-font-display); letter-spacing:.02em; white-space:nowrap}
.es-pill-place{background:var(--es-accent); color:var(--es-ink)}
.es-defeat .es-pill-place{background:#d6d2e2}
.es-pill-place b{font-size:${u(30)}; font-weight:400}
.es-pill-place sup{font-size:.55em; vertical-align:super; margin-left:${u(1)}}
.es-pill-place span{font:900 ${u(16)}/1 var(--es-font-body); letter-spacing:.06em; opacity:.7}
.es-pill-wood{background:linear-gradient(var(--es-wood),var(--es-wood-dark)); color:var(--es-wood-text);
  box-shadow:0 ${u(5)} 0 var(--es-ink), inset 0 ${u(2)} 0 rgba(255,255,255,.18)}
.es-pill-wood i{width:${u(10)}; height:${u(10)}; border-radius:50%; background:var(--es-green); border:${u(2)} solid var(--es-ink); display:inline-block}
.es-pill-wood .es-clock{font:900 ${u(18)}/1 var(--es-font-body); color:var(--es-cream); opacity:.9}
.es-pill-score{background:var(--es-ink); color:var(--es-cream); box-shadow:0 ${u(5)} 0 #000, inset 0 0 0 ${u(2)} #3a3b4a}
.es-pill-score span{font:900 ${u(16)}/1 var(--es-font-body); letter-spacing:.1em; color:var(--es-muted)}
.es-quit{position:absolute; top:${u(4)}; right:0; display:inline-flex; align-items:center; gap:${u(10)}; height:${u(44)}; padding:0 ${u(10)} 0 ${u(18)};
  border-radius:${u(99)}; border:${u(4)} solid var(--es-ink); background:var(--es-panel); color:var(--es-cream); cursor:pointer;
  font:${u(20)}/1 var(--es-font-display); box-shadow:0 ${u(5)} 0 var(--es-ink); pointer-events:auto; transition:transform .15s, background .15s}
.es-quit:hover{background:var(--es-panel-hi); transform:translateY(${u(-2)})}
.es-kbd,.es-root kbd{display:inline-grid; place-items:center; min-width:${u(28)}; height:${u(28)}; padding:0 ${u(7)}; border-radius:${u(8)};
  background:var(--es-cream); color:var(--es-ink); border:${u(3)} solid var(--es-ink); box-shadow:0 ${u(3)} 0 var(--es-ink);
  font:900 ${u(14)}/1 var(--es-font-body); letter-spacing:.02em}
.es-root button:focus-visible{outline:${u(4)} solid var(--es-cyan); outline-offset:${u(4)}}

/* ---------- panneaux ---------- */
.es-panel{position:relative; background:linear-gradient(180deg,var(--es-panel-hi),var(--es-panel)); border:${u(4)} solid var(--es-ink);
  border-radius:${u(24)}; box-shadow:0 ${u(6)} 0 var(--es-ink), inset 0 ${u(2)} 0 rgba(255,255,255,.07)}
.es-tab{position:absolute; top:${u(-23)}; left:${u(22)}; z-index:2; display:inline-flex; align-items:center; gap:${u(10)}; height:${u(42)}; padding:0 ${u(20)};
  border-radius:${u(99)}; background:var(--es-cream); color:var(--es-cream-ink); border:${u(4)} solid var(--es-ink); box-shadow:0 ${u(4)} 0 var(--es-ink);
  font:${u(23)}/1 var(--es-font-display); letter-spacing:.03em; white-space:nowrap}
.es-tab-dot{width:${u(16)}; height:${u(16)}; border-radius:50%; background:var(--es-yellow); border:${u(3)} solid var(--es-ink)}
.es-tab.es-red{background:#ff8a92} .es-tab.es-green{background:#c6f36b}
.es-wrap{position:relative; min-width:0; min-height:0; transform-style:preserve-3d}

/* ---------- classement ---------- */
.es-board-wrap{grid-area:board}
.es-board{height:100%; padding:${u(36)} ${u(18)} ${u(12)}; display:flex; flex-direction:column; gap:0}
.es-cols{--cols:${u(46)} ${u(50)} minmax(0,1fr) ${u(62)} ${u(62)} ${u(80)} ${u(132)} ${u(100)}}
.es-board-head{display:grid; grid-template-columns:var(--cols); align-items:center; padding:0 ${u(11)} 0 ${u(9)}; height:${u(26)};
  font:900 ${u(15)}/1 var(--es-font-body); letter-spacing:.1em; color:var(--es-muted)}
.es-board-head span{text-align:center} .es-board-head .es-h-name{text-align:left; grid-column:2 / span 2; padding-left:${u(2)}} .es-board-head .es-h-score{text-align:right; padding-right:${u(10)}}
.es-rows{list-style:none; margin:0 ${u(-8)}; padding:${u(14)} ${u(8)} ${u(8)}; display:flex; flex-direction:column; gap:${u(6)}; overflow-y:auto; overflow-x:hidden; min-height:0; flex:1; perspective:${u(1400)}}
.es-row{position:relative; display:grid; grid-template-columns:var(--cols); align-items:center; flex:1 1 0; min-height:${u(38)}; max-height:${u(50)}; padding:0 ${u(8)} 0 ${u(6)};
  border-radius:${u(26)}; background:var(--es-row); border:${u(3)} solid var(--es-ink);
  box-shadow:inset 0 0 0 ${u(2)} #2c2d3b, 0 ${u(4)} 0 var(--es-ink); font:${u(23)}/1 var(--es-font-display); color:var(--es-cream);
  transform-origin:50% 0; backface-visibility:hidden}
.es-row.es-me{background:var(--es-cyan); color:var(--es-ink); box-shadow:inset 0 ${u(3)} 0 rgba(255,255,255,.55), inset 0 ${u(-3)} 0 rgba(0,0,0,.12), 0 ${u(4)} 0 var(--es-ink); z-index:1}
.es-row.es-me::after{content:''; position:absolute; inset:0; border-radius:inherit; pointer-events:none;
  background:linear-gradient(100deg,transparent 30%,rgba(255,255,255,.75) 46%,transparent 62%); background-size:250% 100%; background-position:150% 0; opacity:0}
.es-row.es-me.es-shine::after{animation:es-shine 1.1s ease-out 1}
@keyframes es-shine{0%{opacity:1; background-position:150% 0} 100%{opacity:1; background-position:-60% 0}}
.es-rank{width:${u(36)}; height:${u(36)}; border-radius:50%; display:grid; place-items:center; background:#dcdce2; color:var(--es-ink);
  border:${u(3)} solid var(--es-ink); font:${u(20)}/1 var(--es-font-display); position:relative}
.es-row[data-rank="1"] .es-rank{background:var(--es-yellow)}
.es-row[data-rank="2"] .es-rank{background:#cfd8e6}
.es-row[data-rank="3"] .es-rank{background:#f2a865}
.es-crown{position:absolute; left:50%; top:${u(-19)}; width:${u(26)}; height:${u(20)}; transform:translateX(-50%); color:var(--es-yellow); filter:drop-shadow(0 ${u(2)} 0 var(--es-ink))}
.es-avatar{display:block; width:${u(42)}; height:${u(42)}; flex:none}
.es-avatar svg,.es-avatar img{display:block; width:100%; height:100%; object-fit:contain}
.es-name{display:flex; align-items:center; gap:${u(8)}; min-width:0; padding-left:${u(6)}}
.es-name-txt{overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; line-height:1.3}
.es-you{flex:none; font:900 ${u(12)}/1 var(--es-font-body); letter-spacing:.08em; padding:${u(4)} ${u(7)}; border-radius:${u(99)}; background:var(--es-ink); color:var(--es-cyan)}
.es-badges{display:inline-flex; gap:${u(3)}; flex:none}
.es-badge{width:${u(24)}; height:${u(24)}; border-radius:50%; display:grid; place-items:center; border:${u(3)} solid var(--es-ink); background:var(--b,#fff); color:var(--es-ink)}
.es-badge svg{width:${u(13)}; height:${u(13)}}
.es-num{text-align:center; font-variant-numeric:tabular-nums}
.es-num.es-dim{color:var(--es-faint)} .es-me .es-num.es-dim{color:rgba(14,13,18,.45)}
.es-acc{display:flex; align-items:center; gap:${u(8)}; padding:0 ${u(6)}}
.es-acc b{font-weight:400; min-width:${u(48)}; text-align:right; font-size:${u(20)}; font-variant-numeric:tabular-nums}
.es-bar{flex:1; height:${u(12)}; border-radius:${u(8)}; background:#2e2f3e; border:${u(2)} solid var(--es-ink); overflow:hidden}
.es-bar i{display:block; height:100%; width:0; border-radius:inherit; background:var(--es-cyan)}
.es-me .es-bar{background:rgba(14,13,18,.25)} .es-me .es-bar i{background:var(--es-ink)}
.es-score{justify-self:end; min-width:${u(92)}; height:${u(36)}; display:grid; place-items:center; padding:0 ${u(12)}; border-radius:${u(99)};
  background:var(--es-ink); color:#fff; box-shadow:inset 0 0 0 ${u(2)} #3b3c4c; font-variant-numeric:tabular-nums}
.es-me .es-score{box-shadow:none}

/* ---------- mes stats ---------- */
.es-me-col{grid-area:me; display:grid; grid-template-rows:${u(150)} minmax(0,1fr); row-gap:${u(26)}; min-width:0; min-height:0}
.es-tiles{display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:${u(16)}; perspective:${u(1200)}}
.es-tile{height:100%; display:grid; grid-template-columns:${u(42)} minmax(0,1fr); grid-template-rows:${u(42)} auto auto; align-content:center;
  column-gap:${u(10)}; row-gap:${u(4)}; padding:${u(12)} ${u(16)}}
.es-tile-icon{width:${u(42)}; height:${u(42)}; border-radius:50%; display:grid; place-items:center; background:var(--c,var(--es-cyan));
  border:${u(3)} solid var(--es-ink); box-shadow:0 ${u(3)} 0 var(--es-ink); color:var(--es-ink)}
.es-tile-icon svg{width:${u(22)}; height:${u(22)}}
.es-tile-icon.es-ring{background:var(--es-panel); padding:0; position:relative; border-width:${u(3)}}
.es-tile-icon.es-ring svg{width:100%; height:100%; transform:rotate(-90deg)}
.es-tile-label{align-self:center; font:900 ${u(15)}/1.4 var(--es-font-body); letter-spacing:.09em; text-transform:uppercase; color:var(--es-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
.es-tile-value{grid-column:1 / -1; font:${u(48)}/1 var(--es-font-display); color:#fff; text-shadow:0 ${u(4)} 0 var(--es-ink); white-space:nowrap}
.es-tile-value small{font-size:.55em; margin-left:${u(4)}; color:var(--es-muted)}
.es-tile-sub{grid-column:1 / -1; font:800 ${u(15)}/1.35 var(--es-font-body); color:var(--es-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
.es-lower{display:grid; grid-template-columns:minmax(0,1fr) ${u(392)}; column-gap:${u(20)}; min-height:0}

/* ---------- momentum ---------- */
.es-chart-wrap{min-height:0}
.es-chart{height:100%; display:flex; flex-direction:column; padding:${u(32)} ${u(18)} ${u(12)}}
.es-legend{position:absolute; top:${u(14)}; right:${u(18)}; display:flex; gap:${u(16)}; font:800 ${u(15)}/1 var(--es-font-body); color:var(--es-muted)}
.es-legend span{display:inline-flex; align-items:center; gap:${u(7)}}
.es-legend i{width:${u(14)}; height:${u(14)}; border-radius:${u(4)}; border:${u(2)} solid var(--es-ink); background:var(--es-cyan)}
.es-legend .es-neg i{background:var(--es-orange)}
.es-plot{position:relative; flex:1; min-height:0; cursor:crosshair}
.es-plot svg{position:absolute; inset:0; width:100%; height:100%; overflow:visible; display:block}
.es-tip{position:absolute; z-index:3; pointer-events:none; transform:translate(-50%, calc(-100% - var(--u) * 14)); background:var(--es-ink); color:var(--es-cream);
  border-radius:${u(12)}; padding:${u(9)} ${u(12)}; font:800 ${u(15)}/1.35 var(--es-font-body); white-space:nowrap; box-shadow:0 ${u(4)} 0 #000; opacity:0; transition:opacity .12s}
.es-tip b{font:${u(18)}/1 var(--es-font-display); font-weight:400}
.es-tip .es-k{color:var(--es-cyan)} .es-tip .es-d{color:var(--es-orange)}
.es-ann{font:${u(15)}/1 var(--es-font-display)}

/* ---------- duels ---------- */
.es-duels{display:grid; grid-template-rows:minmax(0,1fr) minmax(0,1fr); row-gap:${u(26)}; min-height:0; perspective:${u(1200)}}
.es-flip{position:relative; transform-style:preserve-3d; min-height:0; height:100%}
.es-flip > .es-panel{height:100%; backface-visibility:hidden; -webkit-backface-visibility:hidden}
.es-flip-back{position:absolute; inset:0; transform:rotateY(180deg); backface-visibility:hidden; -webkit-backface-visibility:hidden; border-radius:${u(24)};
  border:${u(4)} solid var(--es-ink); box-shadow:0 ${u(6)} 0 var(--es-ink); display:grid; place-items:center;
  background:repeating-linear-gradient(45deg,#2b2c3c 0 ${u(14)},#23242f ${u(14)} ${u(28)}); font:${u(80)}/1 var(--es-font-display); color:var(--es-faint)}
.es-duel{display:flex; align-items:center; gap:${u(16)}; padding:${u(28)} ${u(18)} ${u(10)}}
.es-duel .es-avatar{width:${u(104)}; height:${u(104)}; filter:drop-shadow(0 ${u(5)} 0 rgba(0,0,0,.35))}
.es-prey .es-avatar{width:${u(78)}; height:${u(78)}}
.es-duel-info{flex:1; min-width:0; display:flex; flex-direction:column; gap:${u(4)}}
.es-duel-name{font:${u(32)}/1.15 var(--es-font-display); color:#fff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; text-shadow:0 ${u(3)} 0 var(--es-ink)}
.es-prey .es-duel-name{font-size:${u(26)}}
.es-duel-desc{font:800 ${u(16)}/1.2 var(--es-font-body); color:var(--es-muted)}
.es-duel-desc b{font:${u(20)}/1 var(--es-font-display); font-weight:400; color:var(--es-cream)}
.es-vs{display:grid; grid-template-columns:auto minmax(0,1fr) auto; align-items:center; gap:${u(8)}; margin-top:${u(2)}}
.es-vs > b{font:${u(24)}/1 var(--es-font-display); font-weight:400; min-width:${u(22)}; text-align:center}
.es-vs .es-vs-me{color:var(--es-cyan)} .es-vs .es-vs-them{color:#ff8a92}
.es-prey .es-vs .es-vs-them{color:var(--es-muted)}
.es-vs-bar{position:relative; height:${u(16)}; border-radius:${u(10)}; border:${u(3)} solid var(--es-ink); background:#ff8a92; overflow:hidden}
.es-prey .es-vs-bar{background:#555468}
.es-vs-bar i{position:absolute; left:0; top:0; bottom:0; width:50%; background:var(--es-cyan); border-right:${u(3)} solid var(--es-ink)}
.es-vs-labels span{min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; line-height:1.35}
.es-vs-labels{display:flex; justify-content:space-between; gap:${u(8)}; font:900 ${u(13)}/1 var(--es-font-body); letter-spacing:.12em; color:var(--es-faint)}
.es-stamp{position:absolute; left:${u(8)}; bottom:${u(18)}; padding:${u(4)} ${u(10)}; background:rgba(14,13,18,.55); border:${u(4)} solid #ff5a6a; border-radius:${u(10)}; color:#ff5a6a;
  font:${u(19)}/1 var(--es-font-display); letter-spacing:.06em; transform:rotate(-11deg); opacity:0; z-index:2}
.es-duel-empty{font:800 ${u(16)}/1.3 var(--es-font-body); color:var(--es-muted)}
.es-chart-empty{position:absolute; inset:0; display:grid; place-content:center; text-align:center; gap:${u(6)}}
.es-duel-empty b{display:block; font:${u(26)}/1.1 var(--es-font-display); font-weight:400; color:var(--es-cream)}

/* ---------- vote ---------- */
.es-vote{grid-area:vote; display:grid; grid-template-columns:${u(236)} minmax(0,1fr); column-gap:${u(22)}; min-height:0; padding-top:${u(4)}}
.es-vote-head{display:flex; flex-direction:column; align-items:center; justify-content:center; gap:${u(12)}; padding:${u(30)} ${u(14)} ${u(16)}; text-align:center}
.es-vote-head .es-tab{left:50%; transform:translateX(-50%)}
.es-timer{position:relative; width:${u(118)}; height:${u(118)}}
.es-timer > svg{width:100%; height:100%; transform:rotate(-90deg); overflow:visible}
.es-timer b{position:absolute; inset:0; display:grid; place-items:center; font:${u(48)}/1 var(--es-font-display); font-weight:400; color:#fff; text-shadow:0 ${u(4)} 0 var(--es-ink)}
.es-timer.es-hurry b{color:var(--es-orange)}
.es-vote-hint{margin:0; font:800 ${u(15)}/1.35 var(--es-font-body); color:var(--es-muted)}
.es-vote-hint kbd{min-width:${u(22)}; height:${u(22)}; font-size:${u(12)}; padding:0 ${u(5)}}
.es-maps{display:grid; grid-template-columns:repeat(var(--es-map-cols,4),minmax(0,1fr)); gap:${u(20)}; perspective:${u(1600)}; min-height:0}
.es-map-wrap{position:relative; min-width:0; min-height:0; transform-style:preserve-3d}
.es-map{position:relative; display:block; width:100%; height:100%; padding:0; margin:0; cursor:pointer; text-align:left; color:inherit; font:inherit;
  border-radius:${u(24)}; border:${u(4)} solid var(--es-ink); background:var(--es-panel); overflow:hidden; box-shadow:0 ${u(6)} 0 var(--es-ink);
  transform:perspective(${u(900)}) rotateX(var(--rx,0deg)) rotateY(var(--ry,0deg)) translateY(var(--ty,0px)) scale(var(--sc,1));
  transition:transform .18s ease-out, box-shadow .18s, filter .4s, opacity .4s}
.es-map:hover{--ty:${u(-6)}; box-shadow:0 ${u(12)} 0 var(--es-ink)}
.es-map-art{position:absolute; inset:0; background-size:cover; background-position:center; transform:scale(1.04); transition:transform .4s}
.es-map:hover .es-map-art{transform:scale(1.1)}
.es-map::before{content:''; position:absolute; inset:0; z-index:1; background:linear-gradient(180deg,rgba(14,13,18,0) 38%,rgba(14,13,18,.88) 100%)}
.es-map::after{content:''; position:absolute; inset:0; z-index:4; pointer-events:none; border-radius:${u(20)}; box-shadow:inset 0 0 0 ${u(5)} transparent; transition:box-shadow .2s}
.es-map.es-voted::after{box-shadow:inset 0 0 0 ${u(6)} var(--es-cyan)}
.es-map-glare{position:absolute; inset:0; z-index:3; pointer-events:none; opacity:0; transition:opacity .2s;
  background:radial-gradient(circle at var(--gx,50%) var(--gy,30%), rgba(255,255,255,.35), transparent 45%)}
.es-map:hover .es-map-glare{opacity:1}
.es-map-key{position:absolute; top:${u(12)}; left:${u(12)}; z-index:2}
.es-map-count{position:absolute; top:${u(12)}; right:${u(12)}; z-index:2; display:inline-flex; align-items:center; gap:${u(6)}; height:${u(34)}; padding:0 ${u(12)};
  border-radius:${u(99)}; background:var(--es-ink); color:#fff; font:${u(20)}/1 var(--es-font-display); box-shadow:inset 0 0 0 ${u(2)} #3b3c4c}
.es-map-count small{font:900 ${u(13)}/1 var(--es-font-body); letter-spacing:.08em; color:var(--es-muted)}
.es-map-foot{position:absolute; left:${u(16)}; right:${u(16)}; bottom:${u(22)}; z-index:2; display:flex; flex-direction:column; gap:${u(4)}}
.es-map-name{font:${u(34)}/1 var(--es-font-display); color:#fff; letter-spacing:.02em; text-shadow:${outline(2.5)}, 0 ${u(5)} 0 var(--es-ink)}
.es-map-sub{font:800 ${u(15)}/1.35 var(--es-font-body); color:rgba(247,240,226,.85); white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
.es-voters{display:flex; gap:${u(2)}; height:${u(26)}; margin-top:${u(4)}}
.es-voters .es-avatar{width:${u(26)}; height:${u(26)}}
.es-map-bar{position:absolute; left:0; right:0; bottom:0; height:${u(10)}; z-index:2; background:rgba(14,13,18,.7)}
.es-map-bar i{display:block; height:100%; width:0; background:var(--es-cyan); transition:width .45s cubic-bezier(.2,1.2,.4,1)}
.es-map-badge{position:absolute; z-index:3; top:${u(54)}; right:${u(-36)}; transform:rotate(35deg); width:${u(160)}; padding:${u(5)} 0; text-align:center;
  background:var(--es-cyan); color:var(--es-ink); border-block:${u(3)} solid var(--es-ink); font:900 ${u(13)}/1 var(--es-font-body); letter-spacing:.1em; opacity:0; transition:opacity .2s}
.es-map.es-voted .es-map-badge{opacity:1}
.es-maps.es-done .es-map{cursor:default}
.es-map.es-loser{opacity:.32; filter:grayscale(.9); --sc:.94}
.es-map.es-winner{--sc:1.05; box-shadow:0 ${u(8)} 0 var(--es-ink), 0 0 0 ${u(6)} var(--es-yellow), 0 0 ${u(50)} rgba(255,214,10,.55)}
.es-win-ribbon{position:absolute; z-index:5; left:50%; top:${u(-26)}; transform:translateX(-50%); white-space:nowrap; pointer-events:none}
.es-win-ribbon .es-tab{position:static; background:var(--es-yellow); color:var(--es-ink)}

/* ---------- passer l'intro ---------- */
.es-skip{position:absolute; z-index:6; left:50%; bottom:${u(28)}; transform:translateX(-50%); display:inline-flex; align-items:center; gap:${u(10)}; height:${u(40)};
  padding:0 ${u(10)} 0 ${u(18)}; border-radius:${u(99)}; background:rgba(14,13,18,.72); color:var(--es-cream); border:${u(3)} solid var(--es-ink);
  font:${u(18)}/1 var(--es-font-display); cursor:pointer; transition:opacity .3s}
.es-skip[hidden]{display:none}

/* ---------- disposition étroite / portrait ---------- */
.es-root[data-layout="tall"] .es-stage{position:relative; left:auto; top:auto; transform:none; width:100%; height:auto; min-height:100%;
  display:flex; flex-direction:column; gap:${u(34)};
  padding:calc(${u(20)} + env(safe-area-inset-top, 0px)) max(16px, ${u(22)}) calc(${u(40)} + env(safe-area-inset-bottom, 0px))}
.es-root[data-layout="tall"] .es-head{padding-top:${u(56)}}
.es-root[data-layout="tall"] .es-title-slot{width:100%; height:${u(118)}}
.es-root[data-layout="tall"] .es-quit{top:0}
.es-root[data-layout="tall"] .es-me-col{display:flex; flex-direction:column; gap:${u(34)}}
.es-root[data-layout="tall"] .es-tiles{grid-template-columns:repeat(2,minmax(0,1fr)); gap:${u(16)}}
.es-root[data-layout="tall"] .es-tile{height:${u(150)}}
.es-root[data-layout="tall"] .es-lower{display:flex; flex-direction:column; gap:${u(34)}}
.es-root[data-layout="tall"] .es-chart-wrap{height:${u(380)}}
.es-root[data-layout="tall"] .es-duels{display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); grid-template-rows:none; gap:${u(16)}; height:${u(250)}}
.es-root[data-layout="tall"] .es-duel{flex-direction:column; align-items:flex-start; justify-content:center}
.es-root[data-layout="tall"] .es-duel .es-avatar{width:${u(72)}; height:${u(72)}}
.es-root[data-layout="tall"] .es-stamp{bottom:auto; top:${u(78)}}
.es-root[data-layout="tall"] .es-board-wrap{order:3}
.es-root[data-layout="tall"] .es-board{height:auto}
.es-root[data-layout="tall"] .es-rows{overflow:visible}
.es-root[data-layout="tall"] .es-cols{--cols:${u(42)} ${u(46)} minmax(0,1fr) ${u(54)} ${u(54)} ${u(72)} ${u(112)} ${u(92)}}
.es-root[data-layout="tall"] .es-vote{order:4; display:flex; flex-direction:column; gap:${u(34)}}
.es-root[data-layout="tall"] .es-vote-head{flex-direction:row; justify-content:space-between; padding:${u(32)} ${u(18)} ${u(16)}; text-align:left}
.es-root[data-layout="tall"] .es-vote-head .es-tab{left:${u(22)}; transform:none}
.es-root[data-layout="tall"] .es-timer{width:${u(90)}; height:${u(90)}; flex:none}
.es-root[data-layout="tall"] .es-maps{grid-template-columns:repeat(min(2,var(--es-map-cols,4)),minmax(0,1fr)); gap:${u(16)}}
.es-root[data-layout="tall"] .es-map-wrap{height:${u(230)}}
.es-root[data-layout="tall"] .es-skip{position:fixed}

/* très étroit (téléphone) : colonnes secondaires masquées */
.es-root[data-narrow] .es-cols{--cols:${u(40)} ${u(44)} minmax(0,1fr) ${u(54)} ${u(66)} ${u(88)}}
.es-root[data-narrow] .es-row > :nth-child(5), .es-root[data-narrow] .es-row > :nth-child(7),
.es-root[data-narrow] .es-board-head > :nth-child(4), .es-root[data-narrow] .es-board-head > :nth-child(6){display:none}
.es-root[data-layout="tall"] .es-badges, .es-root[data-narrow] .es-you{display:none}

@media (prefers-reduced-motion: reduce){
  .es-map,.es-map-art,.es-map-bar i{transition:none}
  .es-row.es-me.es-shine::after{animation:none}
}
`;

let injected = false;
export function injectStyles(fontUrls) {
  if (injected) return;
  injected = true;
  const style = document.createElement('style');
  style.dataset.endscreen = '';
  let fonts = '';
  if (fontUrls?.display) fonts += `@font-face{font-family:'Lilita One';src:url('${fontUrls.display}');font-display:swap}\n`;
  if (fontUrls?.body) fonts += `@font-face{font-family:'Nunito';src:url('${fontUrls.body}');font-weight:600 1000;font-display:swap}\n`;
  style.textContent = fonts + CSS + MODAL_CSS;
  document.head.appendChild(style);
}
