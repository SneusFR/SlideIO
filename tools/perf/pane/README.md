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
| `killwatch.js` | `window.__kw` (PC gamer, 22/10) : CHAQUE image du jeu avec la découpe de la ligne `Hitch` (`lead` = retard du callback du jeu sur l'horodatage rAF, `jeu`, `navigateur` = message posté en fin d'image, `attente` = le reste), l'état du joueur, le tir, les commandes envoyées au HUD, les appels WebGL notables, les Long Animation Frames. `__kw.report()` : pires images avec leur contexte, images autour de chaque kill / mort / réapparition. |
| `segprobe.js` | `window.__sp` : temps GPU de CHAQUE PASSE (une requête TIME_ELAPSED par liaison de framebuffer). **À lire avec prudence** : une requête de temps mesure l'horloge du GPU entre deux points, donc le travail d'un AUTRE client du processus GPU (HUD, compositeur) qui s'intercale après un `gl.flush()` du jeu y est compté. Un « pic GPU du jeu » sans attente côté jeu = du travail de quelqu'un d'autre. Avec `__bz.mode = "off"` (deux requêtes de temps ne se chevauchent pas). |
| `firsts.js` | `window.__fd` : premières fois (programme, formats d'attributs du VAO, framebuffer) PAR DESSIN — ce qu'ANGLE / D3D11 compile paresseusement dans le processus GPU au premier dessin. À évaluer AVANT `boot.js` (dans la même fenêtre) pour voir aussi le préchauffage ; `__fd.start()` ne garde ensuite que les nouvelles. 22/10 : 0 en partie (le préchauffage 3D est complet). |
| `hudinject.js` | `window.__hi` : garde le port du HUD, capture les vraies commandes (avec leurs arguments) et en reposte une seule, sans kill (`__hi.send([["medal.show", "HEADSHOT", 1]])`), pour isoler le coût d'un effet du HUD dans le vrai HUD (iframe). `__hi.effect()` : pire image et images manquées après chaque injection. C'est ce qui a trouvé l'attente GPU de 14 ms au kill (première médaille sans étoile). |
| `analyze.js` | Rapport d'un passage `killwatch.js` joint à `segprobe.js` et `firsts.js`. |
| `cpuprof.js` | `window.__cp` : où va le CPU du jeu, PAR IMAGE et autour de chaque kill / mort / réapparition, sans carte des sources. Les noms de MÉTHODES survivent à la minification : depuis le bot (`userData.combatant` de son nœud), le monde des armes (`deps` : les armes du JOUEUR, leurs effets, l'audio), le joueur et son fusil, les objets atteignables à 3 propriétés près sont explorés et chaque méthode de leurs classes est enveloppée (temps inclusif × appels), plus `render`, `mixer.update`, `skeleton.update`, le raycaster, `scene.updateMatrixWorld` et l'envoi des lots au HUD. Les classes de three.js et du navigateur ne sont pas enveloppées (trop d'appels). `__cp.start()`, `__cp.report()` → moyenne par image + images −2…+14 autour de chaque évènement. |

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

Pièges vus sur le PC gamer (22/10) :
- **Une partie solo dure 5 min** : à la fin, l'écran de fin fait voter les bots et peut **changer de carte**
  (`slideio.mapId`, rechargement). Repartir d'une page légère avant les 5 min, et remettre `slideio.mapId`
  avant chaque `boot.js`.
- Le profil du panneau est **vierge** pour ce site : `boot.js` ne règle le preset que si `slideio.settings`
  existe — l'écrire avant (`{ v: 1, graphics: { preset: "ultra" }, perfPanel: "full" }`), avec
  `slideio.mapId` et `slideio.loadout.v1`. À la fin, tout effacer (localStorage, sessionStorage) pour
  rendre le profil tel qu'il était.
- `performance.memory` lu dans un callback rAF reste figé : l'échantillonner par `setInterval`.
- **Les « premières fois » du processus GPU** (un aspect du HUD jamais dessiné) se paient une seule fois
  par processus GPU du navigateur — et le panneau partage celui de l'application Claude. Après une première
  partie, elles ne se voient plus, même en rechargeant la page : pour les mesurer, injecter des aspects
  encore jamais montrés (`hudinject.js`), ou repartir d'un cache GPU froid.
- L'interface de l'application Claude passe par le même processus GPU que le panneau : pendant une mesure,
  personne ne doit faire défiler la conversation ni taper dedans.

## Ce que dit le panneau de debug (en partie)

`Frame` = intervalle entre images · `CPU` = temps du jeu par image (`sim` = tout avant l'envoi du
rendu, `render` = envoi du rendu, qui ATTEND quand le processus GPU du navigateur est en retard) ·
`Browser` = travail du thread principal après l'image (style, mise en page, ramasse-miettes…) ·
`HUD` = document du HUD (iframe isolée) · `Hitch` = découpage d'une image lente :
`jeu` (scripts du jeu) + `navigateur` (thread principal occupé hors du jeu : ramasse-miettes, style…)
+ `attente GPU` (thread principal libre, l'image attend le processus GPU / le compositeur).
`?gpu` ajoute une ligne `GPU` par passe (temps de la carte graphique du jeu), `?gpu=draws` par catégorie.
