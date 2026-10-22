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
| HUD au repos, aux tirs et au kill (12ᵉ passe : l'animation du Bean Buddy coûtait 15 FPS au portable) | **Plus aucune peinture ni rastérisation par image dans le HUD au repos ; aux événements, ce qui change seulement.** Mesuré par le chef sur l'Iris Xe (build de production, 1080p) : l'attente du Bean Buddy seule faisait tomber le jeu de 60 à 45-46 FPS (corrigé en production par `will-change: transform` sur le portrait). Au banc image par image (`tools/perf/hud-frame-bench.mjs`, le vrai document du HUD dans son iframe), avant : une image principale, ~6,4 tuiles rastérisées et 2 passes hors écran **à chaque image**, sans que rien ne bouge ; après : 0,02 image principale et 0,02 tuile (le chrono, une fois par seconde), aucune passe hors écran, dans chaque état durable (humeurs, dash, K.O., plaques au repos / basses / en recharge, combo, fin de partie). (1) Le portrait du Bean Buddy en **calques SVG empilés** : ses animations (feuilles, yeux, goutte : des enfants SVG ; respiration : la racine `<svg>`) tournaient sur le thread principal — chaque partie animée a maintenant son propre `<svg>`, dans une `<div>` que le compositeur anime seul ; `will-change: transform` sur `.buddy-art`. (2) `clip-path` / `mask` sortis des éléments animés (chevrons du dash : 2 passes hors écran par image ; étincelles du soin, anneau de recharge) : sur un enfant immobile. (3) La vague du réservoir du FAMAS glisse par `transform` au lieu d'un `background-position` repeint. (4) Bannière K.O. centrée par `translate` (un `translateX(-50%)` dans ses images clés la gardait sur le thread principal). (5) Médaille : l'ombre des pans du ruban sans `filter` (tout le ruban était repeint et re-rastérisé à chaque image de son entrée, ~30 fois par kill). (6) Le document du HUD ne demande plus d'image quand rien ne change (boucle `requestAnimationFrame` permanente → à la demande). Contre le build de production : en tirant, 3,3 → 1,3 passes par image et « rendu » du HUD 2,9 → 2,5 ms par image ; plus de mise en page par image. Contre l'ancien code : tirs 7,0 → 0,5 tuile par image, kill 6,1 → 1,2, dégâts 4,9 → 0,7, recharge 6,5 → 0,2. La peinture 3D des plaques (~3 ms de GPU par image en tirant sur l'Iris Xe) est inchangée par défaut : `?diag=paintss150` / `paintss100` / `paintfps30` pour la juger sur le vrai GPU. Même rendu à l'anticrénelage près (contour du portrait, bout de la vague du FAMAS, ruban de la médaille pendant qu'elle s'affiche : détails plus bas). `?diag=hudanim` remet l'ancien CSS, l'ancien portrait et l'ombre filtrée, `?diag=nohudidle` l'ancienne boucle. | `hud.css`, `hudWeapons.css`, `ui/hudIcons.ts`, `ui/CombatHUD.ts`, `hud/runtime/frameClock.ts`, `hud/runtime/frameEntry.ts`, `hud/runtime/HudRuntime.ts`, `hud/host/HudHost.ts`, `ui/framePulse.ts`, `ui/perfDiag.ts`, `ui/paint/*`, `tools/perf/hud-frame-bench.mjs` |
| Qualité HIGH | Filtrage anisotrope ×8 sur les lightmaps (sols et murs nets en incidence rasante). | `game/GraphicsQuality.ts`, `world/GivreMap.ts` |

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
36. **Détection automatique** : elle juge sur les **intervalles entre images** sous charge (+30 % de pixels), jamais sur des requêtes de chronométrage GPU (elles comptent les temps morts du GPU et font flusher Chrome : elles changent ce qu'elles mesurent). Une option ne rejoint l'échelle (`settings/AutoTune.ts`) que si elle s'applique en direct, à sa place dans l'ordre « le moins visible d'abord », et jamais sous le plancher (l'ancien LOW). Changer la logique de la détection = incrémenter `AUTO_TUNE_VERSION` (chaque joueur « Auto » est mesuré à nouveau, une fois).
37. **Anciennes clés** `beanzo.graphicsQuality` / `beanzo.fpsCap` : toujours lues et écrites (pont avec un build plus ancien et avec les scripts de banc) — une valeur écrite par quelqu'un d'autre depuis le dernier passage du jeu est reprise au chargement suivant (`adoptLegacyChanges`). Les réglages du joueur vivent dans **un** enregistrement, `slideio.settings`.
38. **Animation CSS du HUD = compositeur seulement** : `transform` / `opacity` d'un élément qui a une boîte CSS et dans lequel rien ne se repeint. Jamais d'animation CSS sur un **enfant SVG** (`<path>`, `<g>`) — Chrome ne la compose pas et refait le style et la mise en page du SVG à chaque image — : lui donner son propre `<svg>` dans une `<div>` animée (le portrait du Bean Buddy, `hudIcons.BEAN_BUDDY_LAYERS` ; une racine `<svg>` animée peut rester, elle aussi, sur le thread principal). **Pas de pourcentage dans les images clés d'un `transform`** (`translateX(-50%)` dépend de la taille de la boîte : thread principal, « TransformDependsOnBoxSize ») : le centrage dans la propriété `translate`, que l'animation ne touche pas (la bannière K.O.). `visibility` dans des images clés garde toute l'animation sur le thread principal (« UnsupportedCSSProperty ») : seulement pour une sortie courte (la chute de l'étiquette du combo, 0,45 s — sa `visibility: hidden` finale fait aussi ignorer à Chrome le clignotement de la corde qu'elle cache, « NoVisibleChange »). Jamais de `clip-path` / `mask` sur l'élément animé (un calque de masque et une passe hors écran à chaque image) : sur un enfant immobile. Jamais de `background-position` animé (une peinture par image) : un enfant qui glisse. Un élément mis à l'échelle en continu et qui garde sa couche : `will-change: transform`. Chaque exception garde l'ancien CSS sous `?diag=hudanim` (`hud.css` « PERF — animations »).
39. **Le document du HUD ne demande une image que s'il en a besoin** (`hud/runtime/frameClock.ts`) : un `requestAnimationFrame` qui se relance sans fin y coûte une image complète (rAF, style, mise en page, commit) à chaque rafraîchissement de l'écran, même quand rien ne bouge. Une boucle rAF dans un widget s'arrête quand il n'a plus rien à animer.
40. **Mesurer le HUD image par image** : `node tools/perf/hud-frame-bench.mjs --base <rev> --set states` (états durables : humeurs, mort, dash, plaques au repos / basses / en recharge…) ou `--set events` (tirs, kill, dégâts, recharge) : par image du scénario, dans le processus du HUD, images principales, styles, mises en page, peintures, tuiles rastérisées (et par calque), passes du compositeur d'affichage. Au repos, la cible est **0 peinture et 0 tuile par image** ; un effet ponctuel ne rastérise qu'à son début. `--layers` : les couches repeintes / rastérisées une à une (qui repeint quoi) ; `--css "<règles>"` : un « et si » (cacher une partie du HUD, retirer un filtre) ; `--restart <sélecteur>` : les animations que Chrome laisse au thread principal, et pourquoi (« NOT composited »). Les pixels : `tools/hud-preview/runtime-harness.mjs --rest` (chaque point de contrôle aussi au repos : animations sans fin à leur début).

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

## Le HUD au repos, aux tirs et au kill (12ᵉ passe)

Mesuré par le chef sur le portable de travail (Intel Iris Xe, build de production, HUD dans son
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
l'étiquette du combo (0,45 s, `visibility` dans ses images clés, voulu : règle 38) et la sortie de
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
affiché dit la marge réellement mesurée et quand le rendu d'origine a dû baisser.

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
  le coût propre de la page). Pour le HUD (le paramètre est transmis à son iframe, et marche
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
