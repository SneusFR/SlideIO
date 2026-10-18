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
| Qualité HIGH | Filtrage anisotrope ×8 sur les lightmaps (sols et murs nets en incidence rasante). | `game/GraphicsQuality.ts`, `world/GivreMap.ts` |

### Bugs corrigés au passage

- **Goofy Basket invisible** sur un bot (ou un joueur distant) dont c'était la *première* arme : le contrôleur démarrait « équipé Goofy Basket » sans rien afficher, et le premier `setWeapon` identique était ignoré (bras en position de tenir le ballon, mains vides). `network/remote/RemoteWeaponController.ts`
- **Preset LOW** : les armes tenues par les bots projetaient leur silhouette dans l'ombre cuite au chargement (ombre d'arme figée au point d'apparition) — les personnages, eux, ne projetaient déjà rien. `network/remote/RemoteWeaponController.ts`

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

## Vérifier sur une machine

HUD de debug (déjà présent) : lignes `World: N draws` et `CPU`. Repères sur Givre
en HIGH : ~37‑55 draws sans bot, ~100‑130 avec 8 bots en vue (contre ~230‑260 et
~520‑650 avant). Si la ligne `CPU` reste proche du temps de frame, la machine est
limitée CPU ; si elle est très en dessous, c'est le GPU (ou le processus GPU du
navigateur).
