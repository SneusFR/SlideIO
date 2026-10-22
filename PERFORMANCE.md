# Performances — ce qui coûte, ce qui a été fait, comment garder le jeu rapide

Ce document résume l'audit de performances d'octobre 2026 (Givre, Jungle, Yard ;
PC gamer RTX 2080 Super / i9‑9900K à 240 Hz, portable Intel Iris Xe). Il sert de
référence pour ne pas réintroduire les mêmes coûts.

## Le constat

Le jeu n'était limité ni par les tirs ni par la carte graphique : il l'était par
le **nombre de draw calls** (et les changements de matériau qui vont avec). Chaque
draw call coûte du CPU deux fois — dans three.js (setup du programme, upload des
uniforms) puis dans le process GPU du navigateur (ANGLE / D3D11) — et c'est encore
plus vrai sur un iGPU. Avant optimisation, sur Givre en HIGH :

| Source | Draw calls (par frame) |
|---|---|
| Carte statique (≈ 70 lots) + **re-rendu complet de l'ombre de la carte** à chaque frame | ≈ 70 + 70 |
| Décor animé de Givre (guirlandes, bannières, tuyaux, jauges…) + 15 halos | ≈ 110 |
| **Par bot** : 6 morceaux de perso + 6 contours rouges + 6 ombres + 10‑15 pièces d'arme (+ leurs ombres) + 3 plans de barre de vie | ≈ 25‑35 |
| **Par loot au sol** (pièce / medkit) : 6 meshes + 1 halo — 3 à 11 loots par kill, 20‑25 s de vie | 7 |
| Pools de FX vides (pop‑corn, peinture, eau, empreintes, particules) | 7 |

Avec 8 bots qui s'entretuent, on dépassait 600 draw calls et 4 000 appels WebGL par
frame, et ce nombre montait/descendait avec les kills (loot + cadavres) : d'où la
chute brutale de 4 à 8 bots et les oscillations.

Côté simulation, le pic le plus violent venait du **placement des taches de
peinture / d'eau sur les corps** : un raycast sur le mesh skinné re-skinnait le
corps entier sur le CPU, triangle par triangle, à chaque impact (≈ 21 000
opérations de skinning par rayon).

## Ce qui a été fait (sans dégradation visuelle)

| Domaine | Changement | Fichiers |
|---|---|---|
| Ombres (HIGH) | La profondeur de la carte statique est rendue **une seule fois** puis recopiée à chaque passe d'ombre (1 draw) ; seuls les personnages sont re-rendus. Givre HIGH repasse en 4096 × 2048 (8 cm/texel) gratuitement. | `effects/StaticShadowCache.ts`, `game/Game.ts`, `world/GivreConfig.ts` |
| Personnages | 6 morceaux → **2** (corps intact + « détails » = yeux + bouche + dents + feuille, un seul matériau) ; 1 squelette par avatar au lieu de 6 ; contour rouge des ennemis : **1 coque** au lieu de 2 (géométries fusionnées, même squelette). Contrats conservés : le corps garde son nom `Potato` et sa géométrie (peinture, eau, masques astronaute). | `characters/PotatoCharacter.ts`, `bots/BotModel.ts`, `network/RemotePlayerManager.ts` |
| Armes TP | Les pièces rigides qui partagent un matériau — ou dont les matériaux ne diffèrent que par des constantes (Hex Sniper : 4 pièces → 1) — deviennent **un seul mesh skinné** dont les « os » sont les pièces elles-mêmes : les contrôleurs animent toujours les mêmes objets (y compris `visible`). Les vitres (verre transparent double face) sont deux meshes à face fixe au lieu de la double passe de three.js. Les pièces restantes : ombres seulement pour les grosses pièces, frustum culling activé. | `effects/RigidPartsBatch.ts`, `network/remote/RemoteWeaponController.ts` |
| Programmes GPU | three.js re-sélectionnait le programme d'un matériau **~33 fois par frame** à 8 bots (≈ 2 maintenant) : objets transparents double face dessinés en deux passes (cadavres, vitres, traînées de frisbee), matériaux partagés entre un mesh skinné et un mesh rigide / instancié. Cadavres : une seule passe tant qu'ils sont opaques (le fondu garde les deux passes). | `ragdoll/CorpseManager.ts`, `weapons/frisbee/*`, `effects/RigidPartsBatch.ts` |
| Cartes | Matériau « uber » : les matériaux qui ne diffèrent que par des constantes (couleur, rugosité, métal, émissif) partagent **un** matériau (constantes passées en attributs de sommet). Lots statiques fusionnés par cellule de 40 m (culling conservé, BVH pour les tirs). Décor animé → meshes skinnés pilotés par le même mixer (eux aussi regroupés en uber : moins de draws et moins d'uploads de bones). | `world/MapBatching.ts`, `world/GivreMap.ts`, `world/JungleMap.ts`, `world/YardMap.ts` |
| Givre | Halos : 1 draw au lieu de 15. Nœuds statiques du GLB sans recomposition de matrice. Wireframes de collision hors de la scène quand ils sont cachés. | `world/GivreHalos.ts`, `world/GivreEffects.ts`, `world/GivreMap.ts`, `game/Game.ts` |
| Loot | Toutes les pièces / tous les medkits d'un type en **instancing** (culling par loot sur le CPU, refait avec la caméra du tourbillon de la masse), et chaque modèle (une primitive par couleur plate) fusionné en un seul mesh à couleurs de sommet : **2 draws par type de loot** (modèle + halo) au total, au lieu de 6‑7 par loot au sol. | `pickups/PickupBatch.ts`, `pickups/PickupManager.ts`, `pickups/PickupAssets.ts` |
| Barres de vie | Toutes les barres en **2 draws** instanciés (remplissage opaque + fond / étiquette « BOT » transparents), triées d'arrière en avant à chaque rendu (même superposition qu'avant entre bots). | `bots/EnemyHealthBars.ts`, `bots/BotModel.ts` |
| FX | Les pools instanciés vides ne sont plus dessinés (`hideWhenEmpty`) ; particules et jets d'eau idem. | `effects/hideWhenEmpty.ts`, FX concernés |
| Simulation | Raycast skinné mis en cache une fois par frame (peinture / eau) ; synchro ragdoll : seuls les os nécessaires sont recalculés, une fois (plus de remontée jusqu'à la racine pour chaque partie), et plus rien une fois le corps endormi dans Rapier ; listener audio limité à ~60 Hz. | `effects/SkinnedRaycast.ts`, `ragdoll/RagdollController.ts`, `audio/AudioManager.ts` |
| Graphe de scène | Racine de la scène et nœuds statiques des cartes « gelés » (`matrixAutoUpdate = false`, seules les cibles des animations restent dynamiques) : les deux mises à jour de matrices par frame ne recalculent plus toute la carte. La seconde (dans `renderer.render`) saute aussi les bots et les cadavres, déjà à jour pour la frame (`matrixFresh`). | `game/Game.ts`, `effects/matrixFresh.ts`, `world/MapBatching.ts` (`freezeStaticTransforms`), cartes |
| Saccades | Les shaders qui compilaient en pleine partie sont compilés au chargement : barres de vie des bots, l'eau du réservoir du Water FAMAS tenu par un bot (le warm-up la compilait puis la détruisait aussitôt), et les deux rendus d'un cadavre (vivant opaque, puis fondu). Décor Givre (fumées, halos) de nouveau animé dans le menu / le vol de caméra. | `game/Game.ts`, `bots/BotModel.ts`, `world/GivreEffects.ts` |
| Saccades (2ᵉ passe, portable) | **Programmes jamais libérés** : three.js détruisait un programme dès que son dernier matériau était `dispose()`, et le recompilait au matériau suivant (10 à 300 ms sous Windows / D3D11). L'anneau d'impact du Frisbee clonait + jetait son matériau à chaque rebond : **une compilation à presque chaque impact de disque** (18 en 25 s de combat sur le banc). Les anneaux sont maintenant réutilisés, et chaque programme compilé reste en cache toute la session (`ProgramPin`). Warm-up : la peau mouillée (et mouillée + peinte, dans les deux ordres) est compilée au chargement, et sur Givre les rendus de warm-up passent par le composer (sa cible est linéaire : les variantes compilées en rendu direct n'étaient jamais celles utilisées en jeu). Topologie des corps (soudure des sommets + voisins, pour la peinture et l'eau) calculée une fois par géométrie au lieu d'une fois par bot touché. Une seule recherche A* par frame pour tous les bots. | `effects/ProgramPin.ts`, `weapons/frisbee/FrisbeeProjectiles.ts`, `effects/MeshTopology.ts`, `weapons/paintball/PaintSplats.ts`, `weapons/waterfamas/*`, `bots/BotManager.ts`, `game/Game.ts` |
| Saccades (3ᵉ passe : kills, tirs, dégâts) | **Premier dessin des effets du HUD au chargement** : médaille de kill, sticker BEANED!, combo, capsules de killstreak prêtes, hitmarker, nombres de dégâts, vignettes (dégâts, PV bas, soin), écran de mort, toutes les têtes du Bean Buddy, et une vraie mise à jour du classement (prise de tête, couronne, « +1 ») sont dessinés pendant 4 frames de l'écran de chargement, par-dessus lui à 0,4 % d'opacité (invisible). Le navigateur compile ses shaders de rastérisation (dégradés coniques masqués, ombres floues, texte détouré, filtres SVG — sous Windows / D3D11 : des dizaines de ms chacun) et ses caches de texte / SVG à ce moment-là, et non au premier kill. **Retours de tir sans reflow forcé** : le recul du réticule, le hitmarker et le pop des nombres de dégâts relançaient leur animation CSS en lisant `offsetWidth` — un calcul synchrone du style **et de la mise en page de toute la page** à chaque balle (jusqu'à trois par frame au paintball, 600 coups/min). Ils alternent maintenant entre deux keyframes identiques, une fois par frame au plus (`FramePulse`). **Vignettes** (dégâts, PV bas, soin) sur leur propre couche de composition : leur opacité, réécrite frame après frame, re-rastérisait tout le HUD plein écran à chaque palier. **Peinture 3D de la plaque du Paintball** : ce raymarching tourne dans un *second* contexte WebGL (invisible dans la ligne `GPU` du HUD), à chaque frame tant que la peinture bouge ; il était rendu à 3× la taille de la plaque quelle que soit la taille réelle à l'écran — il suit maintenant la densité de pixels réelle × 2 (même aspect sur-échantillonné, 3× au plus) : inchangé quand la plaque est grande à l'écran (fenêtre de 1536 px à 125 %, 1440p…), −44 % de pixels dans une fenêtre de 1280 px. Son coût GPU s'affiche maintenant sur la ligne `GPU` (« peinture HUD »). L'écran de chargement sort du rendu après son fondu (ses animations tournaient toute la partie). | `ui/HudWarmup.ts`, `ui/framePulse.ts`, `ui/CrosshairHUD.ts`, `ui/HitmarkerHUD.ts`, `ui/DamageNumbersHUD.ts`, `ui/paint/*`, `hud.css`, `crosshair.css`, `style.css`, `main.ts`, `game/Game.ts` |
| Saccades (4ᵉ passe : Hex Sniper des bots) | **Sphères de tri pré-calculées pour les maillages skinnés** : three.js trie (et, s'ils sont « cullés », teste) un `SkinnedMesh` avec sa propre `boundingSphere`. Laissée vide, le moteur la calcule au **premier dessin de chaque clone** en re-skinnant **tous** ses sommets sur le CPU — même pour un maillage jamais culled (le centre de la sphère sert de profondeur de tri). La créature du Hex Sniper fait 16 220 sommets : **15 à 50 ms** sur le banc, à chaque bot qui réapparaît avec le Hex Sniper et à chaque cadavre d'un bot mort avec (dans la vidéo du portable : les creux à 50 FPS tombent sur des kills de bots). La sphère est maintenant posée une fois sur le modèle chargé (sphère de la géométrie, élargie comme celles des personnages) et copiée gratuitement dans chaque clone ; filet de sécurité pour toute arme 3ᵉ personne et tout cadavre (`adoptSkinnedBounds`). Rendu identique (0 pixel de différence sur un bot armé du Hex Sniper). **Ligne `Hitch` du HUD** : dès 30 ms (deux images manquées à 60 Hz, les creux à 50 FPS) et avec la **découpe du CPU du jeu par section** (`bots IA`, `armes bots`, `physique`, `rendu`…), en `npm run dev`. | `effects/skinnedBounds.ts`, `weapons/hexsniper/HexSniperModel.ts`, `network/remote/RemoteWeaponController.ts`, `bots/BotModel.ts`, `network/RemotePlayerManager.ts`, `ui/FrameSections.ts`, `ui/DebugHUD.ts`, `game/Game.ts` |
| Saccades (5ᵉ passe : premier kill du joueur) | **Warm-up du HUD tenu jusqu'au vrai dessin.** Mesuré cette fois avec la rastérisation GPU allumée sur le banc (Skia sur ANGLE / SwiftShader : chaque shader de rastérisation compilé par le navigateur apparaît dans la trace) : malgré le warm-up de la 3ᵉ passe, le premier kill compilait encore **19 shaders** du navigateur (0 au 2ᵉ kill) — vraisemblablement les 4-5 frames de 40-50 ms vues sur le portable dans les secondes qui suivent. Cause : chaque état du warm-up ne restait affiché qu'une ou deux frames ; or le travail GPU d'un état (rastérisation, compilation de ses shaders) passe *après* la frame qui l'affiche, et le navigateur l'abandonne si l'état a déjà disparu. Chaque état est maintenant tenu jusqu'à ce que deux frames de suite arrivent à l'heure (le processus GPU a fini ; 3 frames au moins, 0,6 s au plus, 8 s pour tout le warm-up) : **5 à 6 shaders** au premier kill. Le warm-up rejoue aussi des situations réelles l'une après l'autre — le premier kill tel quel (médaille KILL simple, sticker, combo x1, saut du Bean Buddy, classement), un combat (dégâts, tube de PV à moitié vide, dash), les états rares, la mort — avec les classes et les jauges exactes du jeu, chaque animation dessinée en cours, figée, au repos puis en sortie (l'étiquette de combo qui « tombe » était masquée par une règle plus spécifique). Le HUD est dessiné **sous** l'écran de chargement, à pleine opacité (l'écran en laisse passer 0,4 %) au lieu de par-dessus à 0,4 % d'opacité. ~2 s de plus sur l'écran de chargement à 60 Hz (0,5 s à 240 Hz ; un peu plus au tout premier lancement, quand les shaders compilent vraiment). **Ligne `Hitch`** : le travail du navigateur après chaque frame est mesuré à chaque frame (l'API Long Animation Frames ne voit que les frames de 50 ms et plus : sur une saccade de 30 à 50 ms, il était compté en « attente GPU »). | `ui/HudWarmup.ts`, `style.css`, `ui/DebugHUD.ts`, `game/Game.ts` |
| 240 Hz (6ᵉ passe : PC gamer, « -30 FPS » après les kills) | **Le travail du navigateur à chaque frame, pas celui du jeu.** Sur la vidéo du PC gamer (RTX 2080 Super, 1440p, 240 Hz, HIGH), les FPS tombent à 200-229 pendant 0,5 à 1 s après chaque kill, tir ou rechargement, alors que le CPU du jeu reste à 2-3,5 ms par frame : le reste des 4,2 ms d'une frame à 240 Hz part dans le rendu du navigateur — composition du HUD, et le processus GPU de Chrome, qui exécute aussi les ~1 000 appels WebGL du jeu par frame. **Peinture 3D de la plaque d'arme** (Popcorn, Paintball) : rendue dans un 2ᵉ contexte WebGL puis recopiée dans un canvas 2D à chaque frame d'animation — jusqu'à 240 fois par seconde après chaque tir et pendant chaque goutte, chaque copie = un instantané GPU fraîchement alloué, recopié, puis redessiné dans le canvas 2D. La plaque visible affiche maintenant **le canvas WebGL lui-même** (même boîte, même taille de rendu : pixels identiques au banc, 2 pixels sur 100 000 différents d'un niveau) ; la copie 2D ne reste que quand plusieurs plaques sont affichées (page d'aperçu). **Barres du HUD pilotées en JS** (combo, PV « fantôme », dash) sur leur propre couche : la corde du combo re-rastérisait toute la pile du haut de l'écran presque à chaque frame pendant toute la fenêtre de combo, la barre « fantôme » tout le panneau de vie pendant qu'elle se vide (règle 14). **Lueur des dégâts directionnels** : six couches composées de 4 552 × 4 552 px en 1440p (un dégradé de 160 vmax de côté, transparent sur l'essentiel) — la boîte suit maintenant la partie non transparente du dégradé, mêmes pixels (écart ≤ 2 niveaux, tramage) : **148 → 53 Mpx** de couches composées pour le HUD. **Écran de mort** sur sa propre couche : il était fusionné dans la couche d'un petit élément qu'il recouvre (réticule, panneau debug), qui grandissait à tout l'écran et se re-rastérisait en entier à la mort, puis à la réapparition. **Moins d'appels WebGL** : les ~70 `texParameteri` par frame qui ne faisaient que répéter les réglages des textures d'os (re-téléversées à chaque frame) ne partent plus (`TexParamDedupe`). **Rapier** : chaque requête sans filtre (contrôleurs de personnage, rayons) rappelait le JS pour chaque collider candidat (~100 allers-retours WASM ↔ JS par frame avec 8 bots, chacun alloue) — plus aucun, résultats identiques ; positions et vitesses lues dans des objets réutilisés (plus de vecteur alloué par lecture). **Ligne `Hitch`** relative à la fréquence de l'écran (12,5 ms à 240 Hz au lieu de 30 ms), avec le déclencheur probable (`kill`, `tir`, `mort`…) ; nouvelle ligne `Browser`, et `FPS: 203 / 240 Hz`. | `ui/paint/PaintLayer.ts`, `ui/paint/PaintGL.ts`, `hud.css`, `effects/TexParamDedupe.ts`, `physics/PhysicsWorld.ts`, `bots/Bot.ts`, `player/PlayerController.ts`, `ragdoll/RagdollController.ts`, `effects/SkinnedRaycast.ts`, `ui/DebugHUD.ts`, `ui/frameEvents.ts`, `game/Game.ts` |
| 240 Hz (7ᵉ passe : médaille de kill) | **La médaille se reconstruisait à chaque kill, et ses rayons tournaient sur le thread principal.** Sur le PC gamer (244 Hz), le CPU du jeu reste à 3,2 ms au kill, mais la ligne `Browser` passe à 2,2 ms : 3,2 + 2,2 dépasse les 4,1 ms d'une frame, d'où −40 à −50 FPS pendant environ 1 s. (1) `#medal-display` était caché par `display: none` : à chaque sortie, ses couches et leur rastérisation (disque, dessin, texte détouré, rubans, étoiles) étaient jetées, puis reconstruites à la médaille suivante. Il est maintenant caché par `opacity: 0` sur sa propre couche (`will-change`), et chaque partie animée au pop garde sa couche. Le badge caché arrête ses animations (`#medal-display.hidden * { animation: none }`), qui repartent de 0 au pop suivant, comme avant. (2) Les rayons recevaient deux animations de `transform` sur le même élément (pop + rotation infinie) : Chrome ne compose pas ce cas (`TargetHasIncompatibleAnimations`), donc tant qu'une médaille était affichée, le thread principal refaisait le style, la mise à jour des couches et le commit à **chaque frame**. Le pop reste sur `.md-rays` ; la rotation passe sur un SVG enfant (`medalRaysSvg`), mêmes 14 secteurs, même fondu radial. Le masque CSS animé (surface de rendu et fusion du masque à chaque frame) est remplacé par un masque SVG rastérisé une seule fois avec la couche. Rendu identique à l'œil (écart moyen de 1 niveau sur 255 sur les rayons seuls, lissage des bords des secteurs). | `hud.css`, `ui/MedalHUD.ts`, `ui/hudIcons.ts`, banc `tools/perf/medal-bench.mjs` |
| Chargement (8ᵉ passe : 6 s, parfois 17 s) | **Les étapes du chargement se recouvrent au lieu de s'attendre.** Les ~90 programmes GPU étaient compilés **un par un**, au premier rendu de warm-up qui s'en servait : le thread principal attendait chaque compilation — sous D3D11, 10 à 300 ms par programme quand le cache de shaders de Chrome est froid (après une mise à jour de Chrome ou du pilote, ou un déploiement qui change un shader), d'où les chargements de 17 s. Ils partent maintenant au processus GPU dès que la scène existe (`renderer.compile` ; sous Windows, Chrome les compile **en parallèle** sur plusieurs threads), pendant que le jeu analyse les armes ; le chargement attend qu'ils soient liés par une requête de statut qui n'attend jamais (`programsLinked`), et le warm-up du HUD tourne pendant cette compilation (il attendait la fin du warm-up GPU). Tous les fichiers (carte, personnage, tenues, skins, armes TP) sont demandés **au début** du chargement, la carte pendant l'initialisation de Rapier ; la lance (13 Mo : 128 k triangles, trois JPEG 2048²) n'est plus analysée et téléversée qu'**une** fois pour la vue FP et la vue TP. **Ce qui ne sert ni au menu ni à la première frame de jeu sort de l'écran de chargement** : BVH de tir de la carte (construits un par un dans les temps morts du menu, au plus tard au clic sur JOUER), 2ᵉ contexte WebGL de l'aperçu de personnalisation (créé à l'ouverture de ce menu), icônes des armes (dans les temps morts, ou à l'ouverture du menu d'équipement), wireframes de collision (à leur première activation). **Calculs du chargement accélérés, résultats identiques au bit près** (tests d'équivalence contre l'ancien code) : découpage, soudure et copie en espace monde des lots de Givre, grille de neige, boîtes englobantes des maillages skinnés (la matrice de chaque os calculée une fois au lieu d'une fois par influence de chaque sommet), empreinte SHA-256 des tenues mise en cache. **Grille de navigation des bots en cache** (localStorage) sous une signature de tous les colliders statiques, des bornes, du code de construction et de la version de Rapier : elle n'est recalculée que si l'un d'eux change. En production, three.js ne relit plus le journal de compilation de chaque shader (`checkShaderErrors`, gardé en `npm run dev`). Nouvelle ligne `[BOOT]` dans la console (voir « Vérifier sur une machine »). Image identique (0 pixel de différence sur le menu). | `game/Game.ts`, `main.ts`, `ui/bootTimeline.ts`, `ui/HudWarmup.ts`, `world/MapBvh.ts`, `world/GivreMap.ts`, `world/JungleMap.ts`, `world/YardMap.ts`, `world/GivreRenderOptim.ts`, `world/GivreFootprints.ts`, `effects/FastSkinnedBounds.ts`, `navigation/NavGrid.ts`, `weapons/LanceModel.ts`, `weapons/SpearViewmodel.ts`, `network/remote/RemoteWeaponController.ts`, `menu/CustomizePreview.ts`, `menu/WeaponIconRenderer.ts`, `cosmetics/astronaut/runtime/AstronautCosmetics.ts` |
| 240 Hz (9ᵉ passe : tir à la tête en dash, 240 → 175 FPS) | **Ni la 3D ni le ragdoll : la somme jeu + navigateur sur un seul thread.** À 244 Hz, une frame dure 4,1 ms, et tout passe par le thread principal : le JS du jeu (~3 ms au repos sur le PC gamer) **puis** le travail du navigateur (~1 ms : style, mise en page, peinture du HUD, envoi au compositeur). Au kill, le JS du jeu ne monte que de 0,2-0,35 ms ; c'est le HUD qui fait passer `Browser` à 2,5 ms de moyenne (8,3 ms sur la frame du kill) : 3,3 + 2,5 = 5,8 ms → 175 FPS. Corrigé : (1) **Classement** : il relisait l'état dessiné de ses lignes (`getComputedStyle`, `getBoundingClientRect`) entre ses propres écritures — à chaque kill (bots compris), 5 recalculs de style + 4 mises en page forcés au milieu du JS du jeu ; les lectures sont regroupées avant la première écriture, et il n'y en a plus quand rien n'anime. (2) **Médaille** : la couleur d'accent `--md`, héritée, et `#medal-display.hidden *` restylaient tout le badge (~58 éléments, dessins SVG compris) à chaque apparition et disparition ; `--md` n'est plus héritée (`@property`), elle est posée sur les 13 éléments qui la peignent, et le masquage vise la liste des parties animées : 57 → 40 éléments restylés à l'apparition, 57 → 18 à la disparition. (3) **Menu caché en jeu** : endormi (`content-visibility: hidden`) une fois son fondu fini — ses deux boucles infinies étaient recalculées à chaque frame de la partie ; sa sonde de ping (requête HTTP + réécriture du ping et du salon toutes les 5 s) ne tourne plus que menu affiché. (4) **Panneau de debug** : une ligne = un nœud texte, réécrite seulement si elle change (il réécrivait tout 15 fois par seconde : le panneau qui sert à mesurer coûtait lui-même). (5) **Cadavre** : le clone du personnage (SkeletonUtils, ~50-70 nœuds) est préparé pendant la protection d'apparition du bot et seulement remis à l'état courant au kill (même objet ; repli sur le clonage si le corps a changé de forme). (6) **Rendu** : une seule mise à jour des os par squelette et par frame (three.js recalculait deux fois chaque personnage qui projette une ombre) ; fusil à popcorn FP sans re-sélection de 4 programmes par frame. **Ce qui restait** : la somme elle-même — réglée à la 10ᵉ passe (« Le HUD dans son propre processus » plus bas). | `ui/LeaderboardHUD.ts`, `ui/leaderboard/*`, `hud.css`, `ui/MedalHUD.ts`, `ui/HudWarmup.ts`, `menu/MenuOverlay.ts`, `style.css`, `ui/DebugHUD.ts`, `ragdoll/CorpseCloneSpare.ts`, `bots/Bot.ts`, `bots/BotModel.ts`, `effects/SkeletonFrameDedupe.ts`, `effects/TwoPassTransparentSplit.ts`, `weapons/popcorn/PopcornShotgunWeapon.ts`, `game/Game.ts` |
| 240 Hz (10ᵉ passe : le HUD dans son propre processus) | **Le HUD ne passe plus par le thread du jeu.** Mesuré d'abord sur le PC gamer avec le prototype (`/perf/prototype-240hz.html`, Edge 155, RTX 2080 Super, 238 Hz, zoom 90 %) — même charge 3D et même HUD simulé dans trois architectures : tout sur le thread principal (comme le jeu jusqu'ici) **239 FPS au calme, 158 pendant les kills** (50 % de frames en retard, pire frame 20,8 ms) ; 3D dans un worker 240 / 237 ; **HUD dans une iframe isolée 240 / 240** (0 % de frames en retard, pire frame 4,4 ms ; l'iframe tourne bien dans son propre processus). C'est cette dernière qui est en place : le HUD vit dans `hud.html`, chargé dans une iframe `sandbox="allow-scripts"` posée sur le canvas (sans pointeur, jamais de focus). Son origine est opaque, donc Chrome / Edge (isolation des sites) la font tourner **dans un autre processus** : son style, sa mise en page, sa peinture et ses animations se font en parallèle du jeu, plus après lui. Le jeu ne touche plus au DOM du HUD : il appelle `hudHost.api` (les mêmes méthodes que les anciens widgets), qui copie à l'appel l'état utile en données simples (« vues ») et l'envoie en **une liste de commandes par frame** (`postMessage`). Dans l'iframe, le runtime du HUD construit les mêmes widgets, dans le même ordre, avec le même balisage et les mêmes CSS, applique les commandes dans l'ordre et rejoue le warm-up du HUD dans son propre document. **Repli automatique** sur le HUD dans la page (le même runtime, chaque commande appliquée à l'appel : le comportement d'avant) si l'iframe ne répond pas en 8 s, ne tourne pas dans son propre processus (vérifié au chargement), ne voit pas la même taille ni le même zoom que la page, ou cesse de répondre avant la fin de son warm-up ; **et pendant la partie**, si son processus plante ou se fige (aucune nouvelle depuis 3 s alors que la page du jeu, elle, dessine : l'iframe — que Chrome remplacerait par un rectangle gris sur tout le jeu — est retirée et le HUD reconstruit dans la page avec son dernier état) ou si elle ne voit plus la même taille ou le même zoom que la page. En `npm run dev`, le HUD reste dans la page par défaut (`?hud=frame` pour l'iframe) ; `?hud=inline` force l'ancien chemin partout. Ligne `HUD:` du panneau de debug. Rendu : identique au pixel dans la page ; dans l'iframe, seul l'anticrénelage de quelques bords d'éléments animés diffère (≤ 22 niveaux sur 255, sur ≤ 1,2 % des pixels). | `hud.html`, `src/hud/protocol.ts`, `src/hud/host/*`, `src/hud/runtime/*`, `src/hud/hudMarkup.html`, `src/hud/hudFrame.css`, `index.html`, `style.css`, `ui/*HUD.ts` (types), `ui/displayFrames.ts`, `game/Game.ts`, `main.ts`, `combat/HitFeedbackManager.ts`, `killstreaks/mole/MoleStrikeVFX.ts`, `menu/MenuOverlay.ts`, `ui/DebugHUD.ts`, `vite.config.ts`, `vercel.json` |
| GPU du portable (11ᵉ passe : mesurée sur la vraie carte graphique) | **La cause des 30-40 FPS du portable : le travail GPU de chaque image partait trop tard, et des passes / clears plein écran inutiles le gonflaient.** Mesuré dans un vrai navigateur sur l'Intel Iris Xe (Givre LOW, 1920 × 928 ; détails dans « La cause racine » plus bas). (1) `gl.flush()` après la passe monde et en fin d'image : sans lui, le GPU attendait une partie de l'image puis recevait tout d'un bloc — 36 → 60 FPS sur la même machine, +14 % quand le GPU est la limite. (2) Un seul clear profondeur + stencil de la cible HDR du monde au lieu de deux clears complets (le dôme du ciel, au plan lointain, écrit tous les pixels libres) : à 2560 × 1238, 49 → 57 FPS. (3) Ciel dessiné après les opaques au lieu de remplir tout l'écran en premier (Givre, Jungle, Yard). (4) Plus aucun clear avant les passes plein écran (sortie sRGB, FXAA), qui réécrivent chaque pixel de leur cible. (5) Les 2 lumières ponctuelles du pool FX, toujours éteintes (intensité 0) mais calculées dans chaque pixel éclairé, retirées. Même image, au bit près (vérifié au banc). `?diag=noflush` pour comparer. | `effects/FlushPass.ts`, `effects/SkyCoveredRenderPass.ts`, `effects/FullscreenPass.ts`, `effects/FXLightPool.ts`, `world/GivreSky.ts`, `world/skyDome.ts`, `world/SpaceSky.ts`, `world/YardSky.ts`, `game/Game.ts`, `ui/perfDiag.ts` |
| HUD du portable (12ᵉ passe : 1080p à 45-49 FPS en partie) | **La respiration du portrait du haricot était re-rastérisée à chaque frame** (un `scale` infini sur un `<svg>`, sans `will-change`) : un travail fait dans le processus GPU du navigateur, à côté du WebGL du jeu, qui faisait rater le rafraîchissement alors que le jeu tenait dans l'image. `will-change: transform` : 60 FPS, 0 image en retard, même image (A/B sur le portable). | `hud.css` (`.buddy-art`) |
| GPU (13ᵉ passe : chaîne de post-traitement de Givre) | **Variantes économes en mémoire de la sortie sRGB + FXAA** (image intermédiaire 8 bits, sortie faite par le FXAA, cible du monde sRGB 8 bits, rendu direct) : aucune n'est identique au bit près, le défaut ne change pas ; chacune derrière `?diag=` avec son écart mesuré, à mesurer sur la vraie carte avant tout choix. | `effects/GivrePostChain.ts`, `effects/OutputFXAAPass.ts` |
| GPU (14ᵉ passe : overdraw de la carte) | **Le matériau de la carte était calculé 2,1 fois par pixel où on la voit** (mesuré par pixel et par lot, 14 vues : `tools/perf/overdraw-bench.mjs`) — dans un lot, les triangles arrivent dans l'ordre du BVH, pas d'avant en arrière, et vers la plaine le sol de la carte continue sous le fond. **Pré-passe de profondeur** (`?diag=prepass`, **désactivée par défaut** en attendant la mesure sur l'Iris Xe) : les grands triangles de la carte (≥ 0,1 m², ≈ 26 k sur 134 k) et le fond dessinés d'abord en profondeur seule, en 2 draws ; le matériau de la carte n'est plus calculé que 1,02 fois par pixel (2,13 → 1,02 : −52 % de fragments calculés). Même image au bit près (même calcul de position, `invariant gl_Position` ; 0 pixel de différence au banc, LOW et HIGH), **vérifiée au chargement sur le GPU du joueur** (sinon coupée). Évalués et écartés : réordonner les triangles ou les lots (−5 à −24 %), faces simples partout ou par solide (changent des pixels ; `?diag=percomponent` reste une expérience). | `world/GivreDepthPrepass.ts`, `world/GivreRenderOptim.ts`, `world/GivreMap.ts`, `world/GivreConfig.ts`, `game/Game.ts`, `ui/perfDiag.ts`, `ui/GpuTimer.ts`, `tools/perf/overdraw-bench.mjs`, `tools/perf/overdraw-probe.js`, `tools/perf/prepass-ab.mjs` |
| CPU par image (15ᵉ passe : simulation + envoi du rendu) | **Moins de travail par image, résultat identique au bit près** (mesures plus bas). (1) **HUD** : le jeu renvoie à chaque frame l'état d'affichage de chaque widget — plaque d'arme visible / cachée et ses munitions, puces du dash et de la lance, combo, visée, bannière « KNOCKED DOWN », les deux `flush` des pulses — : 16 des 18 commandes d'une frame, au repos comme en combat, copiées, postées au processus du HUD et appliquées là-bas pour rien. Une commande identique à la dernière **envoyée** pour son widget n'est plus envoyée : c'est un no-op pour le widget (chacun compare ses arguments avec les derniers appliqués) ; après un changement de visibilité d'une plaque ou de la lance, la mise à jour suivante part toujours (le widget a pu oublier la sienne). Jamais sautés : ce qui avance avec le delta (`combat.update`, nombres de dégâts) et les événements (tirs, impacts, kills…). L'état rejoué au HUD reconstruit après une chute de l'iframe est le même (dernière commande de chaque clé). (2) **Uniforms** : les caches de valeurs d'uniform de three.js étaient tous des tableaux « génériques » pour V8 (un seul uniform booléen suffit à les faire tous basculer) : chaque nombre écrit allouait un objet — ~30 Ko par frame avec 8 bots, un quart des allocations. Ils redeviennent des tableaux de doubles bruts (mêmes valeurs, mêmes appels GL), écrits par une copie des setters de three (r185 : mêmes comparaisons, mêmes appels) — ceux de three, optimisés par V8 sur des tableaux génériques, rendaient génériques les tableaux qu'ils écrivaient. Les tableaux d'uniforms (matrice d'ombre du soleil, sonde de lumière…) n'avaient aucun cache : renvoyés à chaque changement de programme, soit à presque chaque draw avec le tri avant → arrière (45 à 70 `uniformMatrix4fv` de trop par frame à 8 bots). Chacun garde maintenant la dernière valeur envoyée (telle que le GPU la reçoit, en float32) et n'est renvoyé que s'il change. (3) **Matrices** : la passe de `renderer.render` ne recalcule plus la carte (140 nœuds animés recomposés à chaque passe, déjà calculés par la passe de Game.frame juste avant) ni les bras + l'arme FP (calculés, forcés, par `syncCamera` juste avant) ; la passe de Game.frame saute en plus les bots morts en attente de réapparition (dès leur 3ᵉ frame de mort : rien ne les anime ni ne les déplace). Vérifié à chaque frame d'un combat : chaque matrice sautée est identique au bit près à un recalcul forcé. `?diag=nohudskip`, `nouniformcache`, `nofreshskip` remettent l'ancien chemin. | `hud/host/HudProxies.ts`, `effects/UniformCacheKinds.ts`, `effects/ProgramPin.ts`, `effects/matrixFresh.ts`, `world/MapBatching.ts`, `weapons/viewmodel/ViewmodelSystem.ts`, `bots/Bot.ts`, `ui/perfDiag.ts`, `game/Game.ts` |
| HUD au repos, aux tirs et au kill (16ᵉ passe : l'animation du Bean Buddy coûtait 15 FPS au portable) | **Plus aucune peinture ni rastérisation par image dans le HUD au repos ; aux événements, ce qui change seulement.** Mesuré par le chef sur l'Iris Xe (build de production, 1080p) : l'attente du Bean Buddy seule faisait tomber le jeu de 60 à 45-46 FPS (corrigé en production par `will-change: transform` sur le portrait). Au banc image par image (`tools/perf/hud-frame-bench.mjs`, le vrai document du HUD dans son iframe), avant : une image principale, ~6,4 tuiles rastérisées et 2 passes hors écran **à chaque image**, sans que rien ne bouge ; après : 0,02 image principale et 0,02 tuile (le chrono, une fois par seconde), aucune passe hors écran, dans chaque état durable (humeurs, dash, K.O., plaques au repos / basses / en recharge, combo, fin de partie). (1) Le portrait du Bean Buddy en **calques SVG empilés** : ses animations (feuilles, yeux, goutte : des enfants SVG ; respiration : la racine `<svg>`) tournaient sur le thread principal — chaque partie animée a maintenant son propre `<svg>`, dans une `<div>` que le compositeur anime seul ; `will-change: transform` sur `.buddy-art`. (2) `clip-path` / `mask` sortis des éléments animés (chevrons du dash : 2 passes hors écran par image ; étincelles du soin, anneau de recharge) : sur un enfant immobile. (3) La vague du réservoir du FAMAS glisse par `transform` au lieu d'un `background-position` repeint. (4) Bannière K.O. centrée par `translate` (un `translateX(-50%)` dans ses images clés la gardait sur le thread principal). (5) Médaille : l'ombre des pans du ruban sans `filter` (tout le ruban était repeint et re-rastérisé à chaque image de son entrée, ~30 fois par kill). (6) Le document du HUD ne demande plus d'image quand rien ne change (boucle `requestAnimationFrame` permanente → à la demande). Contre le build de production : en tirant, 3,3 → 1,3 passes par image et « rendu » du HUD 2,9 → 2,5 ms par image ; plus de mise en page par image. Contre l'ancien code : tirs 7,0 → 0,5 tuile par image, kill 6,1 → 1,2, dégâts 4,9 → 0,7, recharge 6,5 → 0,2. La peinture 3D des plaques (~3 ms de GPU par image en tirant sur l'Iris Xe) est inchangée par défaut : `?diag=paintss150` / `paintss100` / `paintfps30` pour la juger sur le vrai GPU. Même rendu à l'anticrénelage près (contour du portrait, bout de la vague du FAMAS, ruban de la médaille pendant qu'elle s'affiche : détails plus bas). `?diag=hudanim` remet l'ancien CSS, l'ancien portrait et l'ombre filtrée, `?diag=nohudidle` l'ancienne boucle. | `hud.css`, `hudWeapons.css`, `ui/hudIcons.ts`, `ui/CombatHUD.ts`, `hud/runtime/frameClock.ts`, `hud/runtime/frameEntry.ts`, `hud/runtime/HudRuntime.ts`, `hud/host/HudHost.ts`, `ui/framePulse.ts`, `ui/perfDiag.ts`, `ui/paint/*`, `tools/perf/hud-frame-bench.mjs` |
| Image du kill (17ᵉ passe) | **Le premier dessin d'un cadavre ne fait plus, dans l'image du kill, le travail de « première fois » de three.js** (mesures plus bas). Ce dessin créait les textures d'os des squelettes du cadavre (2 à 4 : tableau, DataTexture, `createTexture` + `texStorage2D` + envoi) et initialisait chaque nouveau clone de fondu (premier cadavre de chaque bot, et chaque cadavre d'un bot peint : les clones de la peinture partent avec leur cadavre) : `material.clone()`, uniforms clonés, programme cherché, lumières branchées. C'est fait maintenant sur une image ordinaire de la vie du bot, un bot par image, à la fin de la frame juste après le rendu (jamais dans l'image qui le demande, un tir de peinture par exemple) : le clone de cadavre préparé reçoit ses textures d'os, et CorpseManager garde un clone de fondu initialisé (`renderer.compile` sur les mailles mêmes du clone préparé, la cible de la passe monde liée, les deux looks : fondu puis vie opaque) pour chaque matériau visible dont la réserve est vide. Au kill, ce clone est remis à l'état de la source par `copy()` + les mêmes réglages : exactement ce que `source.clone()` donnerait à cet instant (test propriété par propriété), et three redérive son programme au premier dessin comme pour un clone neuf. Même image (vérifiée au banc au kill et pendant le fondu). Reste dans l'image du kill : la vérification du programme de ces clones, le VAO d'une géométrie jamais dessinée avec le programme de fondu (pas de dessin d'avance : aucun draw de plus en jeu), les envois d'os de toute image. `?diag=nokillprep` remet l'ancien chemin. **Expérience, désactivée par défaut** : `?diag=programsort` trie les opaques par programme puis matériau (proche → lointain dans un matériau) au lieu du tri avant → arrière, pour la pré-passe de profondeur de la carte (`?diag=prepass`, branche gpu-overdraw) : un tiers de `useProgram` en moins, mais à profondeur exactement égale quelques pixels peuvent changer (1 à 9 pixels dans 6 des 68 vues comparées au banc). | `effects/KillPrep.ts`, `ragdoll/CorpseManager.ts`, `ragdoll/CorpseCloneSpare.ts`, `bots/BotModel.ts`, `bots/Bot.ts`, `world/GivreRenderOptim.ts`, `ui/perfDiag.ts`, `game/Game.ts` |
| Fin de partie (18ᵉ passe : écran de fin) | **Plus rien de neuf dans l'image où le chrono tombe à 0:00, plus de monde dessiné sous l'écran de fin.** Mesuré sur le portable : une image de 133-166 ms à la fin du match, puis 52-54 FPS sur l'écran de fin. L'écran de fin créait son contexte WebGL, compilait ses programmes (9 au premier rendu de l'intro, 2-3 en pleine intro), extrudait son titre, injectait sa feuille de style, chargeait ses polices, copiait toute l'image (8 Mo) pour en tester 64 pixels et stylait / mettait en page ses résultats deux fois — tout dans cette image ; puis le jeu redessinait le monde gelé sous l'instantané qui le cache, et l'intro dessinait deux quads plein écran à opacité 0, à chaque image. Maintenant : le premier usage est fait dans les temps morts du menu et gardé d'un écran de fin au suivant (contexte, programmes et numéros de shaders, géométrie des lettres), le monde n'est plus dessiné dès que l'instantané est prouvé opaque, les draws sans contribution sont sautés, 64 pixels lus au lieu de toute l'image, la vitre construite en tableaux typés (au bit près), l'unité des résultats posée avant leur contenu. Même image (0 pixel de différence : intro 3D à 22 instants, instantané, écran composé à 8 instants). Détails, chiffres et interrupteurs (`?diag=oldendscreen`…) dans « La fin de partie » plus bas. | `endscreen/Intro3D.js`, `endscreen/EndScreen.js`, `endscreen/UI.js`, `match/MatchEndController.ts`, `match/EndScreenPerf.ts`, `game/Game.ts`, `main.ts`, `ui/perfDiag.ts` |
| Qualité HIGH | Filtrage anisotrope ×8 sur les lightmaps (sols et murs nets en incidence rasante). | `game/GraphicsQuality.ts`, `world/GivreMap.ts` |
| GPU (19ᵉ passe : shader de la carte de Givre) | **Le shader de la carte ne calcule plus que ce que Givre utilise, même image au bit près.** La carte est dessinée par le `MeshStandardMaterial` de three (matériaux « uber », lampes, montagnes) : le modèle PBR général, qui évalue pour chaque pixel des termes nuls sur cette carte. `GivreMapMaterial` les retire au chargement, matériau par matériau, seulement si les données réelles le permettent (`mapShaderEligibility` : sinon l'option tombe pour ce matériau, jamais une image fausse) : (1) la lumière d'environnement (IBL : deux lectures de la table DFG, deux `computeMultiscattering`, ~60 instructions) — Givre n'a pas d'env map, ce terme était multiplié par 0 ; (2) le métal, 0 sur tous les sommets (plus d'attribut ni de varying `aMetalness`, les mélanges deviennent des constantes) ; (3) une seule coordonnée pour les deux lightmaps (même `uv`, même transformation) ; (4) le soleil seulement là où il éclaire : une face tournée à l'opposé du soleil (N·L ≤ 0) ne lit plus l'ombre (5 lectures PCF, 5 cos + 5 sin) ni le BRDF ; un pixel entièrement à l'ombre du soleil (facteur exactement 0 : intérieurs, dessous des toits) ne calcule plus le BRDF — le shader d'origine y ajoutait exactement 0. Banc (13 poses : spawn, les 9 points de vue de la carte, face au soleil bas, plongée sur la cour, verglas ; 960 × 540) : **0 pixel de différence** (RGBA) en LOW (FXAA) comme en HIGH (MSAA 4×). Le soleil n'est plus calculé sur 76 à 98 % de l'écran dans les salles et sous les toits (spawn 98 %, chaufferie 76 %, liaison sud 88 %), 2 à 47 % dehors. Au banc (passe monde seule, SwiftShader : temps CPU du processus GPU, médiane de 5 rendus) : **−15 %** au spawn en LOW, −11 % à la chaufferie, −10 % au couloir ouest, −3 % dans la cour centrale (presque tout l'écran au soleil) ; en HIGH −9 % au spawn, −5 % dans la cour. Un GPU logiciel paie chaque instruction : sur la vraie carte le gain sera plus petit (l'ombre du soleil entière coûtait 0,24 ms par image à l'Iris Xe, 11ᵉ passe) — à lire sur la ligne `GPU` (`monde`) avec et sans `?diag=nomapshader` (le shader d'origine) ; une ligne `[CARTE]` dans la console dit lequel tourne. Partie quasi exacte en option, **à décider** (`?diag=mapshaderfast`) : sans la compensation de diffusion multiple du soleil (au plus 6,6·10⁻⁵ en linéaire : moins d'un quart de niveau, même près du noir) et la rotation du disque PCF avec un seul cos / sin au lieu de cinq. Mesuré : au plus **1 niveau sur 255** sur 0,10 % des pixels avant l'anticrénelage (LOW et HIGH) ; en LOW, le FXAA élargit une petite partie de ces écarts (0,12 % des pixels, dont 98 % d'un niveau, mais jusqu'à 46 niveaux sur ~80 pixels de bords sur 6,7 millions). Au banc, elle gagne 1 à 10 points de plus que le défaut (chaufferie −21 % au lieu de −11 %). Entre les deux, `?diag=mapshaderao` (exact au banc, **à mesurer** avant d'en faire le défaut) : l'AO rangée dans l'alpha de la lightmap émissive, empaquetée au chargement — une lecture de texture de moins par pixel, 0 pixel de différence (13 poses, LOW et HIGH), 3 à 9 % de plus au banc ; `mapshaderfast` la comprend. Détail et risques : « Le shader de la carte, terme par terme » plus bas. | `world/GivreMapMaterial.ts`, `world/GivreMap.ts`, `ui/perfDiag.ts`, `tools/perf/map-shader-check.mjs` |

### Bugs corrigés au passage

- **Goofy Basket invisible** sur un bot (ou un joueur distant) dont c'était la *première* arme : le contrôleur démarrait « équipé Goofy Basket » sans rien afficher, et le premier `setWeapon` identique était ignoré (bras en position de tenir le ballon, mains vides). `network/remote/RemoteWeaponController.ts`
- **Preset LOW** : les armes tenues par les bots projetaient leur silhouette dans l'ombre cuite au chargement (ombre d'arme figée au point d'apparition) — les personnages, eux, ne projetaient déjà rien. `network/remote/RemoteWeaponController.ts`
- **Preset LOW, warm-up** : l'ombre était cuite *après* les rendus de warm-up. Avant sa première cuisson, three r185 lie une texture d'ombre factice sans mode de comparaison au `sampler2DShadow` → `GL_INVALID_OPERATION: Mismatch between texture format and sampler type` : WebGL rejetait **tous** les draws éclairés du warm-up (~2 300 erreurs au chargement, les 256 premières dans la console). Les shaders étaient liés mais jamais exécutés, et ANGLE / D3D11 finit certains shaders au premier vrai draw : ce travail tombait en pleine partie. L'ombre est maintenant cuite avant le warm-up. `game/Game.ts`
- **Saccades à la première frame d'une arme en main** : l'arme principale de l'équipement, que les bras FP tiennent dès JOUER, n'était pas montée pendant le warm-up (seule la Brick Maul l'était) — ses programmes de la scène FP (lumières FP, sans brouillard ni ombre) compilaient à la première frame de jeu, juste après le vol de caméra (4 programmes pour le Popcorn Shotgun ; même chose en multijoueur). Même chose pour une arme choisie après le chargement, dans le menu d'équipement ou le menu pause (Hex Sniper : 1 programme, Water FAMAS : 2), et pour le Paintball de toute façon : le tampon de couleurs des billes du chargeur, qui fait partie du programme, n'était créé qu'à la première mise à jour de l'arme. Enfin, la peinture des plaques d'arme (Popcorn, Paintball) créait son contexte WebGL et compilait son shader de raymarching à la première frame de jeu. L'arme de l'équipement est montée pour le warm-up puis rendue (JOUER l'équipe comme avant), les autres armes principales passent dans la scène FP le temps des rendus de warm-up, les billes ont leurs couleurs dès leur création, et la peinture compile pendant le chargement : **0 programme compilé après l'écran de chargement** (88 → 96 au chargement), pendant un combat scripté (kills, tirs, recharge, dégâts, mort, réapparition) comme en changeant d'arme (les 6 armes principales et les 2 de mêlée tour à tour, en partant du Popcorn ou du Paintball). `game/Game.ts`, `weapons/*/*Weapon.ts`, `weapons/paintball/PaintballHopper.ts`, `ui/paint/PaintGL.ts`, `ui/paint/PaintLayer.ts`, `main.ts`
- **Baisser le nombre de bots pendant un combat** (menu Échap) cassait la partie : un bot qui visait (ou venait d'être touché par) un bot retiré lisait la position de son corps Rapier déjà libéré — panique WASM, puis « recursive use of an object… » à chaque frame suivante (plus de physique, jeu figé). Reproduit au banc dès le premier essai ; un bot retiré devient non ciblable et garde sa dernière position (0 erreur sur 6 essais). `bots/Bot.ts`, `bots/BotAI.ts`

## Règles pour la suite

1. **Un objet répété = de l'instancing** (loot, projectiles, décors répétés). Jamais un clone de GLB multi-matériaux par instance.
2. **Matériaux de carte** : si deux matériaux ne diffèrent que par des constantes, ils seront fusionnés automatiquement (uber). Un matériau patché par `onBeforeCompile`, transparent ou texturé différemment reste à part — exprès.
3. **Armes TP** : une pièce = un objet animable, mais garder le même matériau entre pièces (vertex colors) pour qu'elles soient fusionnées. Une pièce dont la géométrie est modifiée à la volée (positions) ne doit pas partager le matériau des pièces rigides.
4. **Nom `Potato` du corps** : contrat (peinture, eau, tenue astronaute). Les autres morceaux du perso n'ont plus de nom propre (`Potato_Details`).
5. **Toute animation de carte** passe par le mixer + `batchAnimatedMeshes` ; les objets qui bougent tout seuls doivent porter `userData.dynamicShadow = true` pour rester hors du cache d'ombre.
6. **Nœuds de carte gelés** : un nœud de carte déplacé par du code (position / rotation / échelle écrites à l'exécution) doit être passé dans la liste `animated` de `freezeStaticTransforms` — sinon il ne bougera pas. Un nœud dont on écrit `matrix` à la main doit mettre `matrixWorldNeedsUpdate = true` (la racine de la scène ne force plus tout le graphe).
7. **Un matériau = un type de mesh** : ne pas partager une même instance de matériau entre un mesh skinné et un mesh rigide (ou instancié) dessinés dans la même frame — three.js re-sélectionne le programme à chaque alternance. Cloner (une fois, en cache) plutôt.
8. **Transparent + double face** = deux draws et deux re-sélections de programme par frame. Si l'ordre de dessin n'a pas d'importance (blending additif sans écriture de profondeur, géométrie plate), mettre `forceSinglePass = true`.
9. **Pièces fusionnées en mesh skinné** (armes TP, décor animé) : garder une échelle uniforme. Le skinning de three.js transforme les normales par la matrice de la pièce, pas par son inverse transposée : une échelle non uniforme (au repos ou animée) fausserait l'éclairage — sauf si les normales sont alignées sur les axes de l'échelle (cas des cordes du Frisbee et des ondes de bulles de Yard aujourd'hui).
10. **Cache d'ombre statique** : un caster dont l'ombre ne se résume pas à sa géométrie (alphaTest + texture, displacement, plans de coupe, `customDepthMaterial`) ou une carte avec plusieurs lumières qui projettent des ombres restent automatiquement en ombre dynamique — pas de cache dans ce cas.
11. **Effets éphémères** : ne pas `clone()` + `dispose()` un matériau à chaque tir / impact — réutiliser les meshes (pool). `ProgramPin` évite la recompilation, mais pas l'allocation ni l'upload.
12. **Nouveau matériau ou variante** (patch `onBeforeCompile`, clé de cache, transparence, cible de rendu) : l'ajouter au warm-up (`Game.warmUpRendering`), dans l'état exact où il sera dessiné en jeu — sinon sa compilation tombe au premier usage, en plein combat. Vérification : `perfDebug.programs()` avant / après une partie (DEV) ne doit pas bouger. Un **attribut créé plus tard** change aussi le programme (`instanceColor` créé par le premier `setColorAt`, par exemple) : le créer dès la construction. **Nouvelle arme principale** : un modèle FP non monté n'est dans aucune scène — lui donner un `fpWarmRoot` et l'ajouter à la liste du warm-up.
13. **Jamais de « reflow » pour relancer une animation CSS** (`classList.remove` → lecture de `offsetWidth` → `classList.add`) dans le code de jeu : chaque lecture force le style et la mise en page de toute la page, au milieu de la frame. Deux keyframes identiques sous deux noms, alternées par une classe : `replayAnim` (`ui/hudKit.ts`) pour un événement ponctuel, `FramePulse` (`ui/framePulse.ts`) pour ce qui peut tomber plusieurs fois par frame (tirs, impacts, messages réseau).
14. **Un élément du HUD dont le JS réécrit l'opacité ou la transformation à chaque frame** doit avoir sa propre couche (`will-change: opacity` / `transform`) — sinon chaque changement re-rastérise toute la couche du HUD (plein écran pour une vignette).
15. **Nouvel état rare du HUD** (médaille, bannière, écran, effet CSS coûteux : dégradé conique ou masqué, ombre floue, texte détouré, filtre SVG) : l'ajouter à `warmUpHud` (`ui/HudWarmup.ts`) — sinon son premier dessin tombe au premier kill / dégât.
16. **Second contexte WebGL ou canvas animé dans le HUD** (peinture de plaque, mécanisme du Frisbee) : rendre à la densité de pixels réelle à l'écran (taille CSS × zoom du HUD × `devicePixelRatio`), pas à une échelle fixe (rendu sur-échantillonné × 2, mais pas plus). Son temps GPU ne fait pas partie de celui du jeu : le mesurer à part (la peinture des plaques s'affiche en « peinture HUD » sur la ligne `GPU`).
17. **Maillage skinné instancié en cours de partie** (arme, accessoire, cadavre, clone `SkeletonUtils`) : il doit avoir une `boundingSphere` **avant** son premier dessin — sinon three.js la calcule en re-skinnant tous ses sommets sur le CPU, une fois par clone. La poser sur le modèle source (`adoptSkinnedBounds`, `effects/skinnedBounds.ts`) : les clones la copient.
18. **Nouvel état du HUD dans le warm-up** (`ui/HudWarmup.ts`) : l'ajouter à la situation où il apparaît vraiment, avec les classes, textes et jauges (scaleX) exacts du code de jeu — un état dessiné sous une autre combinaison (autre filtre, autre classe gagnante, élément tourné ou à l'échelle) compile d'autres shaders. Ne jamais raccourcir la tenue des états (`holdUntilDrawn`) : un état retiré avant que le GPU l'ait dessiné ne chauffe rien.
19. **240 Hz** : tout ce qui change à chaque frame dans le HUD (texte, barre, canvas) se paie dans le processus GPU de Chrome, qui exécute aussi les appels WebGL du jeu — 4,2 ms par frame pour tout. Un élément animé par JS → sa propre couche (règle 14) ; un canvas animé (WebGL) → affiché tel quel, **jamais** recopié dans un canvas 2D par `drawImage` à chaque frame.
20. **Couches géantes** : un élément composé (`will-change`, animation) a la taille de TOUT ce qu'il peint, débordements compris (un dégradé de 160 vmax en 1440p = 4 552 px de côté, rastérisé sur tout l'écran). Ajuster la boîte à la partie visible du dessin.
21. **Rapier dans le code appelé à chaque frame** : `translation()`, `rotation()`, `linvel()`, `angvel()`, `computedMovement()` prennent un objet cible — le passer (sinon un vecteur alloué par appel). Les requêtes sans filtre ne rappellent plus le JS (`physics/PhysicsWorld.ts`) : n'en passer un que s'il filtre vraiment.
22. **Élément du HUD qui apparaît à chaque kill** (médaille, sticker, tag) : le cacher par `opacity` sur sa propre couche (`will-change`), jamais par `display: none` (ses couches et sa rastérisation seraient jetées puis refaites à chaque apparition) ; couper ses animations pendant qu'il est caché. **Jamais deux animations de `transform` sur le même élément** (pop + rotation…) : Chrome ne les compose pas, elles tournent alors sur le thread principal à chaque frame. Une sur l'élément, l'autre sur un enfant. Pas de `mask` CSS sur un élément qui tourne en continu : mettre le fondu dans un SVG. Vérifier avec `tools/perf/medal-bench.mjs` (ligne « NOT composited »).
23. **Nouveau fichier chargé au démarrage** (GLB, texture, JSON) : le demander dans `preloadGameAssets` (`game/Game.ts`) ou dans le `preload()` de la carte — tout part en même temps, au début du chargement. Un GLB utilisé à plusieurs endroits passe par **un** chargeur mémoïsé qui donne une copie à chacun (comme `weapons/LanceModel.ts`), jamais un `GLTFLoader` par utilisateur : une seule analyse, un seul téléversement des textures.
24. **Rien entre la fin du warm-up et le menu**, et rien dans le chargement qui ne serve ni au menu ni à la première frame de jeu : un 2ᵉ contexte WebGL, des icônes, des BVH, du debug se créent à leur première utilisation ou dans les temps morts du menu (`world/MapBvh.ts`, `startWeaponIcons`). Ce qui compilerait un shader ou dessinerait quelque chose pour la première fois **en jeu** reste au chargement (règles 12 et 15) : c'est le prix d'une partie fluide dès la première frame.
25. **Calcul déterministe du chargement** (traitement de géométrie, grille, hachage) : l'accélérer seulement à résultat identique au bit près (test d'équivalence contre l'ancienne version), ou le mettre en cache sous une signature de **toutes** ses entrées (`NavGrid` : colliders, bornes, code de `build()`, version de Rapier — modifier `build()` invalide le cache tout seul ; changer le format des données = changer `CACHE_FORMAT`).
26. **Lire l'état dessiné dans le HUD** (`getComputedStyle`, `getBoundingClientRect`, `offsetWidth`…) : toutes les lectures **avant** la première écriture de la mise à jour, et seulement quand une animation est en cours (au repos, la valeur est connue : la poser). Une lecture après une écriture force un recalcul de style et une mise en page de toute la page au milieu du JS du jeu (`ui/LeaderboardHUD.ts`).
27. **Un menu caché ne tourne plus** : timers, sondes réseau et réécritures arrêtés par `hide()`, relancés par `show()` ; le calque est endormi (`content-visibility: hidden`) une fois le fondu fini. Une boucle infinie dans un menu doit s'arrêter quand il est caché.
28. **Propriétés personnalisées CSS** : une variable posée sur un conteneur est héritée par tout son sous-arbre — la changer restyle tous les descendants. Pour une valeur changée à chaque événement (couleur d'accent…), la déclarer `@property … { inherits: false }` et la poser sur les éléments qui l'utilisent. Pas de sélecteur universel (`.hidden *`) sous une classe basculée : lister les éléments visés.
29. **Nouvelle passe de rendu d'une frame de jeu** : la mettre dans la portée `inSkeletonFrame` (`effects/SkeletonFrameDedupe.ts`), sinon ses squelettes sont recalculés une fois de plus ; ne rien modifier aux os dans cette portée (ils sont définitifs pour la frame).
30. **Travail de la frame d'un kill** : ce qui peut se préparer avant (le clone du cadavre) se prépare dans une frame calme, avec un contrôle qui vérifie que la préparation correspond toujours au corps (`CorpseCloneSpare.matches`) et un repli sur l'ancien chemin.
31. **Le jeu ne touche jamais au DOM du HUD.** Tout passe par `hudHost.api` (`src/hud/host`). Une nouvelle information à afficher = une nouvelle commande dans `src/hud/protocol.ts`, avec des **données seulement** (nombres, chaînes, booléens, objets et tableaux simples — jamais un objet vivant du jeu, une fonction, une classe ou un élément DOM), copiées à l'appel par le proxy (`HudProxies.ts`) et appliquées par `src/hud/runtime/HudRuntime.ts`, **et sa ligne dans `STATE_KEY`** (`HudHost.ts`, vérifié par TypeScript) : un **état** (ce qu'elle laisse à l'écran, rejoué au HUD reconstruit dans la page si l'iframe tombe en pleine partie) ou un **événement** (un kill, un impact, une médaille : perdu avec l'iframe). Un widget lit une **vue** (`HealthView`, `AmmoView`…), pas l'objet du jeu.
32. **Nouveau widget du HUD** : construit dans `HudRuntime.init` (l'ordre de construction = l'ordre d'empilement), son balisage dans `src/hud/hudMarkup.html`, sa feuille de style liée par `hud.html` **et** par `index.html` (le HUD dans la page reste le repli) ; ses états rares dans le warm-up (règles 15 et 18), qui tourne dans le document du HUD.
33. **Le document du HUD a une origine opaque** : pas de `localStorage` ni de cookies (les réglages viennent de la page par commande, comme `crosshair.settings`) ; ses scripts, CSS et polices sont des requêtes CORS (`vercel.json` : `Access-Control-Allow-Origin` sur `/assets/*`). Il ne reçoit jamais d'entrée (clavier, souris, focus) : ce qui réagit au joueur reste dans la page du jeu. Ne jamais masquer `#hud-frame` (`display` / `visibility`) : le HUD masque son propre contenu.
34. **Mesurer le HUD** : la ligne `HUD:` donne où il tourne (`iframe isolée` ou `dans la page (raison)`), les images que son document dessine par seconde (à la demande : ~1 au repos) et son travail par frame (JS des commandes, rendu du navigateur par image dessinée) ; `Browser:` est maintenant celui de la page du jeu seule. `?hud=inline` compare avec l'ancien chemin. `tools/hud-preview/runtime-harness.mjs` compare l'iframe, la page et l'ancien HUD pixel par pixel.
35. **Nouvelle option graphique** (page SETTINGS) : sa valeur dans `GraphicsValues` (`settings/GraphicsSettings.ts` : presets, validation, libellé dans `settings/labels.ts`), son application dans `Game.applyLiveValues` — **en direct seulement si elle ne change aucun programme** (taille, échantillons, visibilité, paramètre de texture, uniform) ; sinon elle va dans `reloadChanges` (« Apply & reload »). Une option qui active / coupe une passe ou une variante (FXAA ⇄ MSAA) : les deux variantes compilées au chargement (`warmAlternateOutput`), vérifié par `tools/perf/settings-page-check.mjs` (aucun programme compilé par un changement en direct). Low et High restent **exactement** les anciens LOW et HIGH (`scripts/test-graphics-settings.mts`). L'interface du jeu est en anglais : libellés dans `settings/labels.ts`, en casse normale (les majuscules viennent du CSS).
36. **Détection automatique** : elle juge sur les **intervalles entre images** sous charge (+30 % de pixels **sur tout GPU, puces intégrées comprises** — `AUTO_TUNE.integratedMarginPixels` ; pas de baisse de l'image sans nécessité absolue : ce que le menu ne voit pas est le travail du garde, règle 38 ; `?diag=tunemargin50` = la variante +50 %, l'A/B à essayer si le garde descend trop souvent sur le terrain), jamais sur des requêtes de chronométrage GPU (elles comptent les temps morts du GPU et font flusher Chrome : elles changent ce qu'elles mesurent). Une option ne rejoint l'échelle (`settings/AutoTune.ts`) que si elle s'applique en direct, à sa place dans l'ordre « le moins visible d'abord », et jamais sous le plancher (l'ancien LOW). Changer la logique de la détection = incrémenter `AUTO_TUNE_VERSION` (chaque joueur « Auto » est mesuré à nouveau, une fois).
37. **Anciennes clés** `beanzo.graphicsQuality` / `beanzo.fpsCap` : toujours lues et écrites (pont avec un build plus ancien et avec les scripts de banc) — une valeur écrite par quelqu'un d'autre depuis le dernier passage du jeu est reprise au chargement suivant (`adoptLegacyChanges`). Les réglages du joueur vivent dans **un** enregistrement, `slideio.settings`.
38. **Garde « Auto » en partie** (`settings/AutoGuard.ts`) : tous ses seuils sont dans `AUTO_GUARD`, chacun avec sa raison ; il ne juge que le **jeu au premier plan** (pointeur verrouillé, page visible, partie en cours, pas de détection) et ne fait **jamais remonter l'image au cours d'une session** — ne pas ajouter de « remontée quand ça va mieux » en pleine partie : les images d'un barreau plus bas ne disent rien du barreau au-dessus (un écran vsync montre 60 FPS à 10 ms comme à 16 ms), c'est l'oscillation assurée. La seule remontée : **un** barreau, au **début** d'une session suivante, à partir du lendemain (puis attente doublée après chaque essai raté), jamais au-dessus de la réponse de la détection, gardé après une partie entière à 60 FPS — sauf pour un cran **pris sur batterie** (`settings/Power.ts`, quand le navigateur le dit) : sur secteur il est réessayé tout de suite, au début de la session ou **entre deux parties** (jamais en pleine partie), mêmes règles, sans attente doublée s'il ne tient pas. Comme il change l'échelle **en pleine partie**, chaque barreau de l'échelle doit rester applicable sans compiler de programme (règle 35) et sans trou d'image (le pas est appliqué entre deux images : `GraphicsController.defer`, comme `Game.pendingProbe` pour la détection). Jamais pour un préréglage choisi (Low, High, Custom…). **Le processeur ou la carte graphique ?** Une image est mise au compte du processeur (et sort du calcul) quand son temps de thread principal dépasse 90 % du budget — mais ce temps compte l'envoi du rendu à son niveau habituel seulement (le plus bas vu en partie, qui remonte de 2 % par seconde) : quand le processus GPU du navigateur prend du retard, l'envoi attend (son tampon de commandes est plein) et ce surplus est celui de la carte graphique. Sans cette part, un combat limité par la carte graphique passait pour limité par le processeur : aucun verdict, la partie restait à 45-55 FPS (vidéo du propriétaire, 22/10). Le jeu fournit l'envoi (`Game.frameRenderMs` → `FrameMeter.record` → `onFrame(…, renderMs)`). **Un cran jugé inutile est défait** (gain < `minGain`) : l'image d'avant revient, et le garde s'arrête pour la session.
39. **Animation CSS infinie dans le HUD** (respiration, balancement, rotation, clignotement) : `will-change: transform` (ou `opacity`) sur l'élément animé — sans lui, Chrome peut le re-rastériser **à chaque frame** à l'échelle animée (le portrait `buddy-idle` : 60 → 45-49 FPS en 1080p sur Iris Xe, voir la 12ᵉ passe). Pas d'animation CSS continue sur un enfant de SVG (`<path>`, `<g>` : repeint à chaque frame) hors d'une petite couche à lui (`will-change` sur le `<svg>`). Le banc headless ne chiffre pas ce coût (pas de vrai GPU) : y compter les rastérisations par frame (traces), et mesurer les FPS en partie sur une vraie machine, HUD normal contre élément masqué (`?hud=inline`, puis `visibility: hidden` dans la console). Le détail de ce que Chrome sait animer au compositeur : règle 46.
40. **Chaîne de post-traitement de Givre** (`effects/GivrePostChain.ts`) : le format et la précision de ce que lit le FXAA **font partie de l'image**. Le FXAA est discontinu (seuil de contraste, fin de bord) : passer son entrée de flottants 16 bits à 8 bits change ~5 % des pixels (±1 niveau, et jusqu'à 60 niveaux sur quelques bords), et écrêter avant lui les valeurs > 1 (émissifs, halos : jusqu'à 6,4) change les bords autour d'elles. Une nouvelle cible, un nouveau format, une passe fusionnée : comparer pixel par pixel (`tools/perf/post-chain-check.mjs`, et `?diag=postab` → `givrePost.ab()` sur la vraie carte), jamais à l'œil ; une variante devient le défaut par `GIVRE_POST_DEFAULT`, l'ancienne chaîne restant accessible (`?diag=postref`).
41. **Pré-passe de profondeur (carte de Givre + fond)** : elle suppose que la carte statique et le fond calculent leur profondeur exactement comme ses proxys (`begin_vertex` + `project_vertex`, matrice monde identité, `invariant gl_Position`). Un matériau de lot statique qui déplace les sommets (`onBeforeCompile` sur la position, displacement), qui jette des fragments (`alphaTest`, `alphaHash`) ou qui change le test de profondeur (`depthFunc`, `polygonOffset`) doit rester hors pré-passe : `prepassEligible` (`world/GivreDepthPrepass.ts`) refuse ces cas tout seul (un patch de shader inconnu aussi) — un nouveau patch de matériau de carte qui ne touche pas la position doit y être déclaré (`knownPatch`, comme `MapUberMaterial`). Le fond et la carte restent à la racine de la scène, sans transformation (sinon le contrôle au chargement coupe la pré-passe). Ne jamais activer `logarithmicDepthBuffer` / `reversedDepthBuffer` avec elle (même chose). Un matériau de lot échangé après la construction de la pré-passe (le shader spécialisé de la règle 57 : des clones, et `Material.copy` ne recopie jamais `onBeforeCompile`) perd `invariant gl_Position` : `GivreDepthPrepass.repatch()` le remet — GivreMap l'appelle après chaque échange, tout nouvel échange doit l'appeler aussi (`scripts/test-givre-depth-prepass.mts`, section 4c). Mesurer l'overdraw : `tools/perf/overdraw-bench.mjs` ; vérifier l'image : `tools/perf/prepass-ab.mjs`.
42. **Faces simples** : une face ne passe en `FrontSide` que si l'image reste la même au bit près — à vérifier au banc (`tools/perf/prepass-ab.mjs`, `MODE=xsession` pour une bascule lue au chargement, plusieurs vues, LOW et HIGH). La règle des solides fermés, orientés vers l'extérieur et minces (≤ 2 m) s'applique au mesh entier ; étendue à chaque composante connexe (`?diag=percomponent`), elle change quelques pixels par vue (des égalités de profondeur entre la face avant et la face arrière de solides minces, que la face arrière gagnait) : elle reste une expérience. Un objet que le joueur peut traverser (sans collider) et assez grand pour contenir la caméra ne doit pas être un solide fermé mince — ou garder un matériau `transparent` / listé dans `keepMaterials`.
43. **Commande d'état du HUD appelée à chaque frame** (visible, munitions, puce, combo, visée…) : la façade (`hud/host/HudProxies.ts`) ne renvoie pas une valeur identique à la dernière envoyée — seulement si c'est un no-op prouvé pour le widget (ses propres tests de « dernière valeur ») ; sa mémoire est oubliée chaque fois que le widget peut oublier la sienne (changement de visibilité d'une plaque, de la lance). Ce qui avance avec le delta ou raconte un événement part toujours. Nouvelle commande de ce genre : même règle, et un cas dans `scripts/test-hud-skip.mts`.
44. **Sous-arbres « frais » (`effects/matrixFresh.ts`)** : la carte et les bras FP ne sont plus recalculés par la passe de `renderer.render`, ni un bot mort par celle de Game.frame. Du code qui déplace un nœud de carte après la passe de Game.frame, un nœud sous la caméra FP après `syncCamera`, ou le modèle d'un bot mort, doit le faire **avant** ces passes — ou appeler `updateMatrixWorld(true)` (forcé : jamais sauté). Ne pas accrocher d'objet sous la carte en cours de partie. `?diag=nofreshskip` remet les passes d'avant pour comparer.
45. **Uniforms de three.js** : ne jamais remplacer le `cache` d'un uniform par un tableau d'une autre longueur, ni écrire un uniform d'un programme de three.js par un `gl.uniform*` direct : les caches (y compris ceux des tableaux d'uniforms, `effects/UniformCacheKinds.ts`) croiraient le GPU à jour. **Mise à jour de three.js** : `UniformCacheKinds.ts` est écrit pour r185 (ses objets d'uniforms, une copie de ses setters flottants) — avec une autre révision il ne touche à rien (rien ne casse, l'économie disparaît) ; comparer avec le nouveau `WebGLUniforms.js`, relancer `scripts/test-uniform-cache.mts`, puis monter `SETTERS_REVISION`.
46. **Animation CSS du HUD = compositeur seulement** : `transform` / `opacity` d'un élément qui a une boîte CSS et dans lequel rien ne se repeint. Jamais d'animation CSS sur un **enfant SVG** (`<path>`, `<g>`) — Chrome ne la compose pas et refait le style et la mise en page du SVG à chaque image — : lui donner son propre `<svg>` dans une `<div>` animée (le portrait du Bean Buddy, `hudIcons.BEAN_BUDDY_LAYERS` ; une racine `<svg>` animée peut rester, elle aussi, sur le thread principal). **Pas de pourcentage dans les images clés d'un `transform`** (`translateX(-50%)` dépend de la taille de la boîte : thread principal, « TransformDependsOnBoxSize ») : le centrage dans la propriété `translate`, que l'animation ne touche pas (la bannière K.O.). `visibility` dans des images clés garde toute l'animation sur le thread principal (« UnsupportedCSSProperty ») : seulement pour une sortie courte (la chute de l'étiquette du combo, 0,45 s — sa `visibility: hidden` finale fait aussi ignorer à Chrome le clignotement de la corde qu'elle cache, « NoVisibleChange »). Jamais de `clip-path` / `mask` sur l'élément animé (un calque de masque et une passe hors écran à chaque image) : sur un enfant immobile. Jamais de `background-position` animé (une peinture par image) : un enfant qui glisse. Un élément mis à l'échelle en continu et qui garde sa couche : `will-change: transform`. Chaque exception garde l'ancien CSS sous `?diag=hudanim` (`hud.css` « PERF — animations »).
47. **Le document du HUD ne demande une image que s'il en a besoin** (`hud/runtime/frameClock.ts`) : un `requestAnimationFrame` qui se relance sans fin y coûte une image complète (rAF, style, mise en page, commit) à chaque rafraîchissement de l'écran, même quand rien ne bouge. Une boucle rAF dans un widget s'arrête quand il n'a plus rien à animer.
48. **Mesurer le HUD image par image** : `node tools/perf/hud-frame-bench.mjs --base <rev> --set states` (états durables : humeurs, mort, dash, plaques au repos / basses / en recharge…) ou `--set events` (tirs, kill, dégâts, recharge) : par image du scénario, dans le processus du HUD, images principales, styles, mises en page, peintures, tuiles rastérisées (et par calque), passes du compositeur d'affichage. Au repos, la cible est **0 peinture et 0 tuile par image** ; un effet ponctuel ne rastérise qu'à son début. `--layers` : les couches repeintes / rastérisées une à une (qui repeint quoi) ; `--css "<règles>"` : un « et si » (cacher une partie du HUD, retirer un filtre) ; `--restart <sélecteur>` : les animations que Chrome laisse au thread principal, et pourquoi (« NOT composited »). Les pixels : `tools/hud-preview/runtime-harness.mjs --rest` (chaque point de contrôle aussi au repos : animations sans fin à leur début).
49. **Préparation du kill (`effects/KillPrep.ts`)** : une nouvelle pièce de cadavre (maillage, matériau, squelette) n'a rien à faire, elle est préparée avec les autres. Un paramètre de programme d'un matériau vivant (carte, define, `side`…) ne change qu'avec `needsUpdate` (la règle de three — le clone prêt la suit comme un clone neuf) ; un `ShaderMaterial` n'est jamais préparé (`copy()` remplace ses uniforms, three garderait les anciens). La préparation tourne à la fin de Game.frame, juste après le rendu : rien entre les deux ne doit changer le nombre de lumières visibles ni leurs ombres (une compilation qui verrait un autre nombre de lumières ferait re-sélectionner le programme de tous les matériaux éclairés à l'image suivante). Une réserve de cadavre abandonnée libère ses textures d'os (`CorpseCloneSpare.reset`) ; un clone prêt part avec sa source (`dispose`). `?diag=nokillprep` pour comparer.
50. **Ordre des opaques** : le tri par défaut reste avant → arrière (`frontToBackOpaqueSort`). `?diag=programsort` (`programFirstOpaqueSort`) n'est **pas** la même image au bit près : avec le test LEQUAL, deux fragments opaques de profondeur exactement égale gardent le dernier dessiné, et l'ordre change — avec ou sans la pré-passe de profondeur, qui garde cette règle. Avant de l'activer par défaut : comparer les deux tris sur la même image figée, plusieurs vues et plusieurs états de combat (`givreDebug.perf.sort("program")` / `sort(true)` en DEV), et mesurer sur la vraie carte graphique le coût GPU (le tri avant → arrière sert le test précoce sans pré-passe).
51. **Un écran qui recouvre tout le monde d'une image opaque** (l'écran de fin et son instantané de la dernière image) : le monde n'est plus dessiné derrière (`Game.setWorldCovered`) ; le canvas garde sa dernière image et reste dans la page tel quel (les mêmes couches qu'avant pour le navigateur ; le masquer en plus n'économiserait que la composition d'un quad caché). Seulement une fois l'image du dessus **prouvée** opaque partout : three.js crée tous ses contextes WebGL avec un canal alpha (l'option `alpha: false` ne règle que la couleur d'effacement), le jeu ne peut donc pas le promettre — l'écran de fin lit son instantané par bandes, une par image, pendant les premières images de l'intro (`EndScreen._scanBackdrop` → `onBackdropOpaque` ; un seul pixel translucide et rien ne change). Le découvrir **avant** tout fondu qui le laisse voir (`MatchEndController.close`). Les mises à jour du décor (neige, ventilateurs…) continuent : le monde découvert est celui qu'on aurait vu.
52. **2ᵉ contexte WebGL utilisé en jeu** (l'intro 3D de l'écran de fin) : créé, ses programmes compilés (`renderer.compile`, statut lu sans attente) **puis dessinés une fois** avec tous ses objets visibles, sur un tampon de 16 × 9, dans les temps morts du menu (`EndScreen.prewarm`) — terminé au plus tard au clic sur JOUER et avant une détection (`flushPrewarm`) ; gardé toute la session d'un écran de fin au suivant (`releaseIntro3D`), ses programmes épinglés (comme `ProgramPin`). Un objet invisible au premier rendu (les lettres, les anneaux) compilait au moment où il apparaissait, en pleine intro : le warm-up dessine **tout**. Un état repris d'un objet réutilisé doit être celui d'un objet neuf, tirages `Math.random()` compris (`Intro3D.adopt`).
53. **Quad plein écran à opacité ou quantité 0** : three.js le dessine quand même — toute la passe de fragments, avec le MSAA. Le retirer du rendu quand sa contribution est **exactement** nulle (`Intro3D._render`) : seulement un objet qui n'écrit pas la profondeur et dont chaque fragment ajoute 0 (mélange additif), mélange un alpha 0, ou fait `discard`. Pas de test approché (« presque transparent ») : ce ne serait plus la même image.
54. **Instantané d'un canvas WebGL** (copie dans un canvas 2D) : lire toute l'image (`getImageData`) pour tester quelques pixels coûte une copie et une conversion de 8 Mo à 1080p, au pire moment — lire les pixels testés seulement. Ce qui demande de tout lire (est-elle opaque partout ?) se lit par bandes, une par image, après l'image critique (règle 51).
55. **Un écran construit d'un bloc** (les résultats de l'écran de fin) : poser ce qui fixe ses tailles (`--u`, le mode de mise en page) **avant** d'insérer son contenu, et ne lire aucune géométrie entre deux écritures (`focus()` force le style, `getBoundingClientRect` la mise en page) — sinon tout le contenu est stylé et mis en page une fois à la mauvaise taille, puis encore une fois (`UI.build`).
56. **`ShaderMaterial` recréé à chaque usage** (vitre, fissures de l'écran de fin) : three.js numérote le code de chaque shader tant qu'un matériau l'utilise ; dès que le dernier est libéré (`dispose`), le suivant reçoit un nouveau numéro, donc une nouvelle clé de programme, et son programme est **recompilé** — même épinglé (`ProgramPin` ne garde que l'ancien, plus jamais choisi). Garder un matériau de chaque sorte en vie (`Intro3D._retire`), ou réutiliser le matériau. (Les matériaux intégrés — `MeshStandardMaterial`… — ne sont pas concernés : leur clé ne dépend pas de ces numéros.)
57. **Shader de la carte Givre** (`world/GivreMapMaterial.ts`) : il suppose ce que `mapShaderEligibility` vérifie sur les vraies données au chargement — métal 0 sur chaque sommet, pas d'env map, emissive + AO sur le même `uv` et la même transformation, pas de normal map / clearcoat / sheen / transmission. Une condition qui tombe (un matériau métallique, une env map, une texture décalée) retire l'option pour CE matériau : jamais une image fausse, mais le gain disparaît sans bruit — vérifier `givreMapShader.list()` (DEV) après un changement de la carte. Un chunk de three réécrit (mise à jour de three) : `scripts/test-givre-render-optim.mts` échoue sur l'ancre manquante, et en jeu le shader d'origine est gardé (avertissement console). Un matériau de carte modifié en jeu par un effet (l'émissif de GIV_Feu) n'est jamais cloné : l'ajouter à `DECOR_KEEP_MATERIALS`. Toute nouvelle simplification : `tools/perf/map-shader-check.mjs` doit rester à 0 pixel de différence (LOW et HIGH), sinon elle va dans `mapshaderfast` (compromis à décider).
58. **Premier passage d'un chemin JS lourd en partie** (boucle sur tous les sommets ou triangles d'un perso : raycast visuel du corps skinné, barycentre, étalement de la peinture / de l'eau) : à froid — jamais exécuté, ou resté inutilisé assez longtemps (un long passage au menu) pour que le moteur JS jette son code compilé — la première fois s'exécute interprétée dans l'image du tir (≈ 27 ms au banc pour le premier impact de paintball, ≈ 1,5 ms ensuite). Trois règles : (1) la boucle chaude dans une fonction qui ne reçoit que des tableaux typés et des nombres (`skinVertices`, `nearestFace` dans `effects/SkinnedRaycast.ts`) — son code compilé vaut alors pour tous les persos, quelle que soit la forme de leurs objets ; (2) la faire tourner au chargement sur un clone de warm-up (`PaintballFX.warmHitPath`, `WaterFamasFX.warmHitPath`) ; (3) la refaire tourner quand le jeu commence (`Game.warmHitLoops`, au clic JOUER / reprise, au plus toutes les 20 s). Nouvelle arme qui marque les persos : les mêmes trois. Le résultat ne doit pas bouger d'un bit (`scripts/test-skinned-raycast.mts`).

## Mesures (banc headless, avant → après)

Banc déterministe (Chromium headless + SwiftShader sans rastérisation : on mesure
le **CPU** que paierait une machine à GPU rapide ; mêmes combats, RNG fixée, 3
graines sur Givre HIGH). Temps par frame du thread principal (simulation + envoi
du rendu), 8 bots qui se battent devant le joueur :

| Carte / preset | Bots | Frame (ms) | Draw calls | Appels WebGL |
|---|---|---|---|---|
| Givre HIGH | 0 | 13,8 → **4,8** (−66 %) | 259 → **37** | 1 640 → **329** |
| Givre HIGH | 8 | 36,5 → **19,9** (−45 %) | 589 → **124** | 4 000 → **1 230** |
| Givre LOW | 8 | 29,5 → **16,9** (−43 %) | 458 → **95** | 3 500 → **1 000** |
| Jungle HIGH | 8 | 32,9 → **14,8** (−55 %) | 751 → **132** | 3 710 → **1 220** |
| Yard HIGH | 8 | 27,3 → **18,2** (−33 %) | 528 → **132** | 3 030 → **1 110** |

Le banc est ~5 à 7 fois plus lent qu'un i9‑9900K. Recalé sur les chiffres du HUD
du PC gamer (base, Givre HIGH, 8 bots : CPU 5,8 ms = sim 1,6 + rendu 4,2), le
CPU par frame passe à **≈ 3,2 ms** (≈ 1,5 sim + 1,7 rendu) avec 8 bots en plein
combat dans le champ de vision, et à **≈ 0,8 ms** sans bot.

3ᵉ passe (kills, tirs, dégâts — Givre LOW, banc avec polices web chargées) :

| Mesure | Avant | Après |
|---|---|---|
| Tir continu au paintball sur un bot : JS + style / layout par frame (médiane · p90 · p99) | 8,1 · 16,7 · 40,2 ms | **7,0 · 14,8 · 28,6 ms** |
| Recalculs synchrones style + layout forcés par balle qui touche (réticule, hitmarker, nombre) | 3 | **0** |
| Re-rastérisations plein écran du HUD pendant 2 s de dégâts (vignettes) | 9 | **0** |
| Pixels de la peinture du Paintball (fenêtre 1280 px · fenêtre du portable 1536 px, DPR 1,25) | 256 k · 256 k | **145 k** · 256 k (inchangé) |

4ᵉ passe (Givre LOW, 8 bots, banc ; frame du kill = simulation + envoi du rendu) :

| Mesure | Avant | Après |
|---|---|---|
| Re-skinning CPU complet de la créature du Hex Sniper (16 220 sommets), par nouveau clone | 11 à 51 ms | **0** (jamais) |
| Pire frame de kill sur 24 kills de bots (même graine) | 56 ms | **34 ms** |

5ᵉ passe (premier kill du joueur — banc avec **rastérisation GPU** : Skia sur ANGLE /
SwiftShader, animations CSS ralenties ×10 pour que chaque phase soit dessinée comme à
60 FPS ; Givre LOW, 8 bots) :

| Mesure | Avant | Après |
|---|---|---|
| Shaders de rastérisation du navigateur compilés au premier kill (30 s qui suivent) | 19 | **5 à 6** |
| … au deuxième kill | 0 | 0 |
| Temps de compilation correspondant (SwiftShader, indicatif — D3D11 : dizaines de ms chacun) | 1,1 s | **0,4 à 0,5 s** |

6ᵉ passe (240 Hz — HUD au format du PC gamer : 2 844 × 1 600 CSS à 90 %, soit 1440p ; HIGH, Givre, 8 bots, Popcorn Shotgun ; couches et re-rastérisations lues par le domaine LayerTree de Chrome) :

| Mesure | Avant | Après |
|---|---|---|
| Surface des couches composées du HUD en jeu | 148 Mpx | **53 Mpx** |
| Re-rastérisations de la pile du haut (corde du combo) dans les 2,5 s après un kill | 55 (≈ 1 par frame) | **3** |
| Re-rastérisations du panneau de vie pendant l'écran de mort (2,5 s) | 41 | **0** |
| Plaque Popcorn : copie du canvas WebGL dans le canvas 2D | à chaque frame d'animation | **jamais** (canvas WebGL composé tel quel) |
| Frames du banc (rendu logiciel) pendant 2,5 s d'écran de mort | 19 | **77** |
| Appels WebGL par frame (HIGH, 8 bots en vue) | 1 215 | **1 061** (`texParameteri` : 72 → 0) |
| Allers-retours WASM → JS de Rapier par frame (8 bots) | ~100 | **0** |
| Allocations JS échantillonnées par frame (HIGH, 8 bots) | 226 Ko | **197 Ko** |
| CPU de simulation par frame (banc, 8 bots en combat) | 3,1-3,3 ms | **2,5-2,6 ms** |

7ᵉ passe (médaille KILL seule, 2 560 × 1 440, rastérisation GPU sur le banc ;
`node tools/perf/medal-bench.mjs`, travail de rendu du navigateur par médaille, moins la même fenêtre au repos, 2 mesures) :

| Mesure (par médaille) | Avant | Après |
|---|---|---|
| Animations non composées (thread principal à chaque frame) | rayons (`TargetHasIncompatibleAnimations`) | **aucune** (*) |
| Layerize (mise à jour des couches) | 29-34 ms | **4,2-4,5 ms** |
| Commit vers le compositeur | 33-57 ms | **0,9-1,7 ms** |
| Pre-paint | 17-25 ms | **9 ms** |
| Paint (thread principal) | 2,8-3,5 ms · 21 | **1,1-1,3 ms** · 11 |
| Tâches de rastérisation | 6,3-8,1 ms · 38-43 | **1,9-2,2 ms** · 14-15 |
| Recalcul du style | 31-40 ms | 25-28 ms |
| Pire frame pendant les 8 médailles | 200-366 ms | **83 ms** |

(*) Reste un « échec » sur l'étoile, `CompositorPropertyAnimationsHaveNoEffect` : une animation de
`translate` / `scale` dont un seul côté est composé ; elle dure 0,45 s, inchangée.
Banc headless (SwiftShader) : les durées sont une émulation sur CPU, à comparer entre elles ;
sur le PC gamer, c'est la ligne `Browser` (après un kill) qui doit baisser.

8ᵉ passe (chargement — build de production, Givre HIGH, 1280 × 720, 4 chargements par
version, alternés, dont 2 avec le localStorage déjà rempli ; banc SwiftShader à 2 cœurs,
~5 fois plus lent qu'un i9‑9900K, et **sans compilation parallèle des shaders** : le gain
principal sous Windows — la compilation en parallèle — n'apparaît pas ici, la ligne `[BOOT]`
le montrera ; SwiftShader compile en plus chaque shader sur le CPU au premier dessin) :

| Mesure | Avant | Après |
|---|---|---|
| Chargement complet, jusqu'au menu | 51,4 à 54,9 s | **35,4 à 40,0 s** |
| Étapes CPU (physique → préparation du warm-up), moyenne | 2,97 s | **2,16 s** (−27 %) |
| Entre la fin du warm-up et le menu (2ᵉ contexte WebGL…) | 10,7 à 16,8 s | **0,1 s** |
| Compilation des shaders + rendus de warm-up | 23,5 à 27,9 s | **21,8 à 26,5 s**, avec 8 programmes de plus (+ la peinture des plaques) : ceux qui compilaient en jeu (voir « Bugs corrigés ») |
| Grille de navigation de Givre (2ᵉ chargement et suivants) | ~90 ms | **~10 ms** (signature + lecture du cache) |
| Boîtes englobantes des maillages skinnés (normalisation du personnage) | 1× | **5× plus rapide** |
| Programmes GPU compilés après l'écran de chargement : entrée en jeu, combat scripté · changements d'arme | 4 · 4 (+ la peinture des plaques) | **0 · 0** |
| Image du menu (Givre HIGH, deux instants) | — | **0 pixel** de différence |

Le banc ne mesure pas le *temps* GPU du portable : la durée réelle de ces compilations
sous D3D11 se lit sur la ligne `Hitch` du HUD (voir ci-dessous).

9ᵉ passe (240 Hz — partie complète, build de production, Givre HIGH, 8 bots, HUD au format
du PC gamer (2 844 × 1 600 CSS à 90 %) ; par run, 8 tirs à la tête qui tuent, chacun 80 ms
après un dash ; 2 runs par version, alternés ; trace Chrome du thread principal : **jeu** =
la frame du jeu (`FireAnimationFrame` : simulation, envoi du rendu, JS du HUD, recalculs
forcés compris), **navigateur** = style, mise en page, pre-paint, peinture et layerize hors de
cette frame ; moyenne par frame sur les 16 kills, 14 pour la frame du kill) :

| Fenêtre (ms par frame, banc) | Avant : jeu + navigateur | Après |
|---|---|---|
| Au repos (1,4 s avant le kill) | 8,80 + 1,06 = 9,87 | 7,84 + 0,89 = **8,73** (−12 %) |
| Frame du kill (0 à 0,1 s) | 10,44 + 1,72 = 12,16 | 7,77 + 1,55 = **9,32** (−23 %) |
| 0 à 0,5 s après le kill | 9,95 + 1,51 = 11,46 | 8,60 + 1,69 = **10,28** (−10 %) |
| 0,5 à 2 s après le kill | 8,97 + 1,21 = 10,17 | 8,36 + 1,09 = **9,45** (−7 %) |
| Recalculs forcés (style + mise en page) dans la frame qui suit un kill | 5 + 4 | **0** |
| Éléments restylés à l'apparition / à la disparition d'une médaille | 57 / 57 | **40 / 18** |

Une partie du « jeu » de la frame du kill passe dans « navigateur » : le style des animations
que le classement forçait au milieu du JS est maintenant fait à sa place, à la fin de la frame.
Recalé sur le PC gamer (banc ~5 à 7 fois plus lent), c'est de l'ordre de 4,0 → 3,5 ms au repos
et 5,8 → 5,2 ms dans la demi-seconde qui suit un kill : **mieux, mais toujours au-dessus des
4,1 ms d'une frame à 244 Hz** pendant les animations du kill (≈ 190 FPS au lieu de 175, à
vérifier sur la ligne `Browser`).

15ᵉ passe (CPU par image — build DEV, Givre, HUD dans l'iframe, banc à 2 cœurs partagé : les
durées varient de ±10 % d'une session à l'autre ; les comptes, eux, sont exacts) :

| Mesure (par frame) | Avant | Après |
|---|---|---|
| Commandes postées au HUD, au repos comme en combat | 18 | **2** |
| Nœuds recomposés par la passe de `renderer.render` : carte · bras FP | 140 · 72 | **0 · 0** |
| Nœuds recomposés pour les bots morts (≈ 2 morts en moyenne, 8 bots) | 118-132 | **0** |
| `uniformMatrix4fv` à 8 bots, LOW · HIGH | 146 · 225 | **101 · 154** |
| Allocations JS échantillonnées, LOW : repos · 8 bots | 35,5 · 115,8 Ko | **31,3 · 71,1 Ko** |
| Allocations JS échantillonnées, HIGH : repos · 8 bots | 38,5 · 121,7 Ko | **28,1 · 73,0 Ko** |

Temps CPU (3 600 frames par mesure). Builds avant / après, LOW, deux sessions chacun (ordres
alternés) : au repos 3,03 → **2,89 ms** en moyenne (médiane 2,3 → 2,0) ; 8 bots en combat
7,81 → **6,89 ms** (−12 % ; médiane 7,35 → 6,55, p95 14,6 → 13,0), dont le rendu 4,08 → **3,33 ms**
(−18 %) pour ~72 draws : **≈ 56 → 47 µs par draw**. Même session, blocs de 300 frames alternés
avec / sans les interrupteurs en direct (HUD, tableaux d'uniforms, passes de matrices — les caches
en doubles bruts restent actifs dans les deux) : LOW au repos 3,01 → 2,72 ms (médiane 2,2 → 1,9),
LOW 8 bots 7,56 → 7,08 ms (rendu −12 %) ; HIGH : rendu −3 à −5 %, le total dans le bruit.
Simulation par bot (8 bots − 0 bot, ÷ 8) : **≈ 0,3 ms** au banc, avant comme après (IA ≈ 0,09 ms,
dont 87 % le contrôleur de personnage de Rapier ; animation ≈ 0,11 ; physique ≈ 0,04) — rien de
ce qui reste n'y est compressible à résultat identique.

17ᵉ passe (image du kill et tri par programme — build DEV, Givre, 8 bots, Paintball ; kills par le
chemin de dégâts du Paintball lui-même, dans la frame ; préparation ON / OFF alternée dans la même
session par l'interrupteur DEV, OFF = textures d'os préparées aussi retirées : l'ancien chemin) :

| Mesure (par kill) | OFF (avant) | ON (après) |
|---|---|---|
| Textures créées au premier dessin du cadavre (`createTexture` + `texStorage2D`) | 1 à 4 | **0** |
| Clones de fondu visibles initialisés par three au premier dessin | 1 à 9 (selon la réserve) | **0** (les clones prêts sont déjà initialisés) |
| Nouveaux programmes / fuite (textures, programmes après 28 kills) | — | **0 / aucune** (textures 111 → 107, programmes 93 → 93) |

Même image : le cadavre préparé contre celui de l'ancien chemin (clones faits à l'instant du kill,
textures d'os créées au dessin), même image figée, rendu réel, RGBA — au kill et à mi-fondu,
LOW et HIGH, 4 kills où le cadavre couvre 335 à 3 881 pixels : **0 pixel de différence**, 0 propriété
de matériau différente (une comparaison avec des clones faits *plus tard* diffère, elle : la source
change après le kill — remise à zéro de l'arme, séchage, lueur de protection à la réapparition).

Ce travail, fait seul sur une image figée (12 répétitions), coûte au banc **0,5 ms** pour un
cadavre de 5 matériaux et 1 squelette (LOW) et **0,6-0,8 ms** pour 8 matériaux et 4 squelettes (HIGH)
au mieux, 0,6 à 2,8 ms en médiane avec le bruit du banc (0,07 ms par texture d'os, 0,1-0,15 ms par
clone + ≈ 0,6 ms fixes par tâche). Premier rendu du cadavre sur la même image figée, ancien chemin
contre préparé (médiane de l'excès sur un second rendu identique) : HIGH +3,7 → +1,2 ms et
+1,4 → +0,1 ms, LOW +2,5 → +0,7 ms et +0,5 → +0,9 ms — un rendu isolé varie de ± 3 à 9 ms au banc,
ces écarts n'en sortent qu'à HIGH. Le temps total de l'image du kill ne bouge pas de façon mesurable
au banc pour la même raison (LOW, 14 + 14 kills : médiane 14,4 → 13,8 ms, rendu 4,2 → 4,9 ms ; HIGH,
8 + 8 : 18,5 → 13,9 ms, rendu 7,2 → 2,9 ms — chaque série est dans le bruit de l'autre). Le chemin
du kill lui-même, côté simulation, est petit (80 kills) : `Bot.onDeath` ≈ 1,3 ms en médiane
(réserve du cadavre 0,4, ragdoll Rapier 0,3-0,5), `onBotKilled` ≈ 0,3 ms (peinture, eau, HUD, combo,
médailles, audio, butin ≈ 0,1 chacun). Un kill sur quatre environ monte à 2,4-12 ms, mais le surplus
change de fonction d'un kill à l'autre (ragdoll Rapier, réserve, matériaux, son) : du bruit du banc
(GC, ordonnancement), pas un travail fixe à déplacer — et créer les corps Rapier du ragdoll à
l'avance changerait l'ordre des corps du monde physique : la simulation ne serait plus la même au
bit près. Une tâche de préparation coûte 0,1 ms quand il n'y a rien à faire, 0,8 ms (médiane)
quand elle crée des clones, 0,1 ms pour des textures d'os, une seule par image. Mort du joueur
(6 morts, LOW + HIGH) : `player.onDeath` 0,2 à 1,2 ms, chaque remise à zéro d'arme ≤ 0,3 ms
(`PopcornShotgunWeapon.reset` : 0,0 ms cinq fois, 0,2 ms une fois — les 4 ms d'un profil précédent
ne se retrouvent pas en mesure directe : sans doute l'attribution de l'échantillonnage) ; l'image
de la mort (5,0 à 13,1 ms) reste dans la plage de ses voisines (médianes 5,0 à 8,8 ms, voisines
jusqu'à 23 ms). Le vrai pic de cette famille au banc est **le premier coup de peinture sur un
personnage dans la session** : 10 à 22 ms dans `PaintballFX.characterHit` (3 sessions) — c'est
lui qui gonfle « armes » au premier kill d'une session quand ce kill est aussi ce premier coup. Il
se partage entre le rayon sur le corps skinné (5-7 ms au premier appel, ≈ 0,4 ms ensuite) et
`PaintballFX.prepare` (≈ 8 ms sur une seule mesure, dont 0,2 ms seulement pour la géométrie peinte
et sa topologie, déjà calculée au chargement ; le reste n'est pas attribué). Pas le chemin du kill.

Tri par programme (`?diag=programsort`), même session, blocs de 30 images alternés (720 images par
mode, 8 bots en combat) ; « pré » = la pré-passe de profondeur de la branche gpu-overdraw (build de
test fusionné, `?diag=prepass`, vérifiée au chargement : 0 pixel de différence) :

| Par image | Avant → arrière | Par programme | Avant → arrière + pré | Par programme + pré |
|---|---|---|---|---|
| `useProgram`, LOW | 65 | **45** | 68 | **48** |
| `useProgram`, HIGH | 63 | **40** | 64 | **42** |
| Rendu CPU (médiane), LOW | 3,9 ms | 3,7 ms | 3,8 ms | 3,5 ms |
| Rendu CPU (médiane), HIGH | 4,0 ms | 3,7 ms | 3,7 ms | 4,1 ms |

Gain CPU ≤ 0,3 ms (≈ 12 µs par `useProgram` évité), du même ordre que le bruit à HIGH. Pixels (image
figée rendue avec chaque tri, RGBA) : build de test avec la pré-passe, 5 vues LOW + 5 HIGH, toutes
les combinaisons → 0 pixel de différence ; build de la branche seule, d'autres états de combat :
1 vue LOW sur 5 avec 9 pixels (écart max 60), 3 vues HIGH sur 5 avec 1 pixel (écart max 25) ;
recherche systématique sur 24 vues par session : 2 images à 9 pixels dans une session, aucune dans
une autre. Entre opaques testés et écrits en profondeur (LEQUAL) sans mélange, un autre ordre ne
change que le gagnant d'une égalité exacte de profondeur (le `renderOrder`, comparé avant le
programme, garde les contrats de stencil et de contour) : rare, quelques pixels, mais pas zéro.
D'où : expérience, désactivée par défaut.

## Le HUD dans son propre processus (10ᵉ passe)

Tant que la 3D et le HUD partageaient le thread principal, une frame coûtait **jeu + navigateur**,
et les animations du HUD au kill reprenaient ce qu'on gagnait ailleurs (chaque nouvel effet du HUD
remettait le budget de 4,1 ms en jeu à 244 Hz). Le HUD tourne maintenant dans une iframe que
Chrome / Edge isolent dans leur propre processus : une frame coûte le **maximum** des deux.

Mesure de décision sur le PC gamer (prototype `/perf/prototype-240hz.html`, Edge 155, RTX 2080 Super,
238 Hz, rendu 2551 × 1282 à 90 %) — même charge 3D que le jeu en HIGH, même HUD simulé (calé sur la
ligne `Browser` : 0,8 ms au repos ; au kill, un pic de 6 ms puis +1,5 ms par frame pendant 0,6 s) :

| Architecture | 3D au calme | 3D pendant les kills | Pire frame | Frames en retard (kills) |
|---|---|---|---|---|
| Tout sur le thread principal (le jeu jusqu'ici) | 239 FPS | 158 FPS | 20,8 ms | 50 % |
| 3D dans un worker, HUD sur le thread principal | 240 FPS | 237 FPS | 16,7 ms | 1 % |
| **HUD dans une iframe isolée** (en place) | 240 FPS | **240 FPS** | **4,4 ms** | **0 %** |

Comment c'est fait :

- `hud.html` (2ᵉ page du build Vite, `vite.config.ts`) est chargé dans `<iframe id="hud-frame"
  sandbox="allow-scripts">`, plein écran, sans pointeur, jamais de focus (`style.css`). Origine
  opaque = autre site pour l'isolation des sites = autre processus. Ses requêtes sont CORS
  (`Origin: null`) : `vercel.json` ajoute `Access-Control-Allow-Origin: *` sur `/assets/*`.
- Page du jeu : `src/hud/host/HudHost.ts` choisit le mode au chargement (production : iframe ;
  `npm run dev` : dans la page ; `?hud=inline|frame`), vérifie l'isolation (la page bloque son
  thread 80 ms : un compteur de l'iframe doit continuer d'avancer), envoie `init` (avec la taille et
  le devicePixelRatio de la page : l'iframe refuse si elle ne voit pas les mêmes), puis une liste de
  commandes par frame (`flush()` à la fin de la frame du jeu). `HudProxies.ts` : l'API que le jeu
  appelle, mêmes méthodes que les anciens widgets, copies de données à l'appel, et les étiquettes de
  la ligne `Hitch` (« kill », « tir », « dégâts »…).
- Document du HUD : `src/hud/runtime/frameEntry.ts` (poignée de main, port de messages, compteur
  d'isolation, statistiques toutes les 500 ms) et `HudRuntime.ts` (balisage `hudMarkup.html`, les
  widgets dans l'ordre où Game les construisait, application des commandes, warm-up). Les polices
  sont rechargées par l'iframe (cache séparé) avant son warm-up.
- Repli : le même runtime dans la page, chaque commande appliquée à l'appel — l'ancien
  comportement, sans le gain. Sur Firefox / Safari (pas d'isolation des iframes sandboxées), le
  contrôle d'isolation le choisit tout seul.
- Pendant la partie, les statistiques de l'iframe (toutes les 500 ms, envoyées par un minuteur et
  non par une frame : des frames seulement lentes ne comptent pas) servent aussi de signe de vie :
  3 s sans nouvelles alors que la page du jeu dessine au moins deux frames par seconde (un trou
  plus long — tâche longue, onglet caché — remet le compteur à zéro : ses messages attendaient
  peut-être dans la file) = processus du HUD planté ou figé. Rien n'est jugé pendant les 10 s qui
  suivent l'affichage ou le masquage du HUD en entier (menu, pause) : c'est sa plus grosse frame
  de la session (jusqu'à 5 s mesurées au banc logiciel à 2 cœurs, où le jeu tournait pendant ce
  temps à 19 FPS). Même repli, à partir du
  **dernier état** du HUD (`STATE_KEY` : dernière commande de chaque état — vie, armes, combo,
  classement, chrono, réglages du viseur, classes…), puisque les commandes ne sont plus gardées
  après le warm-up. Ses statistiques donnent aussi la taille et le zoom qu'elle voit : différents
  de la page deux fois de suite (la page n'ayant pas changé entre-temps) = même repli.
- Le HUD peut avoir une frame de retard sur la 3D (deux processus) ; à 240 Hz, 4 ms.

Le prototype reste dans `public/perf/prototype-240hz.html` (paramètres d'URL dans l'en-tête du
fichier ; il donne aussi le devicePixelRatio vu par l'iframe).

Au banc headless (2 cœurs, SwiftShader, composition logicielle, 2560 × 1440, Givre, 8 bots, dessins
3D sautés), le gain n'apparaît que si le processus du HUD a **son propre cœur**, comme sur une vraie
machine (le PC gamer a 16 threads) : processus épinglés (la page du jeu seule sur un cœur, le HUD et
le processus GPU sur l'autre), la boucle du jeu tourne à **33-35 FPS avec le HUD dans la page** (avant
comme après cette passe) et à **44-53 FPS avec l'iframe**. L'envoi des commandes d'une frame (18 en
moyenne, un seul `postMessage`) prend moins de 0,2 ms et ne change pas les FPS (mêmes FPS quand on ne
les envoie plus). Sans épinglage, sur 2 cœurs, le processus du HUD est réveillé à chaque frame sur le
cœur du jeu (l'autre est pris par SwiftShader) : chaque envoi devient un changement de contexte, le
temps CPU du jeu par frame gonfle (4,7 → 7,5 ms) et le gain disparaît dans le bruit — une limite du
banc, pas de l'architecture.

## La cause racine, mesurée sur la vraie carte graphique (11ᵉ passe)

Jusqu'ici, tout se mesurait au banc headless (SwiftShader : pas de vrai GPU). Cette passe a été
mesurée **sur le portable lui-même** (Intel Iris Xe, Windows, Direct3D 11 via ANGLE, moteur
Chrome 152) : le navigateur intégré de l'app Claude, piloté à distance sur la page de production,
Givre en LOW à 1920 × 928 (la taille du jeu à 80 % de zoom), avec une sonde WebGL injectée dans la
page (timer queries par image et par draw, compteurs d'appels, bascules A/B). Au départ : **36 à
44 FPS**, comme dans Chrome sur la même machine.

**1. Le travail GPU partait trop tard (la vraie cause des 30-40 FPS).** WebGL ne fait que mettre des
commandes en file ; rien ne demandait au pilote de les lancer avant la présentation de la page. Le
GPU restait inactif une partie de l'image, recevait tout d'un bloc, et une image sur deux ratait le
rafraîchissement de l'écran (sur un portable, l'inactivité baisse aussi les fréquences du GPU). Un
`gl.flush()` après la passe monde et un en fin d'image (`Game.flushGpu`, `FlushPass`) :

| Givre LOW, Iris Xe | sans flush | avec |
|---|---|---|
| 1920 × 928, fenêtre en arrière-plan | 36,1 FPS (image médiane 33 ms) | **60,1 FPS** (verrouillé sur l'écran) |
| 2560 × 1238, limité par le GPU (19 ms de GPU par image = 52 FPS au mieux) | 42,5 FPS | **48,6 FPS** |

Flusher plus souvent (tous les 3 ou 6 draws) mesure moins bien (47-49 FPS, plus de CPU).
`?diag=noflush` remet l'ancienne soumission, pour comparer sur n'importe quelle machine.

**2. Des « clears » plein écran très chers sur Intel.** Temps GPU par opération (1920 × 928) :
la cible HDR du monde (RGBA16F) était vidée **deux fois** par image (RenderPass, puis le fond
`Color` de la scène que three force) : ~0,7 ms chacune — la couleur du ciel n'est pas une valeur
0 / 1, le pilote écrit donc tous les octets ; puis la cible de la passe de sortie (0,67 ms) et le
canvas (0,43 ms). A/B à 2560 × 1238 avec le flush : sans les deux clears couleur du monde
49 → **57 FPS** ; sans celui de la cible de sortie 49,5 → 54 ; sans celui du canvas 50 → 51,7 ;
tous ensemble 50 → **60 FPS** (plafond de l'écran). Désormais : un seul clear profondeur + stencil
(`SkyCoveredRenderPass` : le dôme du ciel, dessiné au plan lointain après les opaques, écrit tous
les pixels que la carte laisse libres), et les passes plein écran (sortie sRGB, FXAA) n'effacent
plus leur cible, qu'elles recouvrent entièrement (`FullscreenPass`).

**3. Le reste, mesuré par A/B (temps GPU médian d'une image, 1920 × 928) :**

| Bascule | Effet |
|---|---|
| Ciel dessiné en premier (plein écran) → en dernier | 1,45 ms par image pour ce seul draw (`GivreSky` : dessiné en dernier) |
| Passe de sortie sRGB (dans une 2ᵉ cible HDR, avant le FXAA) | 1,2 ms — gardée : la fusionner avec le FXAA changeait l'anticrénelage de 6 à 9 % des pixels (le FXAA filtrait alors en linéaire, jusqu'à 174 niveaux d'écart sur un pixel de bord) ; seul son clear est parti |
| 2 lumières ponctuelles du pool FX, toujours à l'intensité 0 | −0,33 ms (retirées : `FXLightPool`, même image) |
| Ombres (échantillonnage de la shadow map) | −0,24 ms (gardées) |
| Lumière hémisphérique, AO map + emissive map, faces doubles → simples | dans le bruit (< 0,1 ms) |
| Tous les viewports à 1 × 1 (plus aucun pixel à dessiner) | 11,8 → 6,9 ms : le reste = clears + sommets + attente |

**Tout ensemble**, même portable, page de production, ancien chemin contre nouveau en alternance
(soumission + clears + ciel + lumières FX, reproduits dans la page ; temps GPU médian d'une image) :

| Givre LOW, Iris Xe | avant | après |
|---|---|---|
| 1920 × 928 (fenêtre au premier plan ; 36-44 FPS en arrière-plan, voir 1.) | 60 FPS | 60 FPS, avec ~40 % de GPU en moins (mesuré aux tailles au-dessous) : de la marge |
| 2560 × 1238 | 41 FPS · 17,4 ms de GPU | **60 FPS** (plafond de l'écran) · **10,5 ms** |
| 3200 × 1546 | 29 FPS · 27,4 ms | **56 FPS** · **16,2 ms** |

Le shading de la carte elle-même n'est donc **pas** le problème : le jeu payait surtout des
passes et des clears plein écran qui ne changent aucun pixel, et un GPU démarré trop tard.
Krunker dessine directement dans le canvas (pas de cible HDR, pas de post-traitement) : pas de
clear supplémentaire, et un travail GPU assez petit pour tenir dans l'image même soumis tard.

Les dômes de ciel de Jungle et Yard sont aussi dessinés en dernier (`skyDome.ts`). Vérifié au
banc (`givreDebug.perf.skyFirst / clears / deadLights / passClears` : l'ancien chemin, bascule par
bascule) : mêmes pixels RGBA, au bit près, avant / après — chaque changement seul et tous ensemble,
sur Givre LOW et HIGH, Jungle et Yard.

## Le portrait du HUD qui se re-rastérisait (12ᵉ passe)

Même portable (Iris Xe), production, **partie solo qui tourne** (bots, HUD, arme en main), réglage
Custom 100 % = 1920 × 1080 natif : **45-49 FPS**, alors que le jeu tient dans l'image (GPU de la
page ≈ 12 ms, CPU 6-8 ms ; 4 ms de CPU ajoutés avant ou après la frame ne changent rien : ni le
thread principal ni le GPU du jeu ne sont la limite). A/B, cadence mesurée aux timestamps rAF :

| Partie Givre, 1080p natif | FPS (5 s) |
|---|---|
| HUD normal (iframe) | 45-46 |
| `#hud-frame` masqué | **59,9** |
| `?hud=inline`, HUD normal | 48-52 |
| … sans `#bean-buddy` (le portrait) | **60,1** (0 image en retard) |
| … sans le classement, l'arme, l'horloge, les vignettes, le panneau debug | 49-52 (aucun effet) |
| … portrait, seulement l'animation `buddy-idle` du `<svg>` coupée | **60,1** |
| … seulement les chevrons du dash / les feuilles et les yeux / la touche coupés | 56,5 / 52,8 / 49,8 |
| … `will-change: transform` sur `.buddy-art` (même animation) | **60,1** (0 image en retard) |

Sans émulation (fenêtre réelle, rendu 1147 × 1393, GPU du jeu 9,5 ms) : 54,2-54,6 FPS contre
**60,1** avec `will-change`, en alternance A/B/A/B. La respiration du haricot (`scale` sur le
`<svg>`, infinie) obligeait Chrome à le **re-rastériser à chaque frame** à l'échelle animée — un
travail fait dans le processus GPU du navigateur, à côté du WebGL du jeu, qui faisait rater le
rafraîchissement. Avec `will-change: transform`, il est rastérisé une fois et le compositeur
l'anime : même image. C'est aussi ce qui sépare le plus Beanzo de Krunker sur cette machine : le
jeu tenait, son HUD non (règle 39).

## La chaîne de post-traitement de Givre, octet par octet (13ᵉ passe)

Sur l'Iris Xe, la fin de l'image est limitée par la **mémoire**, pas par le calcul. Mesuré à la
11ᵉ passe (1920 × 928) : la passe de sortie sRGB (lit 8 o/px, écrit 8 o/px) coûtait 1,2 ms, le FXAA
(lit 8 o/px, écrit 4) 0,8 ms — ≈ 25 Go/s effectifs, la mémoire qu'un iGPU partage avec le
processeur. À 2160 × 1044 (Auto, 90 % du natif), **1 o/px ≈ 2,25 Mo par image ≈ 0,09 ms**. La chaîne
de LOW / Auto (FXAA) :

| Étape | Lit (o/px) | Écrit (o/px) |
|---|---|---|
| Monde (+ bras) → cible RGBA16F | 8 par fragment mélangé | 8 par fragment écrit (≥ 1 par pixel : le ciel couvre le reste) |
| Sortie sRGB → 2ᵉ image RGBA16F | 8 | 8 |
| FXAA → canvas | 8 (les voisins viennent du cache) | 4 |

Chaque variante ci-dessous retire une partie de ce trafic ; toutes derrière `?diag=` (combinables,
`src/effects/GivrePostChain.ts`), **la chaîne de référence reste celle par défaut**. Banc
(SwiftShader, 960 × 540, Givre LOW avec 3 bots, RGBA, référence et variante dans la même session,
simulation figée ; 5 vues autour du point d'apparition et 5 vues visant un halo, la vapeur, la fumée,
une vitre et des empreintes — 3 à 13 vues par variante ; `tools/perf/post-chain-check.mjs`) :

| `?diag=` | Ce qui change | o/px en moins : sortie + FXAA ; monde | Pixels différents | dont ±1 niveau | Écart max (où) |
|---|---|---|---|---|---|
| `out8` | la sortie écrit une image RGBA8 dédiée (sans profondeur) | 8 ; 0 | 4,4 – 22,8 % | 96 % | 84 (bords FXAA), 124 (autour des pixels > 1) |
| `fused` | plus d'image intermédiaire : le FXAA lit le monde et convertit lui-même chaque texel (`OutputFXAAPass`) | 16 ; 0 | **0,03 – 0,15 %** | 78 % | 78 (20 à 210 px par image au-delà d'un niveau, sur des bords) |
| `fused8` | idem, poids bilinéaires arrondis à 1/256 (comme les échantillonneurs à 8 bits de sous-texel) | 16 ; 0 | 0,6 – 0,9 % (SwiftShader, 3 vues) | 97 % | 42 |
| `worldsrgb` | monde en SRGB8_ALPHA8 (+ `out8`) | 12 ; ≈ 8 | 5,1 – 22,8 % | 96 % | 84, 124 |
| `worldsrgb,fused` | monde SRGB8 + `fused` | 20 ; ≈ 8 | 6,5 – 7,8 % (3 vues) | 94 % | 49, 115 |
| `world11` | monde en R11F_G11F_B10F (+ `out8`) | 12 ; ≈ 8 | 53 – 78 % (5 vues) | 80 % | 57, 123 |
| `direct` | Givre dessiné comme Jungle / Yard (sRGB encodé par les matériaux, cible RGBA8), plus de passe de sortie | 20 ; ≈ 8 | 5,6 – 30,7 % | 73 % | 87, 124 — **compromis visuel** |

(« monde » : 4 o au lieu de 8 par fragment écrit, 8 au lieu de 16 par fragment mélangé — ≈ 8 o/px
pour ~1,9 écriture par pixel (le matériau de la carte est calculé ≈ 1,9 fois par pixel couvert,
mesure de l'agent `gpu-overdraw`) et ~0,15 mélange. Alpha : identique partout — le monde vaut 1,0
partout, mesuré à chaque vue, et R11F_G11F_B10F, sans alpha, se lit 1,0.)

**Pourquoi rien n'est identique au bit près.** (1) Le FXAA est **discontinu** : seuil de contraste,
direction du bord, fin du bord (`|Δluma| ≥ gradient / 4`)… Quantifier son entrée (8 bits au lieu des
flottants 16 bits de l'image intermédiaire) ne change chaque luminance que d'un demi-niveau, mais fait
basculer quelques décisions : quelques centaines de pixels de bord changent de 20 à 80 niveaux ; et
hors des bords, des pixels changent d'un niveau (l'ancienne image arrondissait d'abord en demi-flottant) —
~3 % en moyenne, jusqu'à 23 % d'une vue de toit enneigé quand un grand aplat tombe sur une frontière
d'arrondi. (2) Le monde
contient des **valeurs > 1** (jusqu'à 6,4 en linéaire, 0,5 à 1,6 % des pixels : émissifs, halos) :
l'ancienne chaîne les garde jusqu'au FXAA, qui mélange leurs voisins avec elles avant l'écrêtage du
canvas ; écrêtées plus tôt (image RGBA8, monde SRGB8), les bords autour de ces points s'éclaircissent
moins (jusqu'à 124 niveaux, sur 0,1 à 0,5 % des pixels). (3) `fused` refait exactement les mêmes
conversions, y compris l'arrondi en demi-flottant de l'ancienne image (sans lui : 2,4 à 3,5 % des pixels
changent) ; il ne reste que la précision du filtre bilinéaire du GPU (la seule lecture fractionnaire
est celle du mélange final ; celles de la recherche du bord tombent à 0 ou ½ texel) et de minuscules
écarts d'arrondi (ordre des opérations du filtre) qui font basculer quelques bords. SwiftShader filtre avec des poids exacts (`fused`) ;
la plupart des GPU de bureau quantifient à 8 bits (`fused8`) : sur l'Iris Xe, `givrePost.ab()` dit
laquelle des deux colle.

**`direct` sur les effets transparents** (vues visant chaque effet, cadre de 320 × 240 autour de
lui ; image entière entre parenthèses) : **halo** d'une lanterne — la lueur additive, ajoutée en sRGB,
s'étale et s'aplatit : 5,7 % du cadre change de plus de 16 niveaux, jusqu'à 72 (image : 10,9 %,
max 124) ; **vapeur** — les chevauchements des bouffées s'éclaircissent : 3,9 % au-delà de 16
niveaux, jusqu'à 123 (11,2 %) ; **fumée** des cheminées sur le ciel — des écarts faibles mais étendus :
25 % du cadre, 0,03 % au-delà de 16 niveaux (30,7 %, max 84) ; **vitres** (réservoir du Water FAMAS
d'un bot, dôme du chargeur du Paintball en main) — jusqu'à 94 – 116 niveaux sur le verre (7,1 %) ;
**neige** — de petits écarts sur chaque flocon, dans toutes les vues ; **empreintes** — presque
rien : le décalque multiplicatif ne dépend guère de l'espace du mélange (13,9 % du cadre à ±1-2,
0,03 % au-delà de 8 niveaux). Différences visibles à la comparaison directe : un compromis, pas une
optimisation.

**Ce que ça coûte.** Au banc, SwiftShader émule le GPU sur le processeur : le calcul s'y voit, la
bande passante non (et la machine, 2 cœurs partagés, était chargée : écarts de ±30 % et plus). Temps
d'une image (`renderComposer` + relecture d'un pixel) et de la seule sortie + FXAA, médiane (min – max)
de 6 mesures sur 2 vues, variantes en alternance :

| Variante | Image (ms) | Sortie + FXAA (ms) |
|---|---|---|
| référence | 1 861 (1 376 – 2 242) | 342 (179 – 674) |
| `out8` | 2 353 (1 129 – 2 652) | 312 (224 – 397) |
| `fused` | 3 208 (1 385 – 4 331) | 1 467 (1 253 – 1 859) |
| `fused8` | 3 084 (2 794 – 3 548) | 1 480 (747 – 2 252) |
| `worldsrgb` | 2 295 (1 862 – 2 391) | 258 (183 – 468) |
| `worldsrgb,fused` (3 mesures) | 2 760 (1 797 – 4 000) | 1 853 (1 732 – 1 977) |
| `direct` | 1 397 (1 124 – 2 083) | 236 (91 – 291) |

`fused` convertit 5 texels par pixel au lieu d'un (15 `pow`, ~55 conversions sur un pixel de bord) :
≈ 4,3 fois la sortie + FXAA d'origine en calcul émulé ; les variantes 8 bits y sont un peu moins chères
(moins de conversions en demi-flottant), les écarts d'image entière sont dans le bruit.

Estimation pour l'Iris Xe à 2160 × 1044 (1 o/px ≈ 0,09 ms ; écritures couleur du monde ≈ 17 o/px en
RGBA16F avec les effets transparents, ≈ 8,5 en 4 octets) :

| Variante | o/px en moins | Gain estimé (trafic seul) | Calcul en plus |
|---|---|---|---|
| `out8` | 8 | ≈ 0,7 ms | — |
| `fused` / `fused8` | 16 | ≈ 1,4 ms | ≈ 0,3 – 0,7 ms de `pow` (en partie caché sous la mémoire) |
| `worldsrgb` (+ `out8`) | ≈ 20 | ≈ 1,8 ms | — |
| `worldsrgb,fused` | ≈ 28 | ≈ 2,5 ms | comme `fused` |
| `direct` | ≈ 28 | ≈ 2,5 ms | — (moins : plus de conversion) |

Ce sont des majorants (l'Iris Xe compresse les cibles uniformes, le ciel ; avec la pré-passe de
profondeur de `gpu-overdraw`, ≈ 1 écriture par pixel : le gain des formats du monde baisse de moitié) —
**à mesurer** avec `?gpu` : total de la ligne `GPU:` et termes `sortie` + `FXAA`.

**HIGH (MSAA 4×, sans FXAA)** : la sortie dessine le canvas, `out8` / `fused` n'y changent rien
(0 pixel). Les formats du monde, eux, divisent par deux la cible multi-échantillonnée **et ses deux
résolutions par image** (≈ 4 ms chacune sur le portable en HIGH) : ≈ 40 o/px de moins sur les
résolutions seules. Banc (2 vues) : `worldsrgb` = 3,6 % des pixels à **±1 niveau**, sauf les bords
MSAA des points > 1 (≈ 500 px, jusqu'à 112 niveaux : la référence moyennait 6,4 avec ses voisins) ;
`world11` = 65 % des pixels à ±1 à 4 niveaux ; `direct` = 5 %, jusqu'à 151 niveaux (mélanges et
résolution MSAA en sRGB). Temps du banc (2 échantillons, bruités) : référence 3,9 s, `worldsrgb`
4,1 s, `world11` 3,7 s, `direct` 2,5 s.

Chargées depuis l'adresse comme un joueur (le warm-up compile leurs variantes), toutes les chaînes
ont été vérifiées au banc, LOW et HIGH : la chaîne demandée est celle construite, **0 programme
compilé** en jeu comme par la bascule FXAA ⇄ MSAA en direct (93 programmes en LOW, 97 en HIGH, comme
la référence), aucune erreur GL ni console, canvas opaque.

**Recommandation.** Rien n'est identique au bit près : **la référence reste le défaut**. À mesurer sur
l'Iris Xe (un seul déploiement, des adresses) : `?gpu`, `?gpu&diag=fused8`, `?gpu&diag=fused`,
`?gpu&diag=out8`, `?gpu&diag=worldsrgb`, `?gpu&diag=worldsrgb,fused8`, `?gpu&diag=direct` (GPU médian
à la même vue, fenêtre au premier plan), et `?diag=postab` → `givrePost.ab()` à 2-3 vues. (1)
**`fused8` ou `fused`** (celle qui colle à l'Iris Xe) : la seule variante quasi identique (0,03 à 0,15 %
des pixels, 20 à 210 pixels de bord par image au-delà d'un niveau) ; si le GPU baisse, c'est le candidat au défaut
(`GIVRE_POST_DEFAULT`), avec l'accord du propriétaire pour ces quelques pixels d'anticrénelage.
(2) Compromis invisibles mais pas identiques, au propriétaire de décider : `out8` (4 à 23 % des pixels à
±1, l'anticrénelage de quelques bords et autour des points lumineux) et `worldsrgb` (idem en LOW ; en
HIGH ±1 sur 3,6 % des pixels et le gain des résolutions MSAA). (3) `world11` : abandonné (mêmes octets
que `worldsrgb`, 10 fois plus de pixels changés). (4) `direct` : compromis **visible** sur les effets
transparents (neige, halos, fumées, vitres, empreintes) — le plus économe, pour mémoire.

## L'overdraw de la carte (14ᵉ passe : pré-passe de profondeur)

Sur l'Iris Xe, **un seul lot de la carte** (26 391 indices, celui de la cellule du Stock) prenait
2,1 à 4,5 ms : le matériau de la carte (MeshStandardMaterial : soleil + hémisphère, ombre PCF, AO
et émissif cuits) est le pixel le plus cher de l'image, et il était calculé **≈ 2 fois par pixel**.

**L'outil** — `tools/perf/overdraw-bench.mjs` (+ `overdraw-probe.js`, poses dans
`givre-poses.mjs`) : chaque draw opaque de la passe monde est rejoué **dans l'ordre réel** (la liste
triée de three, les triangles dans l'ordre de l'index) avec un matériau de comptage additif qui garde
son côté, son test de profondeur, son stencil, son polygon offset (même géométrie, même objet :
skinning et instancing compris) ; les compteurs sont relus après chaque draw. Par pixel et par draw :
fragments **rastérisés** (sans test de profondeur), **calculés** (qui passent le test de profondeur
dans l'ordre réel : un early-Z parfait — un vrai GPU en rejette plutôt moins), **visibles** ; faces
avant / arrière à part ; carte de chaleur PNG par vue. Il simule aussi ce que laisseraient une
pré-passe de profondeur, d'autres ordres de triangles, d'autres tris ou découpes de lots, des faces
simples partout ; avec `DIAG=prepass`, il compte la pré-passe réelle du jeu.

**Mesure** (Givre LOW, 960 × 540, solo sans bot, 14 vues : les 8 points d'apparition, le centre du
village face aux 4 directions, la galerie nord, une vue en hauteur) — fragments du matériau de la carte **par pixel où
la carte est visible** (1 = chaque pixel calculé une seule fois) :

| vue | rastérisés | **calculés** | rejetés par l'early-Z | dont faces arrière | pré-passe complète (carte) | pré-passe ≥ 0,1 m² (carte) | **pré-passe livrée** (carte ≥ 0,1 m² + fond) | ordre idéal par vue | tri selon 8 directions | cellules de 20 m | tout en faces simples (pixels changés) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| spawn1 | 3,84 | **1,75** | 54 % | 12 % | 1,00 | 1,00 | **1,00** | 1,55 | 1,57 | 1,62 | 1,54 (97 px) |
| spawn2 | 6,51 | **3,32** | 49 % | 32 % | 1,66 | 1,67 | **1,01** | 2,08 | 2,10 | 2,18 | 2,32 (3528 px) |
| spawn3 | 4,08 | **2,42** | 41 % | 20 % | 1,00 | 1,03 | **1,03** | 1,56 | 1,56 | 1,88 | 1,96 (15 px) |
| spawn4 | 7,12 | **3,88** | 46 % | 4 % | 1,86 | 1,87 | **1,01** | 3,65 | 3,66 | 3,83 | 3,74 (17 px) |
| spawn5 | 6,80 | **2,34** | 66 % | 20 % | 1,06 | 1,13 | **1,05** | 1,52 | 1,39 | 2,22 | 1,90 (1221 px) |
| spawn6 | 4,30 | **1,49** | 65 % | 10 % | 1,00 | 1,04 | **1,04** | 1,28 | 1,24 | 1,53 | 1,36 (1632 px) |
| spawn7 | 2,72 | **2,12** | 22 % | 23 % | 1,00 | 1,00 | **1,00** | 1,32 | 1,34 | 1,41 | 1,65 (358 px) |
| spawn8 | 3,68 | **2,51** | 32 % | 26 % | 1,00 | 1,00 | **1,00** | 1,46 | 1,40 | 1,84 | 1,89 (15 px) |
| centre0 | 3,98 | **1,95** | 51 % | 36 % | 1,00 | 1,06 | **1,06** | 1,21 | 1,21 | 1,85 | 1,31 (6 px) |
| centre90 | 3,44 | **1,49** | 57 % | 22 % | 1,00 | 1,03 | **1,03** | 1,26 | 1,26 | 1,50 | 1,19 (90 px) |
| centre180 | 3,41 | **2,18** | 36 % | 10 % | 1,00 | 1,01 | **1,01** | 2,04 | 2,04 | 2,10 | 2,02 (671 px) |
| centre270 | 3,64 | **2,17** | 40 % | 18 % | 1,00 | 1,00 | **1,00** | 1,92 | 1,92 | 2,16 | 1,81 (319 px) |
| galerie | 4,81 | **1,25** | 74 % | 6 % | 1,00 | 1,01 | **1,01** | 1,23 | 1,24 | 1,25 | 1,20 (4405 px) |
| elevated | 5,87 | **1,57** | 73 % | 13 % | 1,00 | 1,00 | **1,00** | 1,22 | 1,25 | 1,33 | 1,40 (124 px) |
| **14 vues** | 4,34 | **2,13** | 51 % | 19 % | 1,08 | 1,10 | **1,02** | 1,61 | 1,60 | 1,85 | 1,74 |

(colonnes « pré-passe … (carte) » à « tout en faces simples » : simulées par l'outil sur le build d'avant ;
« pré-passe livrée » : comptée sur le build final avec `?diag=prepass` — 2 draws, 27 741 triangles, et
2,46 fragments de profondeur seule par pixel visible de la carte dans la pré-passe elle-même.)

- **L'early-Z fait déjà la moitié du travail** : le tri d'avant en arrière des lots
  (`frontToBackOpaqueSort`) rejette 51 % des fragments rastérisés. Mais il trie des **lots entiers**
  (6 cellules de 93 × 110 m, par le centre de leur sphère englobante), et dans un lot les triangles
  arrivent **dans l'ordre du BVH** (`MapBvh` réordonne l'index pour les tirs : un ordre spatial fixe,
  d'avant en arrière pour certaines directions de vue, d'arrière en avant pour les autres). Le lot
  double face de la cellule de la caméra couvre 34 à 100 % de l'écran ; chaque pixel qu'il couvre y
  est rastérisé 2 à 5,7 fois, et 6 à 82 % de ses fragments calculés finissent recouverts. Le lot des
  solides en face simple de la même cellule, dessiné AVANT lui (le centre de sa sphère est plus
  proche), est perdu à 86-100 % dans 7 vues sur 14 (77 000 à 230 000 fragments calculés pour rien
  dans 4 d'entre elles) : ses caisses et dalles sont derrière les murs.
  Les sols sont calculés deux fois (le sol extérieur passe sous le sol intérieur), les plafonds aussi
  (le toit est au-dessus), les bandes d'étals et de machines 5 à 8 fois (cartes de chaleur) ; les
  faces arrière des surfaces double face font 19 % des fragments calculés. **Vers la plaine** (spawn2,
  spawn4), le sol de la carte continue sous la plaine du fond (`givre_01_fond.glb`), dessinée après
  la carte : 40 à 46 % des fragments de la carte y sont calculés puis recouverts — une pré-passe de la
  carte seule y laisse encore 1,66 et 1,86.
- **Ce qui a été évalué** (même tableau, simulé sur le build d'avant) : *pré-passe de la carte* →
  1,00 (sauf vers la plaine) ; la même avec seulement les triangles ≥ 0,1 m² (≈ 26 k sur 134 k : murs,
  sols, toits, grands volumes) → presque autant (1,00 à 1,13 ; ≥ 0,25 m², ≈ 15 k triangles : jusqu'à
  1,32 ; ≥ 0,5 m², ≈ 10 k : jusqu'à 1,51) ; *ordre idéal des triangles pour chaque vue* (impossible à
  chaque image : la borne de toute réorganisation statique dans les lots) → −24 % seulement,
  l'overdraw ENTRE lots reste ; *tri statique selon 8 directions* (8 copies de l'index, choisie selon
  le cap de la caméra) → autant que l'idéal par vue, mais 8 copies de l'index et un BVH à part ;
  *cellules de 20 m d'avant en arrière* (≈ une découpe plus fine sans draw de plus) → −13 % ;
  *découpe 2 × 2 des lots* (spawns 1-5) → −5 % pour +14 à +34 draws ; *tri des lots par leur point le
  plus proche* (z − rayon, spawns 1-5) → −6 % pour la carte mais +28 % sur une vue, et +3 % pour
  l'ensemble des opaques ; *lots double face d'abord* → 0 ; *tout en faces simples* → −18 %, mais des
  pixels changent (des faces arrière sont réellement visibles : 6 à 4 405 px par vue) — exclu.

**Ce qui est fait — la pré-passe de profondeur** (`world/GivreDepthPrepass.ts`, `?diag=prepass`,
**désactivée par défaut** en attendant la vraie carte graphique) : avant tout le reste, la carte
statique est dessinée en **profondeur seule** (pas d'écriture de couleur, shader de fragment vide) ;
la passe monde reste **inchangée** (test LEQUAL, celui de three par défaut) : un fragment de la carte
ne passe plus que là où il EST la surface la plus proche. Seuls les triangles ≥ 0,1 m² y vont
(`GivreConfig.staticBatching.depthPrepassMinArea` ; `?diag=prepass,prepassall` = tous) : les grands
occulteurs font presque tout le travail, pour un cinquième des triangles ; la plaine et les montagnes
du fond (2 meshes, 2 116 triangles) y sont aussi. Au total : **27 741 triangles et 31 576 sommets**
(les lots et le fond en ont 233 880), contre 136 680 triangles et 85 442 sommets pour une pré-passe
complète (`prepassall`). Les proxys sont des maillages de positions seules, soudés au bit près (les
coutures UV / normales des lots dédoublent des sommets inutiles ici), **un par côté de face : 2 draws**
(découpés par cellule de la grille, ils n'étaient jamais éliminés par le culling dans les vues
mesurées : des draws pour rien — option `cells`), dans un groupe d'ordre −1000 (dessinés avant tout
opaque).

**Même image au bit près** si aucune profondeur de la pré-passe n'est plus PROCHE que celle que la
passe principale calcule pour le même fragment : alors, en chaque pixel, la profondeur stockée est
≥ la plus proche m, et avec LEQUAL la passe principale garde, comme avant, le DERNIER fragment
dessiné à la profondeur m ; transparents et ciel testent le même tampon final. C'est vrai pour
n'importe quel sous-ensemble des fragments opaques de la passe principale (d'où le filtre par aire
possible) — mais jamais un fragment qu'elle ne dessine pas (une face arrière d'un lot FrontSide :
d'où un proxy par côté). La profondeur est la même parce que : mêmes triangles (positions copiées
au bit près, sommets dans le même ordre), même matrice (identité, comme les lots et le fond : three
calcule le même `modelViewMatrix` ; un mesh avec une autre matrice est refusé), même calcul (les
chunks `begin_vertex` + `project_vertex` de three, et les deux programmes déclarent
`invariant gl_Position` — GLSL ES 3.00 §4.6.1 : même expression, mêmes entrées, même valeur d'un
programme à l'autre), et seulement des meshes simples (`prepassEligible` : ni skinning, ni morph, ni
instancing, ni displacement, ni alpha test / hash, ni clipping, ni polygon offset, ni patch de
shader inconnu ; pas de depth buffer logarithmique). **Et c'est vérifié sur le GPU du joueur** : au
chargement (`Game.warmUpRendering`), la même image est rendue avec et sans la pré-passe depuis deux
vues et relue — au moindre pixel différent, la pré-passe est coupée pour la session
(`[GPU] pré-passe de profondeur DÉSACTIVÉE : …` dans la console).

**Évalué, laissé en expérience — faces simples par composante connexe** (`?diag=percomponent`,
`GivreRenderOptim.closedOutwardThinTriangles`) : la règle existante (solide fermé, orienté vers
l'extérieur, ≤ 2 m → `FrontSide`) ne s'applique qu'au mesh ENTIER — or un mesh du glb regroupe
souvent plusieurs solides disjoints (dalles de toit sur toute la carte, un rack de caisses, une
rangée de sapins) dont la boîte commune est épaisse, ou un solide et une partie ouverte. Appliquée à
chaque composante connexe : 66 870 triangles de la carte sur 134 564 en face simple au lieu de
24 588 (18 → 50 %, mêmes 16 lots). Mais **pas la même image au bit près**
(`tools/perf/prepass-ab.mjs`, `MODE=xsession` : deux sessions, partie statique du monde) : 14 à 400
pixels changent par vue (spawn6 14, spawn8 400, vue en hauteur 168 ; jusqu'à 80 niveaux sur 255) —
et presque autant avec une soudure de 1 mm au lieu de la soudure exacte (0 à 403 pixels sur 14 vues) :
ce ne sont pas des fissures. Ce sont des **égalités de profondeur** : sur l'arête arrière des toits
d'étals vus de haut, sur l'arête d'une nervure de conteneur vue en rasant, la face arrière d'un
solide mince tombe à la même profondeur que sa face avant dans le tampon 24 bits et, dessinée après,
l'emporte (LEQUAL) — un léger z-fighting, que la face simple fait disparaître. Plus propre, mais pas
identique : désactivée (`GivreConfig.staticBatching.singleSidedPerComponent`), gardée en expérience.
Le gain serait de toute façon faible avec la pré-passe, qui supprime déjà le calcul des faces arrière
cachées (il ne resterait que leur rastérisation) ; le 11ᵉ passage a d'ailleurs mesuré « faces doubles
→ simples » dans le bruit sur l'Iris Xe.

**Banc A/B** (`tools/perf/prepass-ab.mjs`, build final, solo avec 3 bots, image complète du
composer relue — monde, bras, sortie, FXAA / MSAA —, RGBA) : avec `?diag=prepass`, pré-passe
affichée, cachée (mêmes programmes), cachée avec les programmes de production (sans `invariant`),
puis affichée à nouveau :

| Givre | vues | affichée / cachée | affichée / programmes de production | répétition | draws | triangles |
|---|---|---|---|---|---|---|
| LOW (FXAA) | 14 : les 8 spawns, le centre × 4, la galerie, la vue en hauteur | **0 pixel** | **0 pixel** | 0 | +2 (42-50 → 44-52 avec les bots) | +27 741 |
| HIGH (MSAA 4×) | 6 : spawn1, spawn2, spawn4, centre0, la galerie, la vue en hauteur | **0 pixel** | **0 pixel** | 0 | +2 (48-55 → 50-57) | +27 741 |

Dans chaque session, le contrôle du jeu au chargement a gardé la pré-passe (« image identique avec /
sans (1 036 800 pixels comparés, 2 draws de profondeur) »). Une première version (12 proxys, triangles
≥ 0,5 m², sans le fond) : 0 pixel aussi, sur 14 vues LOW et 7 vues HIGH.
**Temps d'une image SwiftShader** (rendu logiciel sur un processeur partagé par plusieurs bancs : pas
un GPU) — 5 images de chaque état en alternance, LOW : spawn2 1 928 → 2 480 ms, centre0 3 387 →
2 009 ms, galerie 1 775 → 1 732 ms (somme −12 %), mais les 5 images d'un même état vont du simple au
triple (centre0 sans pré-passe : 1 285 à 3 690 ms) : **pas concluant**, dans un sens comme dans
l'autre (première version : −2 % en LOW, −7 % en HIGH, 3 images). Ce banc ne dit rien du gain sur un
GPU : c'est la mesure ci-dessous qui décidera.

**Ce qu'il faut mesurer sur la vraie carte graphique** — Iris Xe, Givre LOW, même vue (le centre du
village, un point d'apparition face à la plaine), fenêtre au premier plan, à une taille où le GPU
limite (2560 × 1238) : `?gpu=draws` contre `?gpu=draws&diag=prepass` — la ligne `GPU` (total,
« carte » et « pré-passe ») et les FPS, et la console doit dire `pré-passe de profondeur active`
(si elle dit `DÉSACTIVÉE : N pixels…`, ce pilote — ANGLE / Direct3D 11 — ne donne pas la même
profondeur aux deux programmes malgré `invariant` : la pré-passe reste coupée, sans effet visible,
et c'est la première chose à remonter).
Attendu : « carte » −35 à −50 % (la moitié des fragments calculés en moins), « pré-passe » ≈ 0,1 à
0,4 ms (≈ 28 k triangles, profondeur seule). Si le gain est net : `?diag=prepass,prepassall` (tous
les triangles de la carte, 136 k) donne le coût des sommets d'une pré-passe complète sur cette puce.
Sur le PC (RTX 2080 Super, 240 Hz) : la ligne `CPU` avec et sans (2 draws de plus, attendu
< 0,05 ms). Si le gain GPU du portable est net et le CPU du PC inchangé : `depthPrepass: true` dans
`GivreConfig` (`?diag=noprepass` resterait pour comparer). À savoir : un GPU qui élimine lui-même les
surfaces cachées avant de les calculer (Apple, la plupart des mobiles) n'y gagne rien et paie la
pré-passe — à mesurer sur un Mac avant de l'activer pour tous.

## Le HUD au repos, aux tirs et au kill (16ᵉ passe)

Mesuré par le chef sur le portable perso (Intel Iris Xe, build de production, HUD dans son
iframe, Givre en solo, 1080p) : **l'animation d'attente du Bean Buddy, à elle seule, faisait rater
les 60 FPS** — 45-46 FPS avec le HUD, 59,9 en cachant l'iframe, 60,1 en cachant le seul portrait.
Animation par animation (les autres tournant) : feuilles + clignement 52,8 FPS, chevrons du dash
56,5, touche du dash 49,8, **respiration du portrait (`scale` sur la racine `<svg>`) 60,1** ; et
`will-change: transform` sur `.buddy-art` seul : 60,1 FPS, 0 image en retard (correctif mis en
production). Avec lui, en tirant au Paintball : 52-53 FPS, `HUD: iframe isolée · 55 FPS · JS 0.2 ·
rendu 4.5 ms`, une saccade de 30 ms dont 21 d'attente du GPU au tir ; HUD dans la page (`npm run
dev`) : 8 à 10 ms de `Browser` en moyenne à la panique (HP bas) et au kill. Le HUD rastérise dans
le processus GPU du navigateur, celui qui exécute aussi le WebGL du jeu.

Le banc image par image (`node tools/perf/hud-frame-bench.mjs --base <rev> --set states|events` :
le vrai document du HUD dans son iframe, piloté par un match scripté, une liste de commandes par
image comme le jeu ; trace Chrome du processus du HUD) montrait, **au repos** : une image
principale à chaque rafraîchissement (style, mise en page, pre-paint, layerize, commit), **~6,4
tuiles rastérisées par image** (les couches des feuilles, des yeux et du corps du Bean Buddy,
rastérisées de nouveau à chaque image) et **2 passes hors écran par image** (les chevrons du dash
découpés par `clip-path`). Les causes et ce qui a changé :

1. **Animations CSS d'enfants SVG et de la racine `<svg>`** (feuilles, yeux, goutte de sueur du
   Bean Buddy ; sa respiration, sur la racine `<svg>` du portrait) : Chrome ne les confie pas au
   compositeur (« TransformCannotBeAcceleratedOnTarget » dans la trace) — à chaque
   rafraîchissement, une image principale, le style et la mise en page du SVG, et les couches du
   portrait rastérisées de nouveau. Le portrait est maintenant un **empilement
   de calques SVG** (`hudIcons.BEAN_BUDDY_LAYERS`) — tige, feuille gauche, feuille droite, corps +
   visages, yeux, goutte : chaque partie animée a son propre `<svg>` (même boîte, même viewBox),
   dans une `<div>` que l'animation fait tourner / cligner / tomber, une transformation que le
   compositeur joue seul. Mêmes formes (les 40 du SVG, testées), même ordre
   de dessin là où elles se touchent, mêmes pivots (ceux des enfants SVG, `transform-box:
   fill-box`, convertis en px de la boîte), mêmes durées (`scripts/test-hud-buddy-layers.mts`). Les
   yeux et la goutte gardent le groupe de leur visage (les règles d'humeur les montrent et les
   cachent comme avant). Et le correctif du chef : `will-change: transform` sur `.buddy-art` (pas
   pendant la pose figée de la mort) et sur chaque calque animé — composé dès sa première image,
   à une échelle de rastérisation fixe (sans lui, la pose inclinée de la mort re-rastérisait les
   feuilles à chaque image).
2. **`clip-path` / `mask` sur un élément animé** (chevrons du dash prêt, étincelles du soin,
   anneau de recharge qui tourne — toutes les armes) : un calque de masque et une passe hors écran
   par élément et par image. La forme découpée est maintenant sur un enfant immobile (`::before`),
   peinte une fois dans le calque qui bouge.
3. **`background-position` animé** (la vague du réservoir du FAMAS, au repos aussi) : une peinture
   par image. Le même motif sur un enfant d'une tuile plus haut, glissé par `transform`.
4. **La boucle d'images permanente du document du HUD** (un `requestAnimationFrame` qui se
   relançait toujours, pour compter les images) : à la demande (`hud/runtime/frameClock.ts`) — une
   image quand un lot de commandes change le DOM ou qu'un widget en demande une ; FramePulse et les
   nombres de dégâts dédoublonnent sur le numéro d'image (même sémantique,
   `scripts/test-hud-frame-clock.mts`). La ligne `HUD:` compte maintenant les images que le
   document dessine (`images/s`).

5. **La bannière « K.O. »** (au sol) : `translateX(-50%)` dans ses images clés dépend de la taille
   de la boîte (« TransformDependsOnBoxSize ») — une image principale à chaque rafraîchissement
   tant qu'elle est affichée. Le centrage est passé dans la propriété `translate`, que l'animation
   ne touche pas : mêmes matrices, images clés sans pourcentage.

Les autres animations du HUD (humeurs, tremblement et rayons de panique, battements de la vie, du
chrono et des munitions basses, plaques, combo, médailles, fil des kills, viseur, nombres de
dégâts) sont des transformations / opacités jouées par le compositeur. Restent sur le thread
principal, brèves et sans peinture ni rastérisation (leur élément a sa couche) : la chute de
l'étiquette du combo (0,45 s, `visibility` dans ses images clés, voulu : règle 46) et la sortie de
l'aide des commandes (une fois par partie, `translateX(-50%)` comme la bannière). Les avatars du
classement n'ont pas d'animation.

Banc (960 × 540, SwiftShader, rastérisation logicielle ; par image du scénario, dans le processus
du HUD ; chaque état tenu 3 s ; `?diag=hudanim` redonne exactement les chiffres « avant ») :

| État | Tuiles rastérisées / image | Peintures / image | Mises en page / image | Passes du compositeur / image |
|---|---|---|---|---|
| Au repos (content, dash prêt) | 6,42 → **0,02** | 0,29 → 0,03 | 1,07 → 0,02 | 3 → **1** |
| Inquiet / K.O. puis « PRESS SPACE » / fin de partie | 4,2-6,4 → **0,02-0,03** | 0,03-0,31 → 0,03-0,05 | 1,06 → 0,02 | 3 → 1 |
| Panique (rayons, tremblement, goutte) | 0,02 → 0,02 | **2,15 → 0,03** | 1,07 → 0,02 | 3 → 1 |
| Mort (pose inclinée, compte à rebours) | 2,32 → **0,32** | 0,33 → 0,33 | 1,07 → 0,16 | 4 → 2 |
| Dash en recharge (compte à rebours) | 6,67 → 0,26 | 0,61 → 0,36 | 1,07 → 0,16 | 1,47 → 1 |
| Combo (la corde brûle) | 6,48 → 0,03 | 0,05 → 0,05 | 1,08 → 0,02 | 3 → 1 |
| Paintball au repos / bas / en recharge | 6,3-6,4 → **0,03-0,07** | ≤ 0,31 → ≤ 0,07 | 1,06 → 0,02 | 3-3,5 → 1-1,5 |
| Popcorn au repos · Frisbee au repos | 6,47 · 6,32 → 0,03 · 0 | 0,31 · 0,10 → 0,05 · 0 | 1,07 → ≤ 0,02 | 3 → 1 |
| FAMAS au repos / bas / en recharge | 7,4-7,6 → **0-0,02** | **2,1-2,3 → 0-0,03** | 1,06 → 0-0,01 | 3 → 1-2 |

Et le thread principal du document du HUD (sans l'agent LayerTree de DevTools, qui force à lui
seul une image principale à chaque rafraîchissement) : **au repos, 1,06 image principale par image
→ 0,02** (le chrono, une par seconde) — plus de style, de mise en page, de pre-paint ni de commit
par image ; 2,1 → 0,5 ms de thread principal par image au banc (l'application des commandes du
jeu comprise) ; à l'inquiétude, à la panique, au K.O. et à « PRESS SPACE TO GET UP » (comme dans le
jeu : au sol d'abord, debout possible ensuite), au FAMAS au repos : pareil (0,02). Toutes les
animations du HUD au repos tournent sur le compositeur (vérifié en les relançant pendant une
trace : aucune « NOT composited » ; avant, les cinq animations du Bean Buddy l'étaient — y compris
la respiration, sur la racine `<svg>` du portrait : « TransformCannotBeAcceleratedOnTarget »). Plaque Paintball / Popcorn : une image principale par
rafraîchissement demeure, celle de la boucle de la peinture 3D (sans peinture ni rastérisation).

### Aux événements

Contre l'ancien code (plaque Paintball ; mêmes unités) :

| Phase | Tuiles / image | Passes / image |
|---|---|---|
| Repos | 6,32 → 0,02 | 3,00 → 1,00 |
| Tir continu, touches (15 tirs en 1,5 s) | 6,95 → **0,51** | 3,32 → **1,30** |
| Kill à la tête (médaille, combo, BEANED!, classement, nombre) | 6,08 → **1,22** | 7,84 → 5,84 |
| Dégâts reçus | 4,90 → 0,68 | 5,31 → 3,23 |
| Recharge (anneau qui tourne) | 6,50 → **0,20** | 3,32 → 1,24 |

**Contre le build de production** (l'ancien code + `will-change: transform` sur `.buddy-art`,
injecté au banc ; deux runs alternés ; « rendu » = la stat de la ligne `HUD:`, du rappel d'image
du document au message posté après son rendu, ici sans le tirage de la peinture 3D, que le banc
saute) :

| Phase | Passes / image | Mises en page / image | Peintures / image | « rendu » (ms / image) |
|---|---|---|---|---|
| Repos (plaque Paintball) | 3,01 → **1,00** | 1,06 → 0,02 | 0,23 → 0,03 | 1,96 → 1,44 |
| Tir continu, touches | 3,33 → **1,31** | 1,08 → 0,13 | 0,99 → 0,70 | **2,87 → 2,45** |
| Kill à la tête | 8,26 → 6,19 (5,84 avec la médaille) | 1,10 → 0,10 | 0,98 → 0,78 | 2,91 → 2,96 |
| Dégâts reçus | 5,32 → 3,29 | 1,06 → 0,06 | 0,31 → 0,37 | 2,43 → 1,99 |
| Recharge | 3,28 → 1,27 | 1,06 → 0,05 | 0,56 → 0,24 | 2,63 → 2,13 |

Le correctif du portrait supprimait déjà la rastérisation par image (mêmes tuiles des deux
côtés hors kill : 0,02 au repos, 0,51 en tirant) ; restaient, **à chaque image**, deux passes hors
écran (les chevrons du dash), le style et la mise en page du SVG du portrait et, sans plaque à
peinture 3D, une image principale complète — c'est ce que cette passe enlève, tirs compris.

**À chaque tir** (couches rastérisées, `--layers`) : le chiffre des munitions (son texte change :
une rastérisation de 32 × 36 px par tir), son « /max » (28 × 19 px : le saut du chiffre, joué par
le compositeur, l'emmène dans une couche à part et « /max », peint après lui, doit suivre —
peindre le chiffre par-dessus évite celle-là mais fait repeindre plus souvent la couche de la
plaque : essayé, mesuré, pas gardé), le nombre de dégâts (il grandit à chaque touche : 133 × 95
px), une bille toutes les ~3 balles, la couche de la plaque au début et à la fin d'une rafale. Une
passe hors écran de plus pendant les 0,26 s du « flash » d'une bille dépensée (`brightness()`, joué
par le compositeur sur sa propre couche). Et la peinture 3D, redessinée à chaque image tant
qu'elle bouge (toute la rafale, voir plus bas).

**Au kill** (passes par image sur la phase, en cachant une partie du HUD à la fois) : la médaille ≈
1,9 (son entrée et sa sortie : une opacité animée sur un groupe de couches), le nombre de dégâts
du kill ≈ 0,7 (le `brightness()` de son « slam », 0,5 s), l'étiquette du combo ≈ 0,6 (son entrée)
— des effets de groupe qui ne se refont pas autrement à l'identique. Rastérisations : **l'ombre
des pans du ruban de la médaille** (`filter: drop-shadow` sur ses deux petits SVG) faisait
repeindre et re-rastériser tout le ruban, libellé à contour compris, à chaque image du pop — ~30
fois par kill ; elle est maintenant une copie du pan dans la couleur de l'ombre, 3 px plus bas, à
85 % d'opacité (`hudIcons.ribbonTailSvg`, `scripts/test-hud-medal-tails.mts`) : ruban 26 repeints
/ 32 rastérisations → 1 / 3 par kill. Le classement : ~0,3 tuile par image au kill (ses lignes qui
bougent prennent puis rendent leur couche).

**Pixels** (`tools/hud-preview/runtime-harness.mjs --software --rest`, 1280 × 720, iframe : les
14 points de contrôle du match scripté, chacun tel quel et **au repos** — animations sans fin à
leur début ; bruit de l'ancien code d'un run à l'autre : 0 pixel) : **hors du portrait, de la
plaque du FAMAS et de la médaille, 0 pixel de différence** (classement, chrono, combo, fil, viseur,
nombres de dégâts, bannière K.O., écran de mort, plaques Paintball / Popcorn / Frisbee). Portrait : 1 800 à 2 500 pixels
(0,2-0,3 % de l'image), dont 40 à 240 de plus de 32 niveaux (max 60-100) — l'anticrénelage du
contour du Bean Buddy, que le compositeur rééchantillonne depuis une échelle de rastérisation fixée
(`will-change`) et depuis des couches séparées, là où l'ancien code le rastérisait à chaque image ;
invisible à l'œil. Plaque du FAMAS : ≤ 900 pixels, presque tous ≤ 8 niveaux, ≤ 17 de plus de 32
(max 190) au bout arrondi du tube, où la couche de la vague rencontre la découpe arrondie.
Médaille, pendant qu'elle est affichée (4 captures sur 28) : 5 200 à 13 100 pixels (0,6-1,4 % de
l'image), max 61-82, dont 115 à 366 de plus de 32 niveaux — le ruban n'est plus re-rastérisé à
chaque image de son entrée : rastérisé une fois (à la plus grande échelle du pop, son `will-change:
transform`) puis rééchantillonné par le compositeur, ses bords et son libellé diffèrent d'un
anticrénelage ; côte à côte, rien ne se voit. L'ombre des pans elle-même est la même (même forme,
même décalage, même couleur, testés). **C'est le seul écart qui ne tient pas qu'aux bords de formes
animées : à juger par le chef** (`?diag=hudanim` remet l'ombre filtrée). `?diag=hudanim` contre
l'ancien code : identique sur 25 captures sur 28 (médaille comprise) ; 4 pixels (max 40) sur 3
captures, à la vague du FAMAS (la remise à zéro de son animation par le harness).

**La peinture 3D des plaques** (Paintball, Popcorn, Poison : son propre contexte WebGL ; `+
peinture HUD` = son temps GPU avec `?gpu`) : une seule passe (un quad plein cadre), dessinée à
chaque image tant qu'elle bouge (après chaque tir, ~1-2 s de gelée), 20 fois par seconde pendant
la lente coulure, jamais quand elle est figée ; en 1080p (zoom de la plaque 1,66, DPR 1) son
canvas fait 678 × 378 pixels pour 375 × 209 pixels d'écran (suréchantillonnage × 2 par axe,
plafonné à 3 px par px de plaque : « l'aspect du rendu × 3 »), soit 3,3 fois les pixels affichés —
le coût de ~3 ms par image en tirant vu sur l'Iris Xe. Rien d'exact à gagner : un « culling » par
grappe du raymarch a été essayé (même champ au bit près, 64 états comparés, 0 valeur RGBA
différente) mais il est **57 % plus lent** au banc (3,0 → 4,7 s de tirages) — pas gardé ;
découper le tirage aux zones peintes n'enlèverait que les pixels déjà rejetés à bas coût par le
shader. Trois expériences pour juger sur le vrai GPU — pas les mêmes pixels (comparés au banc sur
64 états d'une rafale puis des coulures, image affichée en 375 × 209 filtrée comme le fait le
compositeur) : `?diag=paintss150` (565 × 315 pixels : −32 % de temps de tirage ; 4,7 % des pixels
peints diffèrent de plus de 32 niveaux, aux bords et aux reflets), `?diag=paintss100`
(suréchantillonnage × 1 : 396 × 221 pixels, −64 % ; 12 % des pixels peints à plus de 32 niveaux) et
`?diag=paintfps30` (gelée redessinée à 30 images/s au plus pendant qu'elle bouge : deux fois moins
de tirages en tirant, un mouvement moins fluide). Plus aucune allocation par tirage
(`PaintGL.draw`).

## Le shader de la carte, terme par terme (19ᵉ passe)

Ce que three r185 calcule pour chaque pixel de la carte (programme « uber » texturé, lu dans
`renderer.info.programs`) : couleur de sommet, rugosité / métal / émissif par sommet, deux
lightmaps 2048² (émissive sRGB + AO, mêmes `uv`), soleil (GGX + compensation de diffusion
multiple : 2 lectures de la table DFG) avec son ombre PCF (**5 prises** matérielles 2 × 2 sur un
disque de Vogel tourné par pixel : 5 cos + 5 sin), lumière hémisphérique, et la lumière
d'environnement (IBL : 2 `computeMultiscattering`, chacun une lecture DFG aux mêmes coordonnées)
— sans env map sur Givre.
Données réelles : métal **0** partout, rugosité 0,06 (verglas) à 0,92 (neige), pas de couleur de
sommet dans le glb (couleur constante par objet), aucune AmbientLight, aucune lumière ponctuelle.

| Terme | Verdict | Mesure (banc, 13 poses, LOW + HIGH, 960 × 540) |
|---|---|---|
| IBL (lumière d'environnement) | retiré — exact | ajoutait exactement 0 (rayonnement nul sans env map) : 0 pixel |
| Métal (mélanges, attribut, varying) | replié — exact | 0 sur chaque sommet : 0 pixel |
| Deux coordonnées de lightmap | une seule — exact | même `uv`, même transformation : 0 pixel |
| Soleil où N·L ≤ 0 ou ombre = 0 | sauté — exact | le shader d'origine y ajoutait 0 : 0 pixel ; sauté sur 2 à 98 % de l'écran selon la vue |
| Diffusion multiple du soleil | `mapshaderfast` — quasi exact | ≤ 6,6·10⁻⁵ en linéaire ; 1 niveau sur 0,10 % des pixels (avant FXAA) |
| Rotation du disque PCF | `mapshaderfast` — quasi exact | mêmes prises à ~10⁻⁶ texel près ; 1 niveau sur 0,003 % des pixels |
| Spéculaire du soleil | **gardé** | pas négligeable : sans lui 30 % des pixels changent (jusqu'à 145 niveaux), même sur les seuls matériaux rugueux (≥ 0,75 : 29 %, jusqu'à 106) — soleil rasant, Fresnel fort sur la neige |
| PCF 1 prise au lieu de 5 | **compromis, non fait** | ombres plus dures : 3,3 % des pixels en LOW (jusqu'à 83 niveaux), 0,66 % en HIGH |
| Lumière hémisphérique | gardée | ~10 instructions ; par sommet, l'image changerait (normale renormalisée par pixel) |
| AO + émissive dans une texture | `mapshaderao` — exact au banc, **à mesurer** | l'AO dans l'alpha de la lightmap émissive (empaquetée au chargement, chaque niveau de mip, octet pour octet) : une lecture au lieu de deux par pixel (jusqu'à une texture 2048² de moins en mémoire vidéo) ; 0 pixel de différence (13 poses, LOW et HIGH, anisotrope 8× compris) ; au banc 3 à 9 % de plus que le défaut en LOW, ~20 % en HIGH (la lecture anisotrope 8× de l'AO est chère en logiciel). Pas par défaut : l'empaquetage relit les deux images par un canvas 2D au chargement (temps sur la ligne `[CARTE]` : 0,2 s au banc ; +21 Mo de mémoire JS), et cette relecture est brouillée exprès par les protections anti-empreinte (Brave par défaut, Safari en navigation privée, Firefox `resistFingerprinting`) : l'image n'y serait plus exacte ; et sur un vrai GPU rien ne garantit que l'alpha d'une texture sRGB est filtré avec le même arrondi que le rouge d'une texture linéaire (tous deux 8 bits linéaires). Les deux lectures ensemble étaient dans le bruit sur l'Iris Xe en LOW (19ᵉ passe, filtrage 1×) : le gain réel est à mesurer, surtout en HIGH. Pour en faire le défaut : une lightmap RGBA empaquetée **hors ligne**, livrée avec la carte (plus de relecture) |
| AO / émissive dans les sommets | non fait | les lightmaps varient dans les triangles : exact seulement où l'empreinte filtrée (3 niveaux de mip, anisotrope) est constante — invérifiable sûrement |
| Varyings `flat` (constantes par objet) | non fait | sous Windows, ANGLE / D3D11 doit émuler le sommet provoquant d'OpenGL pour un varying flat (c'est la raison d'être de l'extension `WEBGL_provoking_vertex`) : risque d'être plus cher sur la machine visée, pour 7 interpolations de moins |

**Mesures.** Pixels : `tools/perf/map-shader-check.mjs` (sortie du canvas en RGBA, 960 × 540,
13 poses : spawn, les 9 points de vue, soleil bas de face, plongée sur la cour, verglas). Temps :
la passe monde seule, une pose figée, sur SwiftShader (un GPU logiciel : le temps CPU de son
processus = le travail du GPU, au centième de seconde), médiane de 5 rendus alternés entre
variantes. C'est un ordre de grandeur des instructions et des lectures économisées, pas une
prévision : une vraie carte cache les textures, recouvre une partie des calculs par les lectures,
et paie les branches par paquets de pixels (le saut du soleil gagne surtout sur les grandes zones
d'un seul tenant : salles, dessous des toits, faces à contre-jour).

Piège du banc : une session ouverte avec `?diag=mapshaderao` ne dessine les matériaux d'origine
qu'à la première comparaison, et leurs lightmaps partent alors tard au GPU ; or, au banc, un envoi
**tardif** des niveaux de mip des lightmaps (des canvas 2D, `buildLimitedMipmaps`) ne donne pas ce
que contiennent ces canvas (niveaux 1 et 2 faux, jusqu'à 255 niveaux — lu sur le GPU), ce qui
faussait la référence (7 % des pixels « différents »). `map-shader-check` avec `DIAG=` envoie ces
niveaux depuis leurs pixels : 0 pixel de différence, lightmap empaquetée au chargement comprise. Le
jeu, lui, envoie ses lightmaps au chargement (vérifié). À garder en tête : une restauration du
contexte WebGL les renverrait tard — à vérifier sur un vrai GPU ; garder ces niveaux en `ImageData`
plutôt qu'en canvas réglerait la question.

| Givre, 960 × 540 (série 1) | soleil sauté (LOW) | origine | défaut (exact) | quasi exact, sans AO empaquetée |
|---|---|---|---|---|
| LOW spawn (salle) | 98 % de l'écran | 720 ms | 610 (−15 %) | 590 (−18 %) |
| LOW cour centrale | 4 % | 380 | 370 (−3 %) | 350 (−8 %) |
| LOW chaufferie | 76 % | 630 | 560 (−11 %) | 500 (−21 %) |
| LOW couloir ouest | 80 % | 480 | 430 (−10 %) | 400 (−17 %) |
| HIGH spawn | — | 1 690 | 1 540 (−9 %) | 1 520 (−10 %) |
| HIGH cour centrale | — | 970 | 920 (−5 %) | 870 (−10 %) |

Série 2, avec l'AO empaquetée (le banc redémarré sur 2 cœurs : temps ~2 × plus longs et plus
bruités — à lire entre colonnes d'une même ligne) :

| Givre, 960 × 540 (série 2) | origine | défaut | `mapshaderao` | quasi exact sans AO | `mapshaderfast` |
|---|---|---|---|---|---|
| LOW spawn | 1 390 ms | −19 % | −21 % | −20 % | −26 % |
| LOW cour centrale | 740 | −7 % | −11 % | −8 % | −18 % |
| LOW chaufferie | 1 130 | −11 % | −19 % | −16 % | −22 % |
| HIGH spawn | 3 320 | −4 % | −23 % | −13 % | −23 % |

Terme par terme (série 1, LOW spawn, 720 ms à l'origine) : soleil sauté seul −10 % ; IBL retirée
seule 0 % (le compilateur de SwiftShader éliminait déjà ce terme nul ; celui d'un pilote le fait
sans doute aussi — le retrait reste une simplification sûre) ; compensation de diffusion multiple
seule −12 % (deux lectures de la table DFG par pixel, partout dans le shader d'origine ; le défaut
n'en garde que sur les pixels au soleil) ; rotation PCF seule −4 %. Sur le défaut : la lecture de
l'AO coûte 8 % (13 % en HIGH, filtrage anisotrope 8×), le PCF à 1 prise au lieu de 5 en ferait
gagner 11 % (compromis visuel, non retenu).

## Réglages graphiques et détection automatique (page SETTINGS)

La page **SETTINGS** (menu principal et menu pause, `menu/SettingsPage.ts`) remplace le petit menu
SETTINGS d'avant : préréglages **Auto / Low / Medium / High / Ultra / Custom**, chaque option
réglable une à une (résolution de rendu en % de la définition de l'écran, au pour cent près ;
anticrénelage aucun / FXAA / MSAA 2× / 4× ; ombres désactivées / statiques / dynamiques, leur qualité,
celles des personnages ; neige, halos, empreintes, particules ; filtrage anisotrope ; limite d'images
par seconde ; panneau de performances), le réticule, l'audio, et une carte de mesure en direct (FPS
délivrés, image médiane et lente, processeur, taille du rendu). **Low** et **High** sont exactement
les anciens LOW et HIGH. Tout s'applique en direct, sans compiler de shader, sauf le mode d'ombres,
les ombres des personnages et le MSAA de Jungle / Yard (attribut du contexte WebGL) : signalés, appliqués
par « Apply & reload ».

**Détection automatique** (`settings/AutoTune.ts`, au premier lancement sur chaque carte et chaque GPU,
ou à la demande) : une **échelle** de configurations, du meilleur (définition native, MSAA 4×, ombres
les plus fines, filtrage 16×) au **plancher** (l'ancien LOW : un pixel par pixel CSS, FXAA, filtrage 1×,
neige légère), en retirant d'abord ce qui se voit le moins. Mesurée sur la vraie carte (le menu, caméra
immobile pendant la mesure, avec la passe des bras d'une image de jeu — sa résolution MSAA comprise ; ou
la vue de pause), **par les intervalles entre images** — pas par des requêtes de chronométrage GPU
(11ᵉ passe : elles comptent les temps morts du GPU et font flusher Chrome). Un écran à 60 Hz montre
60 FPS à 10 ms comme à 16 ms de travail : chaque candidat est donc mesuré avec **30 % de pixels en
plus** — s'il tient encore l'objectif, il garde ~23 % de l'image libre pour les combats (le rendu
d'origine, lui, est gardé avec la moitié de cette marge : il ne part que s'il manque nettement). **Deux
objectifs** : 60 FPS doivent tenir (pour eux l'image peut descendre jusqu'au plancher) ; la fréquence
de l'écran est souhaitée (jusqu'à 240), mais jamais au prix de passer sous le **rendu d'origine** de ce
GPU (son ancien préréglage : High, Low sur les puces intégrées) — une machine qui tient 60 FPS garde
au moins l'image qu'elle a toujours eue. Le plancher d'abord (quels objectifs sont atteignables ?), puis,
s'il en manque un, la même vue à moitié de pixels : beaucoup plus rapide = la carte graphique limite ;
pas plus rapide = le processeur ou le navigateur (les graphismes restent en haut, ils n'y changeraient
rien). Puis le haut de chaque plage (une seule mesure sur une machine puissante) et une recherche
dichotomique. Les images d'une fenêtre sans le focus sont ignorées. Une réponse, stockée par carte, GPU
et objectif : la détection ne se relance jamais d'elle-même sur la même machine (pas d'oscillation), et
le joueur garde la main. Sur les machines simulées d'après les mesures de la 11ᵉ passe
(`scripts/test-graphics-autotune.mts`) : le portable Iris Xe (60 Hz) passe de l'ancien LOW
(1920 × 928) à la définition native **2400 × 1160**, FXAA, ombres statiques en haute taille, filtrage
4×, avec ~40 % de l'image libre ; le PC RTX 2080 Super à 240 Hz garde High ou mieux ; une carte
moyenne sur un écran 144 Hz garde High à plus de 60 FPS au lieu de descendre pour 144 ; une petite
carte qui tient 60 FPS en High avec peu de marge garde High — et sur un écran 144 Hz, où chaque image
de High lui prend trois rafraîchissements (48 FPS), elle descend juste ce qu'il faut pour 60. Le résumé
affiché dit la marge réellement mesurée et quand le rendu d'origine a dû baisser. (Ce modèle de l'Iris Xe
était optimiste : le vrai portable a choisi 90 % du natif, 2160 × 1044 ; le modèle « calé sur le terrain »
ci-dessous reproduit ce choix.)

### « Auto » en partie : la marge de la détection et le garde (rapport de terrain du portable du travail)

Sur le portable du travail (Iris Xe, Chrome, ~1874 × 956), « Auto » tenait 60 FPS au début de la partie,
puis non. La détection mesure le menu — une vue fixe, une puce froide dans sa fenêtre turbo, un thread
principal sans IA ni physique — et garde sa réponse pour toujours. Une partie ajoute les bots, leurs
effets et le HUD, occupe le processeur (sur ces puces processeur et GPU partagent **une** enveloppe de
puissance), et après une à trois minutes la puce revient à sa puissance soutenue (encore moins sur
batterie ou avec un plan d'alimentation d'entreprise). Sur un écran 60 Hz, 10 % au-dessus des 16,7 ms
d'une image coûtent déjà ≈ 5 FPS. La marge de la détection reste celle de toujours, le garde fait le
reste, et ce que la détection ne peut pas voir :

1. **La marge de la détection reste +30 % de pixels sur tout GPU, puces intégrées comprises**
   (`AUTO_TUNE.integratedMarginPixels` = 1,3, le rendu d'origine gardé avec +15 % ; `AUTO_TUNE_VERSION`
   reste 1 : la détection ne change pas, aucun joueur « Auto » n'est mesuré à nouveau — les champs du garde
   sont facultatifs dans l'enregistrement). Règle du propriétaire : pas de baisse de l'image sans nécessité
   absolue ; et depuis le correctif CSS du HUD, le vrai portable tient 60 FPS **au natif** dans des crash
   tests de 5 min à 8 joueurs sur secteur (0,03-0,05 % d'images en retard). Ce que le menu ne peut pas voir
   — puce chaude, batterie ou plan d'alimentation d'entreprise, partie lourde, HUD (point 3) — est le travail
   du garde (point 2), qui ne baisse l'image que là où il le faut. Variante essayée, gardée en A/B : +50 %
   sur les puces intégrées (une part de l'image n'y suit pas les pixels — sommets des ~190 k triangles de la
   carte, clear, soumission — : +30 % de pixels n'y valent que ≈ +20 % de temps) ; sur le modèle calé sur
   le terrain (`irisXeField` : la règle choisit 90 % du natif, comme le vrai portable), elle choisit **85 %**
   (2040 × 986 à 1920 × 928 CSS, 125 %). **Si le garde descend trop souvent sur le terrain** : essayer
   `?diag=tunemargin50`, puis « Run again ». « Auto » ne dépasse jamais 100 % du natif, sur aucun GPU (le
   haut de l'échelle).
2. **Le garde en partie** (`settings/AutoGuard.ts`, « Auto » seulement) : il regarde les images du **jeu
   au premier plan** (pointeur verrouillé, page visible, partie en cours) et, si 60 FPS ne tiennent plus
   **durablement** — sur les 10 dernières secondes de jeu, des images livrées sous 57 FPS en moyenne (les
   1,5 % les plus lentes écartées : saccades isolées) **et** pendant au moins 7 de ces secondes (une rafale
   n'est pas une machine trop juste) — il descend l'échelle de la détection d'un cran significatif
   (résolution, anticrénelage, taille d'une ombre dynamique ; filtrage et densité de neige, ≈ 1-3 % chacun,
   partent avec lui), **en direct** (aucune compilation, appliqué entre deux images), avec une ligne
   discrète en bas de l'écran : « Graphics lowered to hold 60 FPS (resolution 90% → 85%) ». Le cran est
   ensuite jugé sur les 6 s suivantes : gardé (enregistré comme résultat « Auto » de la carte, résumé de la
   page mis à jour) s'il a aidé, un cran de plus s'il a aidé sans suffire ; s'il n'a rien changé (plafond
   d'images du navigateur — l'économiseur d'énergie de Chrome bloque à 30 —, processeur, processus GPU de
   Chrome), le garde s'arrête pour la session et ce cran n'est **pas** enregistré. Les images que le
   **processeur** a mises en retard (thread principal ≥ 90 % du budget) ne comptent pas : baisser les
   graphismes ne les rendrait pas. Jamais de remontée **au cours d'une session** ; au début d'une session
   suivante, à partir du lendemain, **un** barreau au-dessus est essayé (vers la réponse de la détection,
   jamais au-delà) : gardé après une partie entière (4 min de jeu) sans cran, sinon le garde redescend
   (comme avant, enregistré tel quel) et l'essai suivant attend deux fois plus (20 h, 40 h, 80 h… un mois
   au plus) — les conditions changent entre deux sessions (chargeur branché, pièce plus fraîche, HUD plus
   léger après une mise à jour). Jamais sous le plancher, jamais pour un préréglage choisi. Tous les seuils
   sont dans `AUTO_GUARD`, avec leur raison.
3. **Ce que la détection ne voit pas : le HUD.** Elle mesure au menu (`#hud.menu-active`) ou en pause
   (`body.game-paused`) : le HUD de la partie est caché, sa rastérisation et sa composition (processus GPU de
   Chrome, même puce) n'entrent dans aucune mesure. Mesuré sur le portable (vraie carte) : en partie, au natif,
   45-46 FPS avec l'iframe du HUD visible contre 59,9 FPS sans, pour le même temps WebGL (~12 ms) et le même
   CPU (6-8 ms) — l'animation de repos du Bean Buddy re-rastérisée à chaque image (corrigée côté HUD). Le
   garde voit ces images-là : elles sont en retard sans que le thread principal en soit la cause, il les
   compte ; baisser la 3D libère la puce partagée (sur ce portable : 90 % tenait une partie entière, ≈ 9 images
   en retard en 5 min ; 100 % tombait à 45-48 FPS) — le cran 100 → 90 % est donc gardé, et l'essai d'un
   barreau au-dessus, le lendemain, le rend quand le HUD a été allégé.
4. **Batterie ou secteur** (`settings/Power.ts`). Le propriétaire : ses chutes arrivent **sur batterie**,
   branché c'est stable — mesuré sur son portable, même scène : thread principal ≈ 2,8× plus lent par image
   sur batterie (7 ms contre 2,5 ms), GPU ≈ 20 % plus lent. Un cran pris sur batterie restait enregistré
   jusqu'à l'essai d'une session suivante (20 h et plus) : la session suivante **sur secteur** commençait un
   barreau trop bas pour rien. Le garde lit donc l'API Battery Status (`navigator.getBattery()` : Chrome /
   Edge, pages https ; détectée, **jamais attendue** — « inconnu » tant qu'elle n'a pas répondu, et pour de
   bon sans elle : Firefox, Safari, http, refus, `?diag=nopowerguard` = le comportement d'avant). Chaque cran
   gardé enregistre l'état de l'alimentation quand il a été pris (`guardPower` : `battery` si
   `charging === false`, `mains`, `unknown` ; le dernier = le cran du dessus, celui qu'un essai défait).
   Sur secteur, un cran du dessus pris sur batterie est réessayé **tout de suite** : au début de la session,
   ou quand le chargeur est branché (`chargingchange`) **entre deux parties** — au menu ou à l'écran de fin,
   jamais en pleine partie (branché pendant une partie : à la fin de celle-ci). Mêmes règles : gardé après
   une partie entière à 60 FPS (puis le cran suivant pris sur batterie, au prochain passage par l'écran de
   fin ou le menu), redescendu sinon — **sans attente doublée** ; un cran qui ne tient pas non plus sur
   secteur devient un cran « secteur » (attente normale à partir de là, pas un essai à chaque session). Un
   cran pris sur secteur, ou alimentation inconnue : l'attente normale (20 h, puis doublée après chaque
   essai raté). Un ordinateur fixe répond `charging: true` (pas de batterie) : secteur. Pas d'essai si un
   cran a été jugé inutile pendant la session (la cadence n'y suit pas les graphismes : un essai ne
   pourrait pas être jugé).

Machines simulées (parties de 5 min, combats et chauffe — `scripts/test-graphics-autotune.mts`) : le
portable du travail sur batterie (puce 32 % plus lente après 1-3 min) choisit 90 % au menu ; sans garde
(`?diag=noguard`) il passe **42 %** du temps sous 57 FPS (pire tranche de 5 s à 48 FPS) ; avec le garde,
**deux** crans dans la première partie (90 → 85 % à 2 min 28, 85 → 80 % à 3 min 05), enregistrés : **8 %**
du temps sous 57 FPS, puis **3 %** à la partie suivante (au plancher, puce chaude dès le début ; pire
tranche 56,6 FPS). Sur batterie puis branché (session suivante, 2 h plus tard) : 80 → 85 → 90 %, un
barreau par partie, chacun gardé après une partie entière à 60 FPS — sans attendre le lendemain. Le
portable personnel sur secteur garde 90 % (60 FPS, aucun cran ; l'A/B `tunemargin50` lui aurait coûté un
cran de résolution pour rien : 85 %). Le PC RTX 2080 Super, une machine limitée par le processeur, une
machine à saccades (kills, processus GPU) : aucun cran. Une GTX 1050 qui garde High au menu passe en MSAA 2× dans une partie lourde.
L'économiseur d'énergie (30 FPS) : un cran jugé inutile, non enregistré, garde arrêté. Sur un écran
60 Hz, le garde se déclenche à partir de ≈ 17,6 ms de GPU par image (≈ 55-56 FPS livrés) ; 17,0 ms
(58 FPS) ne coûtent jamais un cran. Le cas du HUD (6 ms de travail GPU par image que la 3D ne réduit pas,
jamais vu au menu) sur une réponse à 100 % : un cran à 13 s de partie (100 → 90 %), gardé ; le lendemain,
HUD allégé, la session suivante essaie 100 % et le garde après une partie entière ; HUD toujours lourd :
l'essai redescend à 90 % après ~13 s de jeu, et le suivant attend 40 h.

## La fin de partie (écran de fin) (18ᵉ passe)

Mesuré sur le portable (Iris Xe, Chrome Windows / ANGLE D3D11, 1920 × 1080, production, FFA solo à 8,
Yard et Givre ; horodatage des rAF + requêtes de chronométrage GPU) : **une image de 133 à 166 ms** du
thread principal là où le chrono tombe à 0:00, puis **52-54 FPS** sur l'écran de fin (43 à 63 images de
plus de 25 ms par 10 s), alors que le WebGL du jeu n'y coûte que 2-7 ms de CPU et 7-10 ms de GPU. En
partie, la même machine tient 60 FPS : la fin de partie était devenue le pire moment d'un match.

**Ce qui coûtait.** L'écran de fin (`src/endscreen`, piloté par `match/MatchEndController.ts`) faisait
tout pour la première fois **dans l'image où le match se termine** — banc (SwiftShader, Yard LOW,
8 joueurs, 640 × 360), JS de cette image hors capture : ≈ 280 ms, dont :

| Étape | Banc | |
|---|---|---|
| Contexte WebGL de l'intro 3D (`new WebGLRenderer`) | 59 ms | créé à chaque fin de partie |
| Titre extrudé (VICTOIRE / DÉFAITE, chaque lettre en relief + 3 plaques) | 73 ms | |
| Résultats : style puis mise en page de tout le DOM, **deux fois** (unité `--u` posée après coup) | 78 ms | `focus()` 47, `getBoundingClientRect` 22 |
| Vitre brisée et fissures (tableaux JS qui grandissent, clés de chaînes) | 10 ms | |
| Feuille de style (restyle de toute la page) et deux polices chargées à ce moment | — | le texte remis en page à leur arrivée |
| Copie entière de l'instantané (`getImageData`, 8 Mo à 1080p) pour en tester 64 pixels | 1 ms au banc | ~10 ms à 1080p |
| Contexte audio de l'écran de fin, ouvert à chaque fin de partie (jamais refermé) | 2-80 ms | |

Puis l'image suivante : **9 programmes GPU compilés** au premier rendu de l'intro (166 ms de JS au banc ;
sous D3D11, 10 à 300 ms par programme quand le cache de Chrome est froid), et **2 à 3 autres en pleine
intro** (les lettres, les anneaux du slam : invisibles au départ). Et à chaque image de l'écran de fin :
le monde gelé **redessiné en entier** sous l'instantané opaque qui le cache (73 draws au banc, 7-10 ms de
GPU sur le portable) et composé, et deux quads plein écran de l'intro (le fond une fois le titre en
place, les lignes de vitesse hors du slam) dessinés à opacité 0, avec MSAA. Au rejouer, tout
recommençait : nouveau contexte WebGL, 12 compilations, nouveau contexte audio.

**Ce qui a été fait** — même image (preuves plus bas), un interrupteur `?diag=` par changement (production
comprise), `?diag=oldendscreen` = l'ancienne fin de partie entière (`match/EndScreenPerf.ts`) :

| Changement | Pour l'enlever |
|---|---|
| **Préchauffage.** Feuille de style, polices, contexte audio (dès que la page a eu un geste, au plus tard au clic sur JOUER), contexte WebGL de l'intro et ses programmes (envoyés au processus GPU par `renderer.compile`, liés en parallèle, puis **dessinés une fois avec tous leurs objets visibles**, victoire puis défaite, sur un tampon de 16 × 9), titre extrudé des deux issues : dans les temps morts du menu (`EndScreen.prewarm`), terminé au plus tard au clic sur JOUER et avant une détection automatique (`flushPrewarm`). L'écran de fin prend cette instance (`takeIntro3D` → `adopt` : l'état exact d'une instance neuve, tirages `Math.random()` compris, dans le même ordre) et la rend au suivant (`releaseIntro3D`) : rejouer ne recrée rien. Programmes épinglés, un matériau de chaque sorte gardé (sans lui, three.js renumérote les shaders de la vitre et recompile 3 programmes à chaque écran de fin — règle 56), géométrie des lettres partagée. | `noendwarm` |
| **Monde couvert.** L'instantané est lu par bandes (~128 k pixels par image, dès la 2ᵉ image de l'intro) ; s'il est opaque partout (three.js crée tous ses contextes avec un canal alpha : le jeu ne peut pas le promettre), le monde gelé n'est plus dessiné (`Game.setWorldCovered` ; le canvas garde sa dernière image) ; découvert avant le fondu de sortie. Les mises à jour du décor continuent. | `noendcover` |
| **Draws vides.** L'intro ne dessine plus ce qui ne peut changer aucun pixel (`Intro3D._render`) : fond à opacité 0 (tout l'écran de fin une fois le titre en place), lignes de vitesse à 0 (sauf ~0,5 s autour du slam), flash d'impact éteint, pools de particules sans point visible, confettis sans pièce vivante, ombre du titre avant son arrivée, fissures pas encore poussées ou fondues — chacun mélange un alpha 0, ajoute 0 ou fait `discard`, aucun n'écrit la profondeur. | `noendskip` |
| **Instantané.** Les 64 pixels testés sont lus un par un au lieu de toute l'image ; vitre et fissures construites directement dans des tableaux typés, arêtes repérées par des clés numériques (`buildGlassFast`, `buildCracksFast`) : la même géométrie au bit près (`scripts/test-endscreen-glass.mts`), 3× moins de CPU. | `noendsnap` |
| **Mise en page.** L'unité des résultats (`--u`) et leur mode de mise en page posés avant d'insérer le contenu (`UI.build`) : un seul style + une seule mise en page du DOM des résultats (règle 55). | `noendlayout` |

**Banc, avant → après** (SwiftShader, Yard LOW victoire, 8 joueurs, 640 × 360 ; la capture de l'image —
une lecture GPU → CPU de 1,7 à 2,8 s sous SwiftShader, quelques ms sur une vraie carte — est hors
comparaison) :

| Mesure | Avant | Après | `?diag=oldendscreen` (même build) |
|---|---|---|---|
| JS de l'image de fin, hors capture | ≈ 280 ms | **≈ 105 ms** (≈ 195 ms si le contexte audio n'a pas pu être préparé : page sans geste) | ≈ 310 ms |
| Contextes WebGL / audio créés à la fin du match | 1 / 1 | **0 / 0** | 1 / 1 |
| Programmes compilés : 1ʳᵉ fin de match / pendant l'intro / 2ᵉ fin (rejouer) | 9 / 2-3 / 12 | **0 / 0 / 0** | 9 / 2-3 / 11 |
| Image suivante (1ᵉʳ rendu de l'intro), JS | 166 ms | 17-40 ms | 105 ms |
| Écran de fin : draws du monde par image | 73 | **0** | 73 |
| Écran de fin : draws de l'intro par image | 47 | 43 (42 une fois le titre en place) | 47 |
| Écran de fin : JS des rAF par image | 12,2 ms | 3,8-4,2 ms | 7,1 ms |
| Givre LOW défaite : draws du monde par image / contextes et programmes à la fin | — | 0 / 0 et 0 | 34 / 1 et 12 |
| Intro seule, rendu synchronisé (480 × 270, après le dock) | 56 / 47 ms (victoire / défaite) | 52 / 36 ms | — |
| Rejouer : `restartSoloMatch` / plus longue tâche à la fermeture de l'écran de fin | 12 ms / 165 ms (dont `onfinish` 118 ms : intro et contextes détruits) | 13-21 ms / aucune de plus de 50 ms | 20 ms / — |

**Preuves (même image)** — pixel pour pixel, RGBA, seuil 0 :
- intro 3D, ancien code (fe377c8) contre nouveau, horloge fixe, mêmes tirages, à 22 instants de 0 à 7 s,
  victoire et défaite, mouvement normal et réduit : chemins froid, instance préchauffée, draws vides
  sautés, et les deux ensemble — **0 pixel différent partout** (les tirages `Math.random()` des UUID de
  three.js sont séparés de ceux de l'intro : un objet réutilisé au lieu d'être recréé ne doit pas décaler
  la vitre) ; 0 programme compilé pendant l'intro avec l'instance préchauffée ;
- instantané : ancien contre nouveau, 5 rapports de taille jeu / écran (copie 1:1 et redimensionnée) :
  0 pixel différent, et le même rendu de l'intro avec chacun en texture ; la lecture par bandes donne
  le même verdict que le compte complet ;
- page composée (écran de fin + jeu derrière), ancien build contre nouveau, 8 états (départ, fissures,
  éclatement, titre, dock, résultats, votes, fin du vote) : Yard LOW victoire et Givre LOW défaite
  **identiques** ; Givre HIGH victoire : identique aux 4 premiers états, et aux résultats / votes / fin
  du vote dans une série (1 pixel d'1 niveau sur 255). Dans d'autres séries, une ligne du classement et
  la pastille du score sortent décalées d'1 px — **y compris avec le monde redessiné comme avant**
  (`?diag=noendcover`) : effet de la composition du banc (cette ligne vient d'être animée), pas d'un
  changement ; et après le redémarrage du banc, la vue du dock saisit le compteur du score à un autre
  instant (194 au lieu de 288) avec ou sans le changement (horloge réelle des animations WAAPI contre
  l'horloge fixe du banc).

**Ce qui reste, et les compromis possibles** (non faits) :
- **La capture elle-même** : `Game.captureFrame` redessine le monde gelé puis le copie ; l'écran de fin
  le recopie dans un canvas 2D lu par le CPU : le thread principal attend que le GPU ait fini cette
  image, plus le transfert (≈ 8 Mo, plafonné à 2048 px de large). Une copie restée sur le GPU (canvas 2D
  accéléré) supprimerait l'attente, mais son rééchantillonnage (rendu à moins de 100 %) n'est pas celui
  du CPU : pas prouvable identique ici (pas de GPU) — à essayer sur le portable.
- **Le DOM des résultats** reste construit, stylé et mis en page dans l'image de fin (une fois au lieu
  de deux) : 20-50 ms au banc. Il n'apparaît qu'à 2,05 s (victoire) / 3,25 s (défaite) ; le construire
  plus tard le déplacerait en pleine cinématique.
- **Le flou de la vignette** (`backdrop-filter: blur(3px)` plein écran quand les résultats sont là),
  recalculé à chaque image où l'intro bouge au-dessus : l'enlever change l'image.
- **L'intro 3D à la densité de l'écran avec MSAA** (×1,25 sur le portable : 2400 × 1160, 4 échantillons)
  pendant tout l'écran de fin (le titre ondule, les confettis tombent) : densité 1 ou sans MSAA =
  −36 % / −75 % de fragments, mais des bords différents.

**À mesurer sur le portable** (production, un déploiement, A/B par `?diag=`) : l'image où le chrono
tombe à 0:00 (`[hitch]` en console, ou les intervalles entre rAF) — avant 133-166 ms ; les FPS des 10 s
d'écran de fin — avant 52-54 ; puis `?diag=oldendscreen` (l'ancien chemin) et chaque interrupteur seul ;
rejouer sur la même carte (aucune compilation, aucun contexte créé ; la relance doit arriver ≈ 2,65 s après
la fin du vote, comme avant — au banc, SwiftShader prend du retard sur les images de l'intro seule et la
relance arrive à 5,5 s au lieu de 3,0 s) ; un clic sur JOUER dans la première seconde du menu (le reste
du préchauffage passe au clic, comme les BVH de tir).

## Vérifier sur une machine

HUD de debug (déjà présent) : lignes `World: N draws` et `CPU`. La page **SETTINGS** a sa propre carte de
mesure en direct (FPS délivrés, image médiane et 5 % les plus lentes, processeur) : changer une option et
voir l'effet tout de suite. Repères sur Givre
en HIGH : ~37‑55 draws sans bot, ~100‑130 avec 8 bots en vue (contre ~230‑260 et
~520‑650 avant) ; en LOW ~36 sans bot, ~85‑95 avec 8 bots. Si la ligne `CPU` reste
proche du temps de frame, la machine est limitée CPU ; si elle est très en dessous,
c'est le GPU (ou le processus GPU du navigateur).

- `[BOOT]` (console F12, à chaque chargement, production comprise) :
  `[BOOT] menu en 4.1 s — page 0.30 · physique 0.10 · carte 0.60 · …`, le temps que
  l'écran de chargement a attendu chaque étape, dans l'ordre où elles finissent (les
  téléchargements tournent derrière les étapes suivantes) : `page` = HTML + script du jeu,
  `physique` = Rapier, `carte` / `effets carte` / `jeu` = construction de la scène, `armes` =
  GLB des armes, `préparation` = objets du warm-up, `compilation` = fin de la compilation des
  shaders par le navigateur, `HUD` = warm-up du HUD (pendant la compilation quand le navigateur
  compile en parallèle, après sinon), `rendu` = rendus de warm-up, `menu` = jusqu'au menu
  affiché. Aussi dans DevTools > Performance (piste « Timings », `boot:…`). Un chargement
  long dont l'essentiel tombe sur `compilation` / `rendu` = cache de shaders de Chrome froid
  (première fois après une mise à jour de Chrome ou du pilote, ou d'un shader du jeu) : les
  chargements suivants doivent être nettement plus courts.
- `?diag=…` (n'importe quel build, plusieurs séparés par des virgules ; ligne `Diag:` du
  panneau) : des expériences « et si » pour situer le temps d'une image. `noflush` = l'ancienne
  soumission du travail GPU (11ᵉ passe) ; `scale50` = la 3D à 50 % de sa résolution (FPS presque
  doublés = l'image est limitée par les pixels) ; `cpu5` = 5 ms de CPU en plus par image (FPS
  inchangés = CPU et GPU travaillent en parallèle) ; `nopost` = Givre dessiné directement dans
  le canvas, sans cible HDR ni passe de sortie ; `empty` = plus aucun rendu 3D (ce qui reste =
  le coût propre de la page). Jamais pour jouer. Bascules d'optimisations (lues au chargement ;
  `?diag=<nom>` active, `?diag=no<nom>` désactive) : `prepass` = pré-passe de profondeur de la
  carte de Givre (14ᵉ passe ; `prepass,prepassall` = avec tous ses triangles, pas seulement les
  grands : le coût des sommets d'une pré-passe complète) — la console (F12) dit alors
  `[GPU] pré-passe de profondeur active : image identique…` (vérifiée au chargement sur ce GPU)
  ou `DÉSACTIVÉE : N pixels…`, et `?gpu=draws` montre son coût GPU (« pré-passe ») à côté de
  « carte » ; `percomponent` = faces simples par composante connexe (une expérience : change
  quelques pixels).
- **Préréglage Auto** (`?diag=` aussi) : `noguard` = pas de garde en partie (« Auto » garde la
  réponse de la détection quelle que soit la cadence du match : l'ancien comportement) ;
  `nopowerguard` = le garde sans la batterie (l'API Battery Status jamais lue : chaque cran attend le
  délai normal avant d'être réessayé, même un cran pris sur batterie une fois branché) ;
  `tunemarginNN` = la détection mesure chaque barreau avec NN % de pixels en plus, sur tout GPU
  (par défaut 30 partout ; `tunemargin50` = la variante +50 % des puces intégrées, **l'A/B à essayer
  si le garde descend trop souvent sur le terrain** ; `tunemargin0` = aucune marge : une réponse trop
  lourde pour les combats, exprès, pour voir le garde la corriger). Seule la détection suivante
  (« Run again ») l'utilise. Quand le garde baisse l'image,
  une ligne s'affiche en bas de l'écran (« Graphics lowered to hold 60 FPS (resolution 90% → 85%) »),
  le résumé « Auto-detect » de la page SETTINGS le dit (« In a match this PC fell to about 53 FPS… »),
  et un pas jugé inutile (la cadence ne suit pas les graphismes : plafond du navigateur, processeur)
  laisse une ligne `[graphics] Auto guard: …` dans la console. Le garde en cours se lit aussi dans la
  console en DEV : `__settings.controller.guardPhase` (`watch`, `verify`… ; `null` = il ne tourne pas).
  Batterie : un essai d'un barreau au-dessus laisse `[graphics] Auto guard: plugged in — trying one step
  higher again (a step taken on battery): …` (ou `… this session: …` pour l'essai normal) ; en DEV,
  `__settings.controller.guardTrying` et, dans l'enregistrement, `guardPower` (l'alimentation de chaque
  cran). À vérifier sur le portable : une partie sur batterie qui fait descendre l'image, puis le chargeur
  branché au menu → la ligne de console, l'image d'un barreau au-dessus, gardée après une partie entière.
- **Chaîne de post-traitement de Givre** (13ᵉ passe, mesures dans « La chaîne de post-traitement
  de Givre ») : `out8` = image intermédiaire RGBA8 ; `fused` / `fused8` = sortie sRGB faite par le
  FXAA lui-même, sans image intermédiaire (poids bilinéaires exacts / à 1/256) ; `worldsrgb` /
  `world11` = cible du monde en SRGB8_ALPHA8 / R11F_G11F_B10F (avec `out8`, ou `fused`) ; `direct` =
  Givre dessiné comme Jungle / Yard (compromis visuel : les effets transparents se mélangent en
  sRGB) ; `postref` = la chaîne de référence quel que soit le défaut. À comparer avec `?gpu` (ligne
  `GPU:`, termes `sortie` + `FXAA`, et le total). `postab` : dans la console, `givrePost.ab()`
  dessine la vue courante avec chaque chaîne et la compare pixel par pixel à la référence **sur
  cette carte** (`console.table` : pixels différents, %, écart max) ; `givrePost.ab(true)` ajoute
  `direct` (compile une fois la variante sRGB de chaque programme : un long gel).
- **Économies CPU** (15ᵉ passe ; actives par défaut, résultat identique au bit près), à couper pour
  comparer : `nohudskip` = le HUD reçoit de nouveau à chaque frame les commandes d'état répétées ;
  `nouniformcache` = les caches et setters d'uniforms de three.js tels quels (tableaux d'uniforms
  renvoyés à chaque fois) ; `nofreshskip` = la carte et les bras FP recalculés par la passe du
  rendu, les bots morts par celle de la frame. La ligne `CPU` doit monter un peu avec chacun.
  Image du kill (17ᵉ passe) : `nokillprep` = textures d'os et clones de fondu d'un cadavre créés de
  nouveau dans l'image du kill (actif par défaut, même image) ; `programsort` = l'expérience du tri des
  opaques par programme (pas la même image au bit près, voir la règle 50).
- **HUD** (16ᵉ passe ; le paramètre est transmis à son iframe, et marche
  aussi avec `?hud=inline`) : `hudanim` = l'ancien CSS des animations du HUD, l'ancien
  portrait du Bean Buddy (un seul SVG) et l'ombre filtrée des pans du ruban de la médaille — ses
  animations au repos repeignaient et re-rastérisaient à chaque image, la médaille à chaque
  image de son entrée ; `nohudidle` = l'ancienne boucle d'images permanente du
  document du HUD (`HUD: … images/s` revient à la fréquence de l'écran). Comparer les FPS
  avec et sans, au repos (`?diag=hudanim,nohudidle` = tout l'ancien HUD). La peinture 3D de la
  plaque (Paintball, Popcorn, Poison ; son temps GPU = `+ peinture HUD` avec `?gpu`) :
  `paintss100` = rendue à 100 % de la densité de pixels de l'écran au lieu de 200 % (≈ 3 fois
  moins de pixels en 1080p : 396 × 221 au lieu de 678 × 378 ; `paintss150` : 565 × 315, entre
  les deux), `paintfps30` = redessinée au plus
  30 fois par seconde quand elle bouge (au lieu de chaque image) — des expériences, pas les
  mêmes pixels (moins de suréchantillonnage / gelée moins fluide) : à juger à l'œil avec le gain
  mesuré. Jamais pour jouer.
- **Fin de partie** (18ᵉ passe, voir « La fin de partie ») : `oldendscreen` = l'ancienne fin de partie
  entière ; un seul changement à la fois : `noendwarm` (écran de fin construit à la fin du
  match : contexte WebGL, programmes, titre, polices, feuille de style, contexte audio), `noendcover` (le monde
  gelé redessiné derrière l'instantané opaque), `noendskip` (l'intro 3D dessine aussi ses quads
  à opacité 0), `noendsnap` (instantané copié en entier pour tester 64 pixels), `noendlayout`
  (les résultats stylés et mis en page deux fois, à l'unité par défaut puis à la vraie). À mesurer : la
  frame où le chrono tombe à 0:00 (console `[hitch]`, ou les intervalles entre rAF) et les FPS
  de l'écran de fin (le panneau de debug y est masqué : intervalles entre rAF, requêtes de
  chronométrage GPU — le jeu n'y dessine plus rien tant que l'écran de fin le recouvre).
- **Shader de la carte** (19ᵉ passe) : `nomapshader` = la carte Givre dessinée avec le shader
  d'origine de three au lieu du shader spécialisé (`world/GivreMapMaterial.ts`, même image) :
  la différence de la ligne `GPU` (`monde`) = ce que la spécialisation fait gagner sur cette
  machine ; `mapshaderao` = le shader spécialisé avec l'AO rangée dans l'alpha de la lightmap
  émissive (une lecture de texture de moins par pixel, même image au banc ; empaquetée au
  chargement, la ligne `[CARTE]` de la console en donne le temps) : à comparer au défaut avant
  d'en faire le défaut ; `mapshaderfast` = `mapshaderao` **plus** la partie quasi exacte (au plus
  1 niveau sur 255, sur quelques pixels : un compromis visuel à décider, coupé par défaut).
  Protocole : même pose, une fois dans une salle (le spawn) et une fois dehors (la cour
  centrale), ligne `GPU` `monde` avec le défaut, `nomapshader`, `mapshaderao` et
  `mapshaderfast`. Jamais pour jouer.
- `Device:` : le GPU réellement utilisé par le navigateur. « SwiftShader »,
  « Basic Render Driver » ou « llvmpipe » = rendu logiciel (accélération matérielle
  désactivée) : aucune optimisation du jeu n'y changera rien.
- `GPU:` (en `npm run dev`, et **sur n'importe quel build avec `?gpu` dans l'adresse**, par
  exemple `https://slide-io.vercel.app/?gpu` sur une machine sans environnement de dev) :
  temps **d'exécution sur la carte graphique** par frame, détaillé par passe (`monde`,
  `bras`, `sortie`, `FXAA`). `?gpu=draws` — ou `perfDebug.gpu(true)` dans la console en
  dev — détaille par catégorie d'objets (carte, ciel, bots, neige…) ; `perfDebug.gpu(false)`
  revient au détail par passe. `+ peinture HUD` = le temps GPU de la peinture 3D de la
  plaque du Paintball / Poison (son propre contexte WebGL), par frame. C'est la seule ligne
  qui sépare la carte graphique du reste : un `GPU:` proche du temps de frame = la puce est
  pleine (réduire le travail par pixel de la catégorie la plus chère) ; nettement en dessous
  alors que la ligne `Hitch` parle d'« attente GPU » = la frame attend autre chose (le
  processus GPU de Chrome, qui traduit les appels WebGL pour DirectX sur le CPU, ou une
  machine bridée par son mode d'alimentation).
- `Browser:` : le travail du thread principal du navigateur **après** chaque frame du jeu
  (style, mise en page, peinture du HUD, envoi au compositeur, autres tâches), moyenne et
  pire valeur de la demi-seconde. `CPU` + `Browser` proches du temps de frame = le thread
  principal est la limite ; nettement en dessous alors que les FPS baissent = la frame attend
  le **processus GPU de Chrome** (qui exécute les appels WebGL du jeu, la rastérisation et
  la composition du HUD) ou la carte graphique elle-même.
- `Hitch:` s'affiche pendant 6 s après chaque frame d'au moins **trois frames normales**
  (médiane de la demi-seconde précédente), entre 12 et 30 ms : 30 ms à 60 Hz (deux images
  manquées), 12,5 ms à 240 Hz (les « -30 FPS » qu'un seuil fixe de 30 ms ne voyait pas). La
  découpe : `jeu` = le CPU de la frame du jeu — suivi, en `npm run dev` ou avec `?gpu`, de ses
  sections les plus lourdes (`bots IA` = IA et A*, `armes bots` = tirs des bots et leurs kills,
  `physique`, `bots anim`, `bots vue`, `armes`, `effets`, `HUD`, `rendu`…), `navigateur` = le travail du thread
  principal du navigateur **après** la frame du jeu (style / mise en page / peinture /
  envoi au compositeur, ramasse-miettes, autres tâches — mesuré à chaque frame : un
  message posté à la fin de la frame ne passe qu'une fois ce travail terminé ; et,
  pour les frames de 50 ms et plus, par l'API *Long Animation Frames* de Chrome),
  `attente GPU` = le reste du trou : le thread principal ne faisait rien, il attendait
  le processus GPU (compilation de shaders, rastérisation du HUD, présentation). En fin de
  ligne, ce que le jeu venait de faire (`kill`, `kill bot`, `tir`, `dégâts`, `recharge`,
  `soin`, `mort`, `réapparition`) : le déclencheur probable. La console (F12)
  reçoit une ligne `[hitch]` par saccade en `npm run dev` (deux par seconde au plus), à partir
  de 30 ms en production, avec les scripts en cause.
- `HUD:` (10ᵉ passe) : `iframe isolée · 2 images/s · JS 0.1 · rendu 1.2 ms` = le HUD tourne dans son
  propre processus : les images que SON document a dessinées par seconde (il ne dessine que quand
  quelque chose change : ~1 par seconde au repos, le chrono ; ses animations tournent sur le
  compositeur sans image du document ; une plaque à peinture 3D — Paintball, Popcorn, Poison —
  en demande une à chaque rafraîchissement ; une animation CSS que seul le thread principal sait
  jouer, comme celles que `?diag=hudanim` remet, fait dessiner des images que ce compte ne voit
  pas), le temps d'application des commandes par frame du jeu et le rendu du navigateur par image
  dessinée, dans SON processus ; `dans la page (raison)` = repli sur l'ancien chemin, avec la raison
  (iframe sans réponse, non isolée, viewport différent… ; « l'iframe ne répond plus » si son
  processus a planté en pleine partie). `?hud=inline` dans l'adresse force
  l'ancien chemin pour comparer. Avec l'iframe, `Browser:` ne compte plus que la page du jeu.
- `FPS: 203 / 240 Hz` : FPS de la demi-seconde / fréquence à laquelle le navigateur cadence
  réellement l'affichage (mesurée sur les rAF : un écran réglé à 240 Hz que Chrome cadence à
  60 affiche « 60 Hz »).
- `FPS` est compté sur des fenêtres d'une demi-seconde : une seule frame de 33 ms
  affiche ~58, deux ou trois ~55. Des creux brefs à 55 sont donc des **saccades**
  (frames isolées trop longues : compilation de shader, ramasse-miettes, pic d'IA),
  pas un manque de puissance général — `CPU … max` et `Frame … max` les montrent.
- Limité par la **carte graphique** elle-même ? L'overlay NVIDIA (Alt+R) affiche l'utilisation
  du GPU : proche de 100 % pendant les creux = limite GPU (pixels : MSAA 4×, résolution) ;
  nettement en dessous = limite CPU / processus GPU de Chrome (lignes `CPU` et `Browser`).
