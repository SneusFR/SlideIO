# Ancient Jungle City

Carte extérieure de 120 × 120 m conçue pour un FPS rapide à 8 joueurs. Le fichier Blender est modifiable ; le GLB et les collisions séparées sont prêts à intégrer dans three.js et Rapier.

## Fichiers

| Fichier | Usage |
| --- | --- |
| `Ancient_Jungle_City.blend` | Scène Blender 4.3, objets regroupés par zone, matériaux, caméras et collisions éditables |
| `ancient_jungle_city.glb` | Décor optimisé, compressé avec Meshopt, sans textures externes |
| `ancient_jungle_city.physics.json` | Collisions fixes, 8 apparitions, zones, escaliers et parcours de référence |
| `loadAncientJungleCity.js` | Chargement three.js / Rapier et réglages du contrôleur |
| `Plan_Carte.svg` | Plan des routes, niveaux et apparitions |
| `Overview.png`, `Top_Down.png` | Vues d’ensemble de la géométrie finale |
| `Central_Crossing.png`, `Canal_Run.png` | Vues à hauteur de joueur |
| `map_stats.json`, `validation.json` | Mesures de l’export et résultats des contrôles |

## Parcours et échelle

**1 unité Blender = 1 mètre.** Trois voies nord–sud se rejoignent par le centre et par les deux extrémités. Les quatre masses de ruines séparent les combats sans former de pièces intérieures. Le réseau de référence est connecté ; chaque nœud possède au moins deux connexions accessibles à pied.

| Zone | Niveau du sol | Rôle |
| --- | ---: | --- |
| Central Crossing | 0 m | Carrefour, mosaïque solaire, couvertures basses et piliers |
| Golden Lane | +1,5 m | Voie ouest surélevée, alternance de couvertures |
| East Ridge | +3 m | Voie haute, saut facultatif de 4,5 m et contournement au sol |
| Terrace Path | +1,5 m | Voie sud-est avec deux accès par escalier |
| Ruin Walk | 0 m | Duels plus rapprochés, ruines et fragments de gardiens |
| Canal Run | 0 m | Canaux franchissables et ligne de tir longue |
| Lower Court | −1,5 m | Cour ouverte, trois accès larges |
| Sun Gate | +3 m | Repère principal, escalier central et deux accès latéraux |

Les marches visibles font au plus 15 cm. Les collisions utilisent des rampes lisses ; leur pente maximale est de 14,04°. Les couvertures basses font environ 1,15 m ; les blocs hauts dépassent 2 m. Les accès principaux font 6 à 24 m de large. Le contournement de la fontaine au nord-est se resserre à environ 2 m sur quelques mètres.

Le canal utilise une surface d’eau opaque, décorative et sans effet de ralentissement. Les ponts bas se franchissent avec l’autostep. La végétation jouable reste basse ou fixée aux murs ; les grands arbres et temples de fond sont hors des limites. La carte est limitée physiquement par les murs périphériques. Aucun égout ni POI intérieur n’est inclus.

## Budget navigateur mesuré

La carte entière, arrière-plan compris, contient **119 600 triangles, 92 lots de rendu et 4 matériaux**, sans textures. Le GLB final pèse environ **1,29 Mo**. L’export conserve des secteurs de 30 m afin que three.js puisse écarter les objets hors du champ.

Les collisions comprennent **111 boîtes et 12 formes convexes**, toutes fixes. Aucun maillage triangulé de collision, feuillage physique, particule, eau transparente ou lumière dynamique n’est nécessaire.

Le test WebGL de la vue d’ensemble a rendu 92 appels et 119 600 triangles, sans erreur JavaScript. Ces chiffres concernent le décor seul et un passage de rendu ; ils ne constituent pas une garantie de FPS. Les joueurs, armes, effets, ombres et traitements du jeu ajoutent leur propre coût. Commencer avec les ombres temps réel désactivées et un ratio de pixels plafonné à 1,5 ; mesurer ensuite sur les appareils ciblés.

## Intégration

Versions utilisées pour les contrôles : `three@0.180.0` et `@dimforge/rapier3d-compat@0.17.3`. Le GLB utilise `EXT_meshopt_compression` et `KHR_mesh_quantization`. Le chargeur fourni configure le décodeur Meshopt livré avec three.js. Les positions ont été quantifiées sur une grille commune à 16 bits pour préserver les raccords des dalles.

```js
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { loadAncientJungleCity, createMapCharacterController } from './loadAncientJungleCity.js';

await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: -26.44, z: 0 });
const map = await loadAncientJungleCity({
  THREE, RAPIER, scene, world,
  baseUrl: '/assets/maps/ancient-jungle-city/',
  shadows: false
});
const controller = createMapCharacterController(world);
const [x, y, z] = map.metadata.spawns[0].position;
const body = world.createRigidBody(
  RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(x, y, z)
);
const player = world.createCollider(RAPIER.ColliderDesc.capsule(0.55, 0.35), body);
```

Le demi-segment de capsule est de 0,55 m et son rayon de 0,35 m : hauteur totale 1,80 m. Les positions `spawns[].position` sont les **centres de capsule**, avec une petite marge au sol. Les points de `navigation` sont les **positions des pieds**. `yaw` est en radians. Le graphe fourni sert de référence de circulation ; il ne remplace pas un navmesh ni un système d’IA.

Le JSON et le GLB sont déjà en **Y-up** : `(x, y, z) Blender → (x, z, −y) three.js`. Ne pas appliquer de rotation ou d’échelle supplémentaire au décor. Les canaux, mosaïques et petites décorations ne demandent aucune collision additionnelle.

Le contrôleur doit recevoir la gravité et les déplacements à chaque pas de simulation. Les tests utilisent 120 Hz, une marge de 2,5 cm, un autostep de 25 cm et un ancrage au sol de 30 cm. Adapter le pas à celui du jeu et revérifier les parcours. Un saut balistique avec gravité 26,44 m/s² et impulsion initiale 8,906 m/s donne approximativement la hauteur et la portée demandées à 9,5 m/s. Garder les valeurs du contrôleur réel du jeu si elles sont déjà établies.

Pour le multijoueur, charger le même JSON côté serveur avec la même version de Rapier et le même pas fixe. Le GLB reste côté client. La carte ne contient pas de serveur réseau, de sélection dynamique des apparitions ni de règles de match ; ces éléments appartiennent au jeu. Appeler `map.dispose()` pour décharger le niveau, puis libérer séparément le contrôleur et les joueurs.

L’éclairage appartient à la scène du jeu. Une lumière hémisphérique et une lumière directionnelle suffisent pour démarrer ; les rendus PNG utilisent l’éclairage de présentation Blender et ne sont pas des captures de partie.

Références techniques : [GLTFLoader et décodeur Meshopt](https://threejs.org/docs/pages/GLTFLoader.html), [contrôleur de personnage Rapier](https://rapier.rs/docs/user_guides/javascript/character_controller/), [compression glTF Transform](https://gltf-transform.dev/modules/functions/functions/meshopt).

## Modifier dans Blender

Les collections `00` à `10` contiennent le décor organisé par zone. `80 Gameplay markers` contient les apparitions. `81 Collision proxies` contient les volumes de collision, masqués par défaut. `90 Presentation` contient les caméras et la lumière. `99 Runtime batches` est la copie regroupée pour l’export et reste masquée pour éviter les doublons.

Modifier le décor ne modifie pas automatiquement le GLB ni le JSON : mettre les proxies à jour, reconstruire l’export et revérifier les routes avant intégration. Les détails de façades et feuillages sont simplifiés dans les collisions pour éviter que le joueur accroche les ornements.

## Contrôles réalisés et limites

- 8 apparitions testées sans intersection avec le décor.
- 68 parcours Rapier réussis : 17 liaisons à pied, dans les deux sens, à 9,5 et 13 m/s, avec la capsule debout.
- Saut de la brèche d’East Ridge réussi dans les deux sens.
- Déplacement libre de 5,25 m et arrêt d’un déplacement rapide contre une couverture vérifiés.
- Lignes de tir libres vérifiées à 12 m, 20 m et 47 m.
- Export Blender validé sans erreur ni avertissement glTF ; export compressé décodé et affiché dans three.js.
- Vues Blender et rendu WebGL inspectés après les corrections.

La géométrie et la circulation ont été vérifiées automatiquement. L’équilibrage à huit joueurs, les apparitions sous le feu ennemi, les portées des armes et les performances sur mobiles restent à éprouver dans le jeu réel. Les longues voies peuvent offrir d’autres angles de tir que les trois segments mesurés.
