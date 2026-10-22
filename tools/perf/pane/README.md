# Mesurer sur la vraie machine (navigateur intégré de Claude, ou console de Chrome)

Kit utilisé le 22/10/2026 sur le portable Iris Xe du propriétaire, dans le panneau navigateur de
l'application Claude relié à cet ordinateur. Il mesure le **build de production** tel quel (aucun
build spécial) : la page du jeu est chargée avec le crochet `__THREE_DEVTOOLS__` de three.js posé
AVANT le code du jeu, ce qui donne la scène, la caméra et les personnages au joueur scripté.

| Fichier | Rôle |
|---|---|
| `boot.js` | Charge le jeu dans l'onglet courant avec le crochet three.js (`window.__obs`). Réglages via `window.__bootCfg` (preset, panneau de debug, adresse `?gpu&diag=…`). Sauvegarde `slideio.settings` dans `slideio.settings.bak-perf`. |
| `probe-autopilot.js` | `window.__bz` : temps GPU de chaque image (requête TIME_ELAPSED autour du callback rAF du jeu), CPU du callback, draws / triangles ; `__auto` : ancien pilote simple ; `__ab.start(s)` : partie solo + mesure. **Incompatible avec `?gpu`** (deux requêtes de temps imbriquées) : avec `?gpu`, lancer `__bz.run("off", ms)`. |
| `realplay.js` | `window.__rp` : joueur « comme le propriétaire » — vise le bot vivant le plus proche (tir de loin aussi, sans tenir compte des murs), tire au paintball dès qu'il est sur la cible, recharge, se déplace vite (W, pas chassés, sauts, dash, glissades), et après chaque réapparition change d'arme puis revient (touche 2 puis 1, son habitude). L'état du joueur (vivant / mort, dégâts, kills, munitions) est lu dans les lots de commandes envoyés au HUD (`MessagePort.postMessage`). `__rp.measure(s)` → `window.__rpRes` (lignes par seconde, partage vivant / mort, instantanés du panneau de debug). |
| `match.js` | Menu → partie avec N bots → faux verrouillage du pointeur → calibrage de la souris de `__rp`. |
| `glcensus.js` | `window.__gc` : appels WebGL lourds ou synchrones PAR IMAGE (compilations, téléversements, readPixels, getError…), liés aux kills / morts / réapparitions, + Long Animation Frames (scripts) + chutes du tas JS (ramasse-miettes). |
| `heaprate.js` | Déchets mémoire produits par image (`performance.memory`, Chromium). |

## Déroulé (panneau navigateur de Claude, outils `Claude_Browser__*`)

1. `navigate` vers `https://slide-io.vercel.app/assets/credit.js` (page légère, même origine).
2. Ranger les scripts une fois dans le `localStorage` de cette origine : `__abScript` = `probe-autopilot.js`, `__rpScript` = `realplay.js`, `__gcScript` = `glcensus.js` (chaîne JSON). `match.js` les évalue tous.
3. `window.__bootCfg = { preset: "ultra", perfPanel: "full" }` puis évaluer `boot.js` → le jeu se charge (≈ 20-40 s).
4. Évaluer `match.js` puis `await (<match>)(8)` → en partie, 8 bots, souris calibrée.
5. `__gc.start(); __rp.start(); __rp.measure(60)` (sans attendre), puis interroger `window.__rpRes` / `__gc.stop()` → `window.__gcRes`.
6. Images autour des kills : chaque image de `__bz.frames` porte `s = [vivant, dégâts, kills, morts]` ; un kill = `s[2]` qui augmente.
7. À la fin : remettre `slideio.settings` depuis `slideio.settings.bak-perf`.

Pièges : le panneau doit être **affiché et au premier plan** (sinon le navigateur ralentit
`requestAnimationFrame` à ~1/s) ; `javascript_exec` abandonne après 45 s → lancer en asynchrone puis
interroger ; l'émulation de taille (`resize_window`) réduit l'image à l'écran du panneau, donc sous-estime
le coût du compositeur ; ne jamais mesurer pendant que le propriétaire joue sur la même machine.

## Ce que dit le panneau de debug (en partie)

`Frame` = intervalle entre images · `CPU` = temps du jeu par image (`sim` = tout avant l'envoi du
rendu, `render` = envoi du rendu, qui ATTEND quand le processus GPU du navigateur est en retard) ·
`Browser` = travail du thread principal après l'image (style, mise en page, ramasse-miettes…) ·
`HUD` = document du HUD (iframe isolée) · `Hitch` = découpage d'une image lente :
`jeu` (scripts du jeu) + `navigateur` (thread principal occupé hors du jeu : ramasse-miettes, style…)
+ `attente GPU` (thread principal libre, l'image attend le processus GPU / le compositeur).
`?gpu` ajoute une ligne `GPU` par passe (temps de la carte graphique du jeu), `?gpu=draws` par catégorie.
