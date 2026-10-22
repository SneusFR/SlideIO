# Passation — performances de Beanzo.io / SlideIO (22/10/2026, soir)

Écrit par la conversation précédente (session cloud reliée au portable du propriétaire) pour la
nouvelle conversation reliée à son **PC gamer**. À lire avec `PERFORMANCE.md` (historique des
passes, règles 1-58, interrupteurs `?diag=`) et `tools/perf/pane/README.md` (kit de mesure).

## Objectif du propriétaire (ses mots)

- **≥ 240 FPS STABLES** sur son PC gamer : RTX 2080 Super, écran 244 Hz, canvas 2559 × 1440
  (zoom navigateur 90 %, DPR 0,90), preset **Ultra**. Il dit : « il n'y a que les kills quasi qui
  font chuter ».
- **≥ 60 FPS stables en 1080p** sur ses portables Intel Iris Xe (perso « Sneus », et celui du travail).
- **Aucune baisse visuelle** sauf nécessité absolue, et alors avec son accord.
- Répondre **en français**. Il est exaspéré par les annonces « c'est réglé » démenties sur sa
  machine : ne rien déclarer réglé sans l'avoir vérifié **sur le PC gamer, avec des kills**, en
  regardant les **pires images** (budget 4,17 ms à 240 Hz), pas la moyenne.

## Livraison

Les sessions n'ont pas eu d'accès en écriture au dépôt : on livre des **paquets git** (bundles) que le
propriétaire applique et pousse lui-même ; Vercel déploie `main` sur https://slide-io.vercel.app.
Commandes (PowerShell, depuis son clone, sur `main` à jour) :

```powershell
git fetch "$env:USERPROFILE\Downloads\slideio-perf-NN.bundle" perf/integration
git merge --ff-only FETCH_HEAD
git push origin main
```

- Production (`origin/main`) = **ddfd791** (paquet perf-14).
- Paquet **perf-15** (celui qui accompagne ce fichier) = ddfd791 + la correction du garde « Auto »
  (660246e) + ce kit de mesure + cette passation.
- La conversation précédente a lancé trois chantiers (ci-dessous) ; leurs correctifs arriveront dans
  un paquet suivant (perf-16), construit sur la même branche `perf/integration`. **Ne pas les
  refaire ici** ; les vérifier sur le PC gamer quand ils arrivent.

## Ce qui a été mesuré le 22/10

### PC gamer (vidéo du propriétaire, panneau de debug visible)
- Régime normal : 238-240 FPS, `Frame` 4,2 ms (p95 4,3-5,3, max 5,9-6,9), `CPU` 2,9-3,4 ms
  (sim 1,5-1,8 / render 1,4-1,6), `Browser` 0,4-0,6 ms, HUD iframe 0,6-2,1 ms, 74-115 draws,
  309-478 k triangles. Setup : `scale 100% · AA composer MSAA 4x (color resolve) · shadows live ultra · aniso 16x`.
- **Au kill** : `Hitch: 17 ms = jeu 3 + navigateur 0 + attente GPU 14 · tir, kill` → le jeu n'a
  travaillé que 3 ms ; l'image a attendu **14 ms le processus GPU de Chrome**. Hors du travail WebGL
  du jeu (sur le portable en Ultra, l'image du kill ne compile aucun programme et ne crée aucune texture :
  15 bufferSubData = 171 Ko, 2 createBuffer + 2 bufferData = 2,4 Ko, 17 texSubImage2D). Suspects :
  la peinture du HUD au kill dans le processus GPU (médaille « KILL », combo « x1 BEAMED! », fil des
  kills : texte gros, contours, ombres, nouvelles tailles de police → glyphes), le décodage d'une image,
  un premier usage (première médaille d'un type, premier butin, premier cadavre qui projette une ombre
  en direct en Ultra).
- **Au tir** : `Hitch: 54 ms = jeu 3 + navigateur 50 + attente GPU 0 · tir` → 50 ms de thread principal
  hors du jeu : très probablement le **ramasse-miettes** (voir déchets ci-dessous).

### Portable perso (Iris Xe, panneau navigateur de Claude, build de production)
- Avec un joueur scripté qui joue comme le propriétaire (`realplay.js` : vise, tue, meurt, change d'arme) :
  60 FPS tenus sur 60 s, aucune image > 17,5 ms, GPU ≈ 9,5 ms / image (p90 10,5), CPU ≈ 5,5-5,9 ms,
  ~80 draws / 325 k triangles en combat.
- **Image du kill : 9,2 ms de CPU** contre 5,5 de base, puis 7-8,5 ms pendant 10+ images.
  **Réapparition** (avec le changement d'arme 2 → 1) : 9-11 ms pendant ~10 images. Mort : jusqu'à 10 ms.
- **Déchets mémoire : ≈ 100 Ko par image** en partie (≈ 6 Mo/s à 60 FPS), panneau de debug coupé, que le
  joueur bouge ou non ; tas JS ≈ 140-150 Mo utilisés ; ≈ 3 collections par seconde et une chute de
  ~24 Mo toutes les ~6 s. À 240 FPS, si c'est par image, c'est 4 fois plus par seconde.
- La vidéo du propriétaire sur ce même portable, dans **son Chrome**, montre 45-55 FPS en combat avec des
  images de 17-26 ms limitées par le GPU (`attente GPU` 15-32 ms), `Browser` 2-10 ms, `sim` 3-8 ms : environ
  **2× plus lent** que le panneau sur la même machine. Cause non établie (le panneau réduit l'image à
  l'écran et sous-estime le compositeur ; il enregistrait l'écran ; chaleur ?). Une capture avec `?gpu`
  dans son Chrome trancherait (temps GPU du jeu lui-même vs attente).

### Le garde « Auto » (corrigé dans perf-15, 660246e)
Dans sa vidéo du portable, Auto ne baissait jamais la qualité : le garde comptait l'attente de l'envoi
du rendu (processus GPU en retard) comme du temps processeur, donc refusait de juger. Corrigé : l'envoi
est compté à son niveau habituel (plancher glissant), le surplus est mis au compte du GPU ; un cran
inutile est défait. Tests `scripts/test-graphics-autotune.mts` 62/62. Pas encore vérifié de bout en
bout sur une vraie machine.

## Chantiers en cours dans la conversation précédente (→ perf-16)
1. **Déchets par image** (`opt/alloc`) : trouver et supprimer ce qui alloue ~100 Ko par image ;
   expliquer les 140 Mo de tas.
2. **Pics au kill / mort / réapparition / tir** (`opt/killspike`) : thread principal ET processus GPU.
3. **Bug : l'arme disparaît après la mort** (`opt/deathweapon`) : le propriétaire change d'arme (2 puis 1)
   pour la récupérer.

## Ce que la nouvelle conversation peut faire que l'ancienne ne pouvait pas
Mesurer sur le PC gamer lui-même (panneau navigateur de Claude sur l'écran 244 Hz, RTX 2080 Super) :
1. Vérifier que le panneau tourne à ~240 images/s (sinon : fenêtre au premier plan, écran 244 Hz).
2. Reproduire les chutes au kill en Ultra avec `tools/perf/pane/` (`boot.js` avec
   `{ preset: "ultra", perfPanel: "full" }`, `match.js`, `realplay.js`, `glcensus.js`) : images autour
   de chaque kill (intervalle, CPU du jeu, GPU du jeu, appels WebGL), lignes `Hitch`, Long Animation Frames.
3. **Identifier l'attente GPU de 14 ms au kill** : comparer avec `?hud=inline` (HUD dans la page),
   couper les effets du kill un par un, regarder si elle ne survient qu'au premier kill d'un type
   (médaille, tête, marteau, butin, cadavre en ombre en direct).
4. Mesurer le ramasse-miettes à 240 FPS (`heaprate.js`, chutes du tas pendant `realplay`).
5. Ensuite seulement, corriger ce qui reste et vérifier perf-16 sur le PC gamer avant de le livrer.

Toujours : sauvegarder puis remettre les réglages du joueur (`slideio.settings`), ne pas mesurer
pendant qu'il joue sur la même machine, le prévenir avant chaque test.

## 22/10 au soir — mesures sur le PC gamer lui-même (conversation reliée au PC)

Panneau navigateur de l'application Claude sur le PC gamer (RTX 2080 Super, D3D11, 239,8 Hz),
build de production, Ultra (ligne `Setup` identique à celle du propriétaire), Givre, 8 bots, joueur
scripté au paintball ; panneau 1826 × 1278 (lui : 2559 × 1440). Détail : PERFORMANCE.md, « Les chutes
au kill, mesurées sur le PC gamer (20ᵉ passe) » ; outils : `tools/perf/pane/killwatch.js`,
`segprobe.js`, `firsts.js`, `hudinject.js` et les pièges du README.

- **L'attente GPU de 14 ms au kill = la première HEADSHOT** (ou tout premier aspect de badge jamais
  dessiné) : 16,7 ms = jeu 3,4 + navigateur 0,6 + attente ~12, reproduit sans kill en reposant la seule
  commande `medal.show` dans le vrai HUD ; une fois par processus GPU. Le préchauffage ne dessinait pas
  les badges sans étoile ni à 2 étoiles. **Correctif prêt** (branche `pc/medal-warmup`, commit 277e751 :
  `medals/medalLooks.ts`, deux passes de préchauffage, `scripts/test-hud-warmup-medals.mts`), **pas
  encore livré ni vérifié** : il faut le déployer puis le vérifier au PC gamer avec un cache GPU froid
  (fermer l'appli Claude, vider son cache GPU, rouvrir), et relever l'étape `HUD` de la ligne `[BOOT]`.
- **Les chutes à chaque kill (tout préparé)** : 0-7 images manquées par kill (3-4 en moyenne) avec le
  HUD, 0-2 (0,4) HUD masqué pour le même CPU d'image du kill (4,4-6,2 ms) : la somme du pic de CPU et du
  travail du HUD dans le processus GPU au même moment. **À mesurer** : A/B HUD affiché / masqué en
  alternance dans une même partie chaude (~20 kills), chaque image manquée classée CPU ou attente ; puis
  `?diag=paintfps30` / `paintss100` (peinture de plaque).
- **La pause « navigateur 50 ms » au tir : pas reproduite** en 4 min (57 000 images) ; ramasse-miettes
  ~1/s, +16,8 Mo/s à 240 FPS, pire image liée à une collection 20,9 ms ; plancher du tas +3 Mo/min.
  Demander au propriétaire la ligne `[hitch]` de la console (F12) si elle revient.
- Le profil du panneau (localStorage du site) a été rendu **vide**, comme au départ.
- perf-16 (autre conversation) pas encore reçu : le vérifier au PC gamer, kill par kill, avant toute
  livraison ; rebaser `pc/medal-warmup` dessus s'il ne couvre pas déjà les badges.
