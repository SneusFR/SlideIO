# Givre · paquet d'intégration (givre_01)

Map « Givre · Station alpine » pour un FPS rapide à 8 joueurs. Elle a été construite dans Blender 4.3 d'après la minimap concept : plan de 280 × 280 unités, 1 unité = 1 m. Les mesures du personnage et le format d'export (GLB + JSON physique) reprennent ceux de Yard.

## Contenu

```
givre_integration/
├─ CLINE_PROMPT.md              prompt à donner à Cline
├─ README.md                    ce fichier (spécification)
├─ assets/
│  ├─ givre_01.glb              visuel jouable : sol, bâtiments, salles, galerie, couvertures, décor
│  ├─ givre_01_fond.glb         plaine et montagnes hors limites (ni collision, ni ombre)
│  └─ givre_01_colliders.glb    debug : un mesh par collider, extras {collider, role, source}
├─ data/
│  └─ givre_01.physics.json     colliders, playerClips, rampes, spawns, zones, points de vue, éclairage
├─ reference/
│  ├─ givre_minimap.png         minimap générée depuis la géométrie (4 px = 1 m, nord en haut)
│  ├─ givre_style_reference.png captures concept (référence de style, à ajouter)
│  ├─ givrePhysics.types.ts     types TypeScript du JSON
│  ├─ givreMap.reference.ts     code d'exemple three.js + Rapier, à adapter
│  └─ GivreOutlinePass.ts       contour cel-shading en post-processing (normales + profondeur)
└─ source/
   ├─ givre.blend               scène Blender 4.3
   └─ givre_lib.py              générateur Python (aussi intégré au .blend comme texte)
```

## Repère et unités

- Les distances sont en mètres. Le repère est celui de three.js / glTF : Y vers le haut, main droite, nord = −Z, est = +X.
- La zone jouable couvre X ∈ [−140, 140] et Z ∈ [−140, 140]. Le sol est à Y = 0 et la galerie Nord à Y = 6.
- Blender → three.js : (x, y, z) → (x, z, −y). L'export glTF le fait déjà, donc il ne faut ajouter aucune rotation au chargement.
- Minimap concept (u, v de 0 à 280, v vers le sud) → x = u − 140, z = v − 140.
- `givre_minimap.png` : le pixel (px, py) correspond à x = px / 4 − 140, z = py / 4 − 140.

## Mesures de gameplay

| Élément | Valeur |
|---|---|
| Emprise | 280 × 280 m, traversée ≈ 29 s à 9,5 m/s |
| Salles d'angle (Stock, Chaufferie, Atelier, Transit) | intérieur ≈ 64 × 62 m, 8 m sous plafond, 4 piliers de 1,1 m |
| Portes des salles | 12,4 m de large × 5 m de haut en passage libre, cadres orange inclus dans les colliders |
| Traverse couverte | 21,5 m de large, 5,5 m sous plafond, portails de 4,7 m |
| Galerie Nord | plateforme à +6 m, garde-corps à 1,25 m du sol de la galerie |
| Rampes | 3 rampes de 6 m de dénivelé, ≈ 12° : ouest et est sur 27,45 m, sud sur 28,55 m |
| Couvertures basses | caisses de 1,2 à 1,3 m ; muret ouest de la cour centrale de 1,2 m, franchissable au saut |
| Couvertures hautes | caisses de 2,4 m, blocs ardoise de 2,4 à 2,8 m, bloc central de 2,9 m |
| Bâtiments (non accessibles) | de 4 à 18 m ; les deux toits bas devant la galerie sont à 4 m (couverts par les playerClips) |
| Spawns | 8, deux par salle d'angle, centre de capsule à 0,93 m, orientés vers le centre de la salle |

## givre_01.physics.json (format `givre.physics.v1`)

Toutes les coordonnées sont dans le repère three.js. Les types complets sont dans `reference/givrePhysics.types.ts`.

| Clé | Contenu |
|---|---|
| `colliders[]` | 185 colliders statiques et fixes, qui bloquent les joueurs et les tirs. `shape: "box"` (171) : `center`, `halfExtents`, `min`, `max`, alignés sur les axes, sans rotation. `shape: "convexHull"` (14) : `points` ; ce sont les rampes, les garde-corps, le bloc central octogonal et les conduites de la chaudière. `source` donne l'objet Blender d'origine. |
| `playerClips[]` | 2 boîtes au-dessus des toits bas P1 et Q1 (Y de 4 à 16). Elles bloquent le personnage mais **pas les tirs** : la galerie garde sa vue sur la cour centrale. |
| `ramps[]` | 3 rampes : `lowCenter`, `highCenter`, `width`, `run`, `rise`, `slopeDeg`, et `colliderId` qui renvoie au convexHull correspondant dans `colliders`. |
| `spawns[]` | `position` (centre de capsule), `feet` (pieds), `yaw` en radians (convention `Object3D.rotation.y`, l'avant étant −Z local), `forward`, `room`. |
| `hazards[]` | Vide : il n'y a pas de zone mortelle. `killPlaneY` = −10. |
| `envelope` | Bornes XZ de la zone jouable, équivalent de `expansion.mapEnvelope` dans Yard. |
| `zones[]` | 18 rectangles XZ nommés, pour les callouts, la minimap ou les statistiques. `floorY` vaut 6 pour la galerie. |
| `viewpoints[]` | Les 5 points de vue de la minimap et une vue aérienne : `position`, `lookAt`, `horizontalFovDeg`. |
| `lighting`, `materials` | Réglages de rendu et palette repris de Blender. |

## Matériaux (glTF PBR sans texture, métal 0)

| Matériau | Couleur sRGB | Rugosité | Usage |
|---|---|---|---|
| GIV_Neige | #f4f5f9 | 0,92 | sol extérieur, chapeaux de neige, dessus de la galerie et des rampes |
| GIV_Mur | #d6cec8 | 0,90 | murs |
| GIV_Bande | #1f6f96 | 0,80 | soubassement teal (1,4 m) |
| GIV_Teal | #286a8c | 0,75 | galerie, parapets, bloc central, muret |
| GIV_Orange | #f45a1c | 0,60 | cadres de porte, climatiseurs, chaudière, têtes de machines |
| GIV_Caisse | #c8662f | 0,75 | caisses |
| GIV_Ardoise | #5b7187 | 0,80 | blocs de couverture, établis, guérite |
| GIV_Rail | #2a3a4d | 0,50 | garde-corps, montants d'étagères |
| GIV_Tuyau | #434c58 | 0,55 | conduites, cheminées |
| GIV_SolInt | #7c879a | 0,45 | sols intérieurs |
| GIV_Plafond | #a6a6ab | 0,90 | plafonds |
| GIV_PorteSombre | #5f6b7b | 0,70 | portes fermées décoratives |
| GIV_Sombre | #2f3742 | 0,80 | socles, grilles, cadres des plafonniers |
| GIV_Fenetre | #6f7782 | 0,35 | fenêtres |
| GIV_Lampe | émissif #fffcf9 × 6 | — | plafonniers |
| GIV_Montagne | #f2f5fa | 0,95 | montagnes (fond) |

## Rendu recommandé (three.js)

- **Sortie :** sRGB sans tone mapping, pour garder les aplats du concept.
- **Soleil :** DirectionalLight #fffbf5, direction vers le soleil (0,4045 ; 0,5878 ; −0,7006), soit l'est-nord-est à 36° au-dessus de l'horizon. Intensité ≈ 2,4 en lumières physiques (three.js r155+), à ajuster à l'œil.
- **Ombres :** activées sur le visuel uniquement, caméra d'ombre de ±150 m, carte de 4096 px.
- **Ambiance :** HemisphereLight avec ciel #98b0d6 et sol #b4b6ba, intensité ≈ π en lumières physiques.
- **Ciel :** dégradé selon la hauteur de la direction de vue (`lighting.skyBackground.stops`). `createGivreSky()` le fait avec une sphère à couleurs de sommets.
- **Intérieurs :** dans Blender, ils sont éclairés par des lumières de zone, qui ne sont pas exportées. En jeu, l'ambiance hemisphere et les plafonniers émissifs suffisent ; ajouter quelques PointLight si nécessaire.
- **Contour cel-shading :** le fin liseré blanc des concepts est fourni par `reference/GivreOutlinePass.ts`. Ordre des passes : `RenderPass`, puis `GivreOutlinePass`, puis `OutputPass`.
  - Le pass détecte les arêtes sur la géométrie seulement : cassures de normales et laplacien de 1/z. Il ne trace donc pas de fausses lignes sur le sol ou les aplats, et ne modifie ni les couleurs ni l'éclairage.
  - Réglages par défaut : épaisseur 1 px (trait d'environ 2 px), intensité 0,85, couleur #f6f9ff, seuils 0,4 (normales) et 0,02 (profondeur), atténuation de 150 à 400 m. `debugEdges = true` affiche les arêtes seules.
  - Sont ignorés : particules, lignes, sprites, matériaux transparents ou en fil de fer, et tout objet marqué `userData.noOutline = true` (le ciel et l'affichage debug des colliders le sont déjà dans `givreMap.reference.ts`).

## Performance

- `givre_01.glb` contient 89 objets, 225 primitives, 43 342 triangles et 15 matériaux. Fusionner les meshes statiques par matériau au chargement ramène le tout à environ 15 draw calls (voir `loadGivreVisual`).
- `givre_01_fond.glb` contient 2 objets et 2 116 triangles, sans ombres.

## Points d'attention

- Les chapeaux de neige débordent de 0,3 m en haut des murs. Ils ne sont pas dans les colliders, car ils sont hors d'atteinte.
- Les sols intérieurs visuels sont à Y = 0,03, alors que le collider de sol reste à Y = 0.
- Les cadres orange des portes font partie des colliders : ils réduisent l'ouverture à 12,4 m.
- Choix d'interprétation du concept :
  - toits bas devant la galerie, pour créer le surplomb sur la cour ;
  - le trait fin à l'ouest de la cour centrale devient un muret ;
  - piliers, étagères, établis et guérite ajoutés dans les salles ;
  - toutes les couvertures de la minimap restent à leur place.

## Régénérer ou modifier

1. Ouvrir `source/givre.blend`. Le texte `givre_lib.py` contient tout le plan (`MASSES`, `ROOMS`, `COVERS`, hauteurs…).
2. Exécuter les étapes voulues depuis la console Python de Blender :
   ```python
   ns = {}; exec(bpy.data.texts['givre_lib.py'].as_string(), ns)
   ns['stage_masses'](); ns['stage_rooms'](); ns['stage_colliders']()
   ```
3. Réexporter les GLB, puis régénérer `givre_01.physics.json` depuis la collection `GIVRE_Colliders`.
