// Surcouche de présentation : la chorégraphie, les sons et les données restent
// dans leurs modules d'origine. 1720 × 932 est la taille de référence du panneau.
const u = (n) => `calc(var(--u) * ${n})`;

export const MODAL_CSS = /* css */ `
.es-root {
  --es-panel:#22222c; --es-panel-hi:#30313d; --es-row:#1c1c24;
  --es-cream:#fff6e5; --es-muted:#b9b7c6; --es-faint:#91909f;
  --es-cyan:#18deec; --es-green:#b1ef19;
}
.es-root [hidden]{display:none!important}
.es-game-backdrop{position:absolute;inset:0;z-index:0;pointer-events:none}
.es-game-backdrop>canvas{display:block;width:100%;height:100%;object-fit:cover}
.es-vignette{z-index:1;background:rgba(10,12,24,0);transition:background .65s ease,backdrop-filter .65s ease}
.es-results-ready .es-vignette{background:rgba(10,12,24,.54);backdrop-filter:blur(3px)}
.es-modal-backplate,.es-stage{width:${u(1720)};height:${u(932)}}
.es-modal-backplate{position:absolute;left:50%;top:50%;z-index:2;pointer-events:none;
  transform:translate(-50%,-48%) scale(.975);opacity:0;
  border:${u(5)} solid var(--es-ink);border-radius:${u(46)};
  background:linear-gradient(160deg,#353541 0%,#262630 55%,#22232c 100%);
  box-shadow:0 ${u(15)} 0 #0e0d12,0 ${u(25)} ${u(65)} #05050a66,inset 0 ${u(3)} 0 #ffffff30,inset 0 ${u(-7)} 0 #15151d;
  transition:opacity .3s ease,transform .6s cubic-bezier(.2,1.25,.4,1)}
.es-modal-backplate::before{content:'';position:absolute;inset:${u(7)};border:${u(2)} solid #ffffff0c;border-radius:${u(36)}}
.es-results-ready .es-modal-backplate{opacity:1;transform:translate(-50%,-50%) scale(1)}
.es-canvas{z-index:3;pointer-events:none}
.es-scroller{z-index:4;pointer-events:none}
.es-stage{padding:${u(28)} ${u(32)} ${u(28)};grid-template-columns:minmax(0,1.28fr) minmax(0,1fr);
  grid-template-rows:${u(148)} minmax(0,1fr) ${u(220)};column-gap:${u(30)};row-gap:${u(24)}}
.es-stage>*{pointer-events:none}
.es-results-ready .es-stage>*{pointer-events:auto}
.es-flash{z-index:7}
.es-skip{z-index:8;bottom:52px}

/* Le résultat et son petit personnage forment une seule signature. */
.es-head{align-items:flex-start;justify-content:flex-start;gap:0;border-bottom:${u(2)} solid #ffffff12}
.es-title-slot{width:${u(700)};height:${u(148)};margin-left:${u(118)}}
.es-mascot{position:absolute;left:${u(2)};top:${u(8)};width:${u(128)};height:${u(128)};
  display:grid;place-items:center;border:${u(4)} solid var(--es-ink);border-radius:44% 48% 41% 48%;
  background:var(--es-cream);box-shadow:0 ${u(7)} 0 var(--es-ink),inset 0 ${u(-6)} 0 #d9d2c3;transform:rotate(-7deg)}
.es-mascot>.es-avatar{width:${u(110)};height:${u(122)};transform:rotate(7deg)}
.es-mascot::before,.es-mascot::after{content:'';position:absolute;background:var(--es-cyan);border:${u(3)} solid var(--es-ink);border-radius:${u(12)}}
.es-mascot::before{width:${u(29)};height:${u(13)};left:${u(-24)};top:${u(20)};transform:rotate(30deg)}
.es-mascot::after{width:${u(12)};height:${u(22)};left:${u(-15)};top:${u(47)};transform:rotate(-24deg)}
.es-mascot-spark{position:absolute;right:${u(-12)};bottom:${u(-2)};width:${u(42)};height:${u(42)};color:var(--es-yellow);filter:drop-shadow(0 ${u(3)} 0 var(--es-ink))}
.es-mascot-spark svg{width:100%;height:100%;stroke:var(--es-ink);stroke-width:1.5}
.es-head-label{position:absolute;top:${u(7)};right:${u(146)};font:900 ${u(14)}/1.4 var(--es-font-body);letter-spacing:.15em;color:var(--es-muted)}
.es-pills{position:absolute;right:0;bottom:${u(20)};display:grid;grid-template-columns:auto auto;gap:${u(10)}}
.es-pill{height:${u(40)};font-size:${u(21)};border-width:${u(3)};padding:0 ${u(16)};box-shadow:0 ${u(4)} 0 var(--es-ink)}
.es-pill-place{justify-content:center;background:var(--es-yellow)}
.es-pill-place b{font-size:${u(27)}}
.es-pill-wood{grid-column:1/-1;grid-row:1;justify-content:center;height:${u(37)};font-size:${u(19)};border-color:#20160e;box-shadow:0 ${u(4)} 0 #18110a,inset 0 ${u(2)} 0 #ffffff28}
.es-pill-wood .es-clock{font-size:${u(15)}}
.es-pill-score{gap:${u(12)};box-shadow:0 ${u(4)} 0 #0e0d12,inset 0 0 0 ${u(2)} #4e4e5c}
.es-pill-score b{font-weight:400;font-size:${u(28)}}
.es-pill-score span{font-size:${u(13)}}
.es-quit{top:${u(-3)};right:0;height:${u(34)};font-size:${u(17)};padding:0 ${u(17)};
  background:var(--es-cream);color:var(--es-ink);border-width:${u(3)};box-shadow:0 ${u(4)} 0 var(--es-ink)}
.es-quit:hover{background:#fff;transform:translateY(${u(-2)})}
.es-quit:active{transform:translateY(${u(3)});box-shadow:0 ${u(1)} 0 var(--es-ink)}

/* Le classement reprend les capsules du HUD, avec davantage d'air. */
.es-board{border:0;background:transparent;box-shadow:none;padding:${u(52)} ${u(2)} 0}
.es-board>.es-tab{top:0;left:${u(2)};height:${u(36)};font-size:${u(20)};padding:0 ${u(19)};border-width:${u(3)}}
.es-tab-dot{width:${u(14)};height:${u(14)};border-width:${u(2.5)}}
.es-board-count{position:absolute;right:${u(8)};top:${u(12)};font:900 ${u(13)}/1 var(--es-font-body);letter-spacing:.09em;color:var(--es-muted)}
.es-cols{--cols:${u(45)} ${u(48)} minmax(0,1fr) ${u(62)} ${u(62)} ${u(75)} ${u(118)} ${u(106)}}
.es-board-head{height:${u(22)};font-size:${u(12)};letter-spacing:.08em;padding-left:${u(12)}}
.es-rows{gap:${u(7)};margin:0 ${u(-5)};padding:${u(14)} ${u(5)} ${u(9)};scrollbar-width:thin;scrollbar-color:#72707e transparent}
.es-row{min-height:${u(39)};max-height:${u(46)};font-size:${u(23)};border-radius:${u(30)};
  padding-left:${u(7)};box-shadow:inset 0 ${u(2)} 0 #ffffff13,inset 0 0 0 ${u(2)} #41414e,0 ${u(4)} 0 #0c0c12}
.es-row.es-me{background:linear-gradient(#27f1f5,#15cfdf);box-shadow:inset 0 ${u(3)} 0 #b7ffff99,inset 0 ${u(-4)} 0 #00b0c3,0 ${u(5)} 0 #0c0c12}
.es-rank{width:${u(33)};height:${u(33)};font-size:${u(20)}}
.es-avatar{width:${u(39)};height:${u(39)}}
.es-score{height:${u(32)};min-width:${u(97)};font-size:${u(22)};box-shadow:inset 0 0 0 ${u(2)} #64636d}
.es-name{gap:${u(7)}}
.es-badges{gap:${u(2)}}
.es-badge{width:${u(22)};height:${u(22)}}
.es-acc b{font-size:${u(18)};min-width:${u(41)}}
.es-you{font-size:${u(10)};padding:${u(4)} ${u(6)}}

/* Deux vues, à la même place : chiffres essentiels / récit de la partie. */
.es-me-col{grid-template-rows:${u(42)} minmax(0,1fr);row-gap:${u(14)}}
.es-view-switch{display:flex;align-items:stretch;gap:${u(5)};padding:${u(4)};border-radius:${u(99)};
  background:#15151c;border:${u(3)} solid #0e0d12;box-shadow:0 ${u(3)} 0 #0e0d12;width:100%}
.es-view-switch button{flex:1;min-width:0;padding:0 ${u(15)};border:0;border-radius:${u(99)};background:transparent;color:#bab7c6;
  font:${u(18)}/1 var(--es-font-display);letter-spacing:.025em;cursor:pointer;transition:background .16s,color .16s,transform .16s}
.es-view-switch button[aria-selected=true]{background:var(--es-cream);color:var(--es-ink);box-shadow:inset 0 ${u(-3)} 0 #d7d0c3}
.es-view-switch button:hover{color:#fff}
.es-view-switch button[aria-selected=true]:hover{color:var(--es-ink)}
.es-view-switch button:active{transform:scale(.97)}
.es-tiles{grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:repeat(2,minmax(0,1fr));gap:${u(17)}}
.es-tile{position:relative;border-radius:${u(28)};grid-template-columns:${u(40)} minmax(0,1fr);grid-template-rows:${u(34)} auto auto;
  padding:${u(18)} ${u(22)};row-gap:${u(8)};column-gap:${u(11)};align-content:center;
  background:linear-gradient(150deg,#353541,#26262f);box-shadow:0 ${u(6)} 0 var(--es-ink),inset 0 ${u(3)} 0 #ffffff15,inset 0 ${u(-4)} 0 #15151b55}
.es-tile-icon{width:${u(35)};height:${u(35)};box-shadow:0 ${u(3)} 0 #0e0d12}
.es-tile-icon svg{width:${u(19)};height:${u(19)}}
.es-tile-label{font-size:${u(15)};color:#f7f0e2;letter-spacing:.06em}
.es-tile-value{font-size:${u(63)};line-height:.97;letter-spacing:-.02em;text-shadow:0 ${u(4)} 0 #0e0d12}
.es-tile-sub{font-size:${u(15)};color:#bcb9c8}
.es-tile[data-stat=kdr]{background:linear-gradient(135deg,#34f1ed,#0acbdc);box-shadow:0 ${u(6)} 0 var(--es-ink),inset 0 ${u(4)} 0 #beffff88,inset 0 ${u(-5)} 0 #029cad88}
.es-tile[data-stat=kdr] .es-tile-label,.es-tile[data-stat=kdr] .es-tile-value{color:#10212c;text-shadow:none}
.es-tile[data-stat=kdr] .es-tile-sub{color:#164654}
.es-tile[data-stat=kdr] .es-tile-icon{background:var(--es-cream)}
.es-tile[data-stat=streak] .es-tile-value{color:#ffb767}
.es-tile[data-stat=dmg] .es-tile-value{color:#e3f986}
.es-lower{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr) ${u(144)};gap:${u(23)};padding-top:${u(14)}}
.es-chart{padding:${u(26)} ${u(17)} ${u(8)};border-radius:${u(26)}}
.es-chart .es-tab{height:${u(32)};top:${u(-16)};left:${u(15)};font-size:${u(17)};border-width:${u(3)};padding:0 ${u(13)}}
.es-legend{top:${u(10)};right:${u(14)};font-size:${u(12)};gap:${u(10)}}
.es-legend i{width:${u(10)};height:${u(10)}}
.es-duels{grid-template-rows:minmax(0,1fr);grid-template-columns:repeat(2,minmax(0,1fr));gap:${u(14)}}
.es-duel{gap:${u(9)};padding:${u(21)} ${u(11)} ${u(10)};border-radius:${u(24)}}
.es-duel .es-tab{height:${u(30)};top:${u(-17)};left:${u(12)};font-size:${u(16)};padding:0 ${u(13)};border-width:${u(3)}}
.es-duel .es-avatar,.es-prey .es-avatar{width:${u(62)};height:${u(76)}}
.es-duel-name,.es-prey .es-duel-name{font-size:${u(22)}}
.es-duel-desc{font-size:${u(12)};line-height:1.4}
.es-duel-desc b{font-size:${u(15)}}
.es-vs{gap:${u(5)}}
.es-vs>b{font-size:${u(20)}}
.es-vs-bar{height:${u(13)}}
.es-vs-labels{font-size:${u(9)};letter-spacing:.04em}
.es-stamp{left:${u(0)};bottom:${u(18)};font-size:${u(11)};border-width:${u(2)};padding:${u(3)} ${u(5)}}
.es-duel-empty{font-size:${u(13)}}
.es-duel-empty b{font-size:${u(20)}}

/* Les maps sont une rangée de cartes à collectionner, bien séparée du bilan. */
.es-vote{grid-template-columns:${u(205)} minmax(0,1fr);gap:${u(24)};padding-top:${u(18)};border-top:${u(2)} solid #ffffff12}
.es-vote-head{height:100%;border:0;box-shadow:none;background:none;padding:${u(12)} 0 ${u(4)};gap:${u(9)}}
.es-vote-head .es-tab{position:static;transform:none;align-self:center;height:${u(31)};font-size:${u(18)};border-width:${u(3)};padding:0 ${u(13)};background:var(--es-green)}
.es-timer{width:${u(102)};height:${u(102)}}
.es-timer b{font-size:${u(43)}}
.es-vote-hint{font-size:${u(13)};max-width:${u(195)};line-height:1.5}
.es-maps{gap:${u(17)}}
.es-map{border-radius:${u(25)};border-width:${u(4)};box-shadow:0 ${u(6)} 0 #0e0d12}
.es-map::after{border-radius:${u(20)}}
.es-map::before{background:linear-gradient(180deg,#0e0d1200 27%,#0e0d1244 48%,#0e0d12ee 100%)}
.es-map-foot{left:${u(14)};right:${u(12)};bottom:${u(12)}}
.es-map-name{font-size:${u(29)};letter-spacing:.015em}
.es-map-sub{font-size:${u(12)};color:#e0dfe6}
.es-map-key{left:${u(10)};top:${u(10)}}
.es-map-count{right:${u(10)};top:${u(10)};padding:${u(4)} ${u(9)};gap:${u(4)}}
.es-map-count [data-c]{font-size:${u(19)}}
.es-map-count small{font-size:${u(10)}}
.es-map-badge{font-size:${u(12)};height:${u(25)};top:${u(49)};right:${u(10)}}
.es-voters{height:${u(24)};margin-top:${u(3)}}
.es-voters .es-avatar{width:${u(23)};height:${u(26)}}
.es-map.es-voted{box-shadow:0 ${u(6)} 0 #0e0d12,0 0 0 ${u(2)} var(--es-cyan)}
.es-map.es-voted::after{box-shadow:inset 0 0 0 ${u(4)} var(--es-cyan)}
.es-win-ribbon{top:${u(-16)}}
.es-win-ribbon .es-tab{height:${u(30)};font-size:${u(15)};border-width:${u(3)};padding:0 ${u(12)}}

/* Sur petit écran le panneau reste bordé et défile, le jeu reste en périphérie. */
.es-root[data-layout=tall] .es-modal-backplate{display:block;left:16px;top:var(--es-mobile-top,24px);width:calc(100% - 32px);height:var(--es-mobile-height,100%);transform:none;border-radius:${u(34)}}
.es-root[data-layout=tall] .es-scroller{padding:24px 16px 65px;pointer-events:auto}
.es-root[data-layout=tall] .es-stage{width:100%;min-height:0;gap:${u(28)};padding:${u(22)} ${u(20)} ${u(28)};
  border:${u(4)} solid var(--es-ink);border-radius:${u(34)};
  background:transparent;box-shadow:none}
.es-root[data-layout=tall] .es-head{height:${u(244)};padding:0;flex:none}
.es-root[data-layout=tall] .es-title-slot{width:calc(100% - ${u(88)});height:${u(120)};margin-left:${u(88)};margin-top:${u(30)}}
.es-root[data-layout=tall] .es-mascot{width:${u(86)};height:${u(98)};top:${u(51)};left:0}
.es-root[data-layout=tall] .es-mascot>.es-avatar{width:${u(78)};height:${u(92)}}
.es-root[data-layout=tall] .es-mascot-spark{width:${u(28)};height:${u(28)}}
.es-root[data-layout=tall] .es-head-label{left:0;right:auto;top:${u(7)};font-size:${u(12)}}
.es-root[data-layout=tall] .es-quit{top:0;height:${u(31)};font-size:${u(16)}}
.es-root[data-layout=tall] .es-pills{right:auto;left:0;bottom:${u(16)};width:100%;display:flex;flex-wrap:wrap;gap:${u(9)};justify-content:center}
.es-root[data-layout=tall] .es-pill{height:${u(34)};font-size:${u(18)};padding:0 ${u(12)}}
.es-root[data-layout=tall] .es-pill-wood{order:-1;width:100%;max-width:${u(400)};height:${u(31)}}
.es-root[data-layout=tall] .es-pill-score b{font-size:${u(22)}}
.es-root[data-layout=tall] .es-me-col{display:grid;grid-template-rows:${u(44)} auto;gap:${u(15)};order:2}
.es-root[data-layout=tall] .es-tiles{grid-template-columns:repeat(2,minmax(0,1fr));gap:${u(13)}}
.es-root[data-layout=tall] .es-tile{height:${u(170)};padding:${u(14)};column-gap:${u(6)}}
.es-root[data-layout=tall] .es-tile-label{font-size:${u(13)}}
.es-root[data-layout=tall] .es-tile-value{font-size:${u(54)}}
.es-root[data-layout=tall] .es-tile-sub{font-size:${u(12)}}
.es-root[data-layout=tall] .es-view-switch button{font-size:${u(16)}}
.es-root[data-layout=tall] .es-lower{display:grid;grid-template-rows:${u(300)} ${u(180)};gap:${u(24)};padding-top:${u(14)}}
.es-root[data-layout=tall] .es-chart-wrap{height:auto}
.es-root[data-layout=tall] .es-duels{height:auto;gap:${u(12)}}
.es-root[data-layout=tall] .es-duel{flex-direction:row;align-items:center;padding:${u(20)} ${u(10)} ${u(10)}}
.es-root[data-layout=tall] .es-duel .es-avatar{width:${u(49)};height:${u(60)}}
.es-root[data-layout=tall] .es-duel-name,.es-root[data-layout=tall] .es-prey .es-duel-name{font-size:${u(19)}}
.es-root[data-layout=tall] .es-stamp{top:auto;bottom:${u(27)};font-size:${u(10)}}
.es-root[data-layout=tall] .es-board-wrap{order:1}
.es-root[data-layout=tall] .es-board{padding-top:${u(52)}}
.es-root[data-layout=tall] .es-rows{gap:${u(9)}}
.es-root[data-layout=tall] .es-row{flex:none;height:${u(46)};max-height:none}
.es-root[data-layout=tall] .es-vote{order:3;gap:${u(20)};padding-top:${u(17)}}
.es-root[data-layout=tall] .es-vote-head{display:grid;grid-template-columns:auto ${u(70)};grid-template-rows:auto auto;text-align:left;padding:0;gap:${u(8)} ${u(16)}}
.es-root[data-layout=tall] .es-vote-head .es-tab{grid-column:1;grid-row:1;justify-self:start;left:auto;transform:none}
.es-root[data-layout=tall] .es-timer{grid-column:2;grid-row:1/3;width:${u(70)};height:${u(70)}}
.es-root[data-layout=tall] .es-timer b{font-size:${u(31)}}
.es-root[data-layout=tall] .es-vote-hint{grid-column:1;grid-row:2;max-width:none}
.es-root[data-layout=tall] .es-map-wrap{height:${u(200)}}
.es-root[data-layout=tall] .es-map-name{font-size:${u(25)}}
.es-root[data-narrow] .es-cols{--cols:${u(35)} ${u(36)} minmax(0,1fr) ${u(47)} ${u(55)} ${u(83)}}
.es-root[data-narrow] .es-score{min-width:${u(76)};padding:0 ${u(8)};font-size:${u(20)}}
.es-root[data-narrow] .es-row{font-size:${u(20)}}
.es-root[data-narrow] .es-rank{width:${u(29)};height:${u(29)};font-size:${u(18)}}
.es-root[data-narrow] .es-avatar{width:${u(32)};height:${u(34)}}
.es-root[data-narrow] .es-board-head{font-size:${u(10)};letter-spacing:.02em}
.es-root[data-narrow] .es-legend{position:static;align-self:flex-end;font-size:${u(10)};gap:${u(8)}}
.es-root[data-narrow] .es-duel .es-avatar{display:none}
.es-root[data-narrow] .es-stamp{display:none}
@media(prefers-reduced-motion:reduce){.es-vignette,.es-modal-backplate,.es-view-switch button{transition:none}}
`;
