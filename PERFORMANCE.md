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
| Saccades (5ᵉ passe : premier kill du joueur) | **Warm-up du HUD tenu jusqu'au vrai dessin.** Mesuré cette fois avec la rastérisation GPU allumée sur le banc (Skia sur ANGLE / SwiftShader : chaque shader de rastérisation compilé par le navigateur apparaît dans la trace) : malgré le warm-up de la 3ᵉ passe, le premier kill compilait encore **19 shaders** du navigateur (0 au 2ᵉ kill) — vraisemblablement les 4-5 frames de 40-50 ms vues sur le portable dans les secondes qui suivent. Cause : chaque état du warm-up ne restait affiché qu'une ou deux frames ; or le travail GPU d'un état (rastérisation, compilation de ses shaders) passe *après* la frame qui l'affiche, et le navigateur l'abandonne si l'état a déjà disparu. Chaque état est maintenant tenu jusqu'à ce que deux frames de suite arrivent à l'heure (le processus GPU a fini ; 3 frames au moins, 0,6 s au plus, 5 s pour tout le warm-up) : **5 shaders** au premier kill. Le warm-up rejoue aussi des situations réelles l'une après l'autre — le premier kill tel quel (médaille KILL simple, sticker, combo x1, saut du Bean Buddy, classement), un combat (dégâts, tube de PV à moitié vide, dash), les états rares, la mort — avec les classes et les jauges exactes du jeu, chaque animation dessinée en cours, figée, au repos puis en sortie (l'étiquette de combo qui « tombe » était masquée par une règle plus spécifique). Le HUD est dessiné **sous** l'écran de chargement, à pleine opacité (l'écran en laisse passer 0,4 %) au lieu de par-dessus à 0,4 % d'opacité. ~2 s de plus sur l'écran de chargement à 60 Hz (0,5 s à 240 Hz ; un peu plus au tout premier lancement, quand les shaders compilent vraiment). **Ligne `Hitch`** : le travail du navigateur après chaque frame est mesuré à chaque frame (l'API Long Animation Frames ne voit que les frames de 50 ms et plus : sur une saccade de 30 à 50 ms, il était compté en « attente GPU »). | `ui/HudWarmup.ts`, `style.css`, `ui/DebugHUD.ts`, `game/Game.ts` |
| Qualité HIGH | Filtrage anisotrope ×8 sur les lightmaps (sols et murs nets en incidence rasante). | `game/GraphicsQuality.ts`, `world/GivreMap.ts` |

### Bugs corrigés au passage

- **Goofy Basket invisible** sur un bot (ou un joueur distant) dont c'était la *première* arme : le contrôleur démarrait « équipé Goofy Basket » sans rien afficher, et le premier `setWeapon` identique était ignoré (bras en position de tenir le ballon, mains vides). `network/remote/RemoteWeaponController.ts`
- **Preset LOW** : les armes tenues par les bots projetaient leur silhouette dans l'ombre cuite au chargement (ombre d'arme figée au point d'apparition) — les personnages, eux, ne projetaient déjà rien. `network/remote/RemoteWeaponController.ts`
- **Preset LOW, warm-up** : l'ombre était cuite *après* les rendus de warm-up. Avant sa première cuisson, three r185 lie une texture d'ombre factice sans mode de comparaison au `sampler2DShadow` → `GL_INVALID_OPERATION: Mismatch between texture format and sampler type` : WebGL rejetait **tous** les draws éclairés du warm-up (~2 300 erreurs au chargement, les 256 premières dans la console). Les shaders étaient liés mais jamais exécutés, et ANGLE / D3D11 finit certains shaders au premier vrai draw : ce travail tombait en pleine partie. L'ombre est maintenant cuite avant le warm-up. `game/Game.ts`

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
12. **Nouveau matériau ou variante** (patch `onBeforeCompile`, clé de cache, transparence, cible de rendu) : l'ajouter au warm-up (`Game.warmUpRendering`), dans l'état exact où il sera dessiné en jeu — sinon sa compilation tombe au premier usage, en plein combat. Vérification : `perfDebug.programs()` avant / après une partie (DEV) ne doit pas bouger.
13. **Jamais de « reflow » pour relancer une animation CSS** (`classList.remove` → lecture de `offsetWidth` → `classList.add`) dans le code de jeu : chaque lecture force le style et la mise en page de toute la page, au milieu de la frame. Deux keyframes identiques sous deux noms, alternées par une classe : `replayAnim` (`ui/hudKit.ts`) pour un événement ponctuel, `FramePulse` (`ui/framePulse.ts`) pour ce qui peut tomber plusieurs fois par frame (tirs, impacts, messages réseau).
14. **Un élément du HUD dont le JS réécrit l'opacité ou la transformation à chaque frame** doit avoir sa propre couche (`will-change: opacity` / `transform`) — sinon chaque changement re-rastérise toute la couche du HUD (plein écran pour une vignette).
15. **Nouvel état rare du HUD** (médaille, bannière, écran, effet CSS coûteux : dégradé conique ou masqué, ombre floue, texte détouré, filtre SVG) : l'ajouter à `warmUpHud` (`ui/HudWarmup.ts`) — sinon son premier dessin tombe au premier kill / dégât.
16. **Second contexte WebGL ou canvas animé dans le HUD** (peinture de plaque, mécanisme du Frisbee) : rendre à la densité de pixels réelle à l'écran (taille CSS × zoom du HUD × `devicePixelRatio`), pas à une échelle fixe (rendu sur-échantillonné × 2, mais pas plus). Son temps GPU ne fait pas partie de celui du jeu : le mesurer à part (la peinture des plaques s'affiche en « peinture HUD » sur la ligne `GPU`).
17. **Maillage skinné instancié en cours de partie** (arme, accessoire, cadavre, clone `SkeletonUtils`) : il doit avoir une `boundingSphere` **avant** son premier dessin — sinon three.js la calcule en re-skinnant tous ses sommets sur le CPU, une fois par clone. La poser sur le modèle source (`adoptSkinnedBounds`, `effects/skinnedBounds.ts`) : les clones la copient.
18. **Nouvel état du HUD dans le warm-up** (`ui/HudWarmup.ts`) : l'ajouter à la situation où il apparaît vraiment, avec les classes, textes et jauges (scaleX) exacts du code de jeu — un état dessiné sous une autre combinaison (autre filtre, autre classe gagnante, élément tourné ou à l'échelle) compile d'autres shaders. Ne jamais raccourcir la tenue des états (`holdUntilDrawn`) : un état retiré avant que le GPU l'ait dessiné ne chauffe rien.

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
| Shaders de rastérisation du navigateur compilés au premier kill (30 s qui suivent) | 19 | **5** |
| … au deuxième kill | 0 | 0 |
| Temps de compilation correspondant (SwiftShader, indicatif — D3D11 : dizaines de ms chacun) | 1,1 s | **0,5 s** |

Le banc ne mesure pas le *temps* GPU du portable : la durée réelle de ces compilations
sous D3D11 se lit sur la ligne `Hitch` du HUD (voir ci-dessous).

## Vérifier sur une machine

HUD de debug (déjà présent) : lignes `World: N draws` et `CPU`. Repères sur Givre
en HIGH : ~37‑55 draws sans bot, ~100‑130 avec 8 bots en vue (contre ~230‑260 et
~520‑650 avant) ; en LOW ~36 sans bot, ~85‑95 avec 8 bots. Si la ligne `CPU` reste
proche du temps de frame, la machine est limitée CPU ; si elle est très en dessous,
c'est le GPU (ou le processus GPU du navigateur).

- `Device:` : le GPU réellement utilisé par le navigateur. « SwiftShader »,
  « Basic Render Driver » ou « llvmpipe » = rendu logiciel (accélération matérielle
  désactivée) : aucune optimisation du jeu n'y changera rien.
- `GPU:` (uniquement en `npm run dev`) : temps **d'exécution sur la carte graphique**
  par frame, détaillé par passe (`monde`, `bras`, `sortie`, `FXAA`). Dans la console :
  `perfDebug.gpu(true)` détaille par catégorie d'objets (carte, ciel, bots, neige…),
  `perfDebug.gpu(false)` revient au détail par passe. `+ peinture HUD` = le temps GPU de
  la peinture 3D de la plaque du Paintball / Poison (son propre contexte WebGL), par frame.
- `Hitch:` s'affiche pendant 6 s après chaque frame de plus de 30 ms (deux images manquées à
  60 Hz) et la découpe : `jeu` = le CPU de la frame du jeu — suivi, en `npm run dev`, de ses
  sections les plus lourdes (`bots IA` = IA et A*, `armes bots` = tirs des bots et leurs kills,
  `physique`, `bots anim`, `bots vue`, `armes`, `effets`, `HUD`, `rendu`…), `navigateur` = le travail du thread
  principal du navigateur **après** la frame du jeu (style / mise en page / peinture /
  envoi au compositeur, ramasse-miettes, autres tâches — mesuré à chaque frame : un
  message posté à la fin de la frame ne passe qu'une fois ce travail terminé ; et,
  pour les frames de 50 ms et plus, par l'API *Long Animation Frames* de Chrome),
  `attente GPU` = le reste du trou : le thread principal ne faisait rien, il attendait
  le processus GPU (compilation de shaders, rastérisation du HUD, présentation). La console (F12)
  reçoit une ligne `[hitch]` par frame de plus de 30 ms en `npm run dev` (60 ms en
  production), avec les scripts en cause.
- `FPS` est compté sur des fenêtres d'une demi-seconde : une seule frame de 33 ms
  affiche ~58, deux ou trois ~55. Des creux brefs à 55 sont donc des **saccades**
  (frames isolées trop longues : compilation de shader, ramasse-miettes, pic d'IA),
  pas un manque de puissance général — `CPU … max` et `Frame … max` les montrent.
