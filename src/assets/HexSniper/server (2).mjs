# Hex Sniper — langue grappin et morsure

Le modèle Blender et les deux GLB contiennent maintenant une mâchoire articulée, des crocs, une langue extensible et quatre animations d’attaque. La tête reste centrée et engagée dans le canon. L’attente conserve le halètement varié de la langue et les mouvements de tête et de chapeau.

Le kit fournit les contrôleurs et une démonstration jouable. Il faut relier leurs callbacks aux collisions, aux joueurs et aux dégâts de ton jeu : le kit n’a pas accès à ton projet ni à son moteur physique.

## Essayer les attaques

Depuis ce dossier, lance `node server.mjs`, puis ouvre [la démonstration](http://127.0.0.1:8092/demo.html). Le serveur écoute uniquement sur cette machine. Three.js 0.180.0 et sa licence sont inclus dans `vendor` ; aucun téléchargement externe n’est nécessaire à la démo.

- Clic gauche ou bouton **Langue** : projette la langue. Raccourci Espace.
- Clic droit ou bouton **Morsure** : claque la mâchoire et secoue vigoureusement la tête. Raccourci V.
- Sur mobile, utilise les deux boutons. Glisse sur la scène pour tourner autour.
- Essaie les scénarios joueur, mur devant joueur, objet, carte vide et cible à mordre. La ligne verte indique la limite de cette petite carte.

La démo utilise des vitesses de projection/traction/retour de 12/3/15 m/s pour rendre les interactions lisibles. Les valeurs par défaut du contrôleur sont 35/12/45 m/s.

## Fichiers

| Fichier | Rôle |
|---|---|
| `HexSniper.blend` | Source Blender 4.3, modèle détaillé, squelette, animations, pièces éditables et studio. |
| `HexSniper.glb` | Modèle détaillé, 1 253 996 octets, 14 630 triangles stockés. |
| `HexSniper_LOD1.glb` | Variante allégée, 753 916 octets, 7 380 triangles stockés. |
| `HexSniperController.js` + `HexSniperAttackVisuals.js` | Animation et affichage de la langue entre la bouche et une position du monde. |
| `HexSniperAttacks.js` | Règles des deux attaques, callbacks de physique et événements. |
| `INTEGRATION_EXAMPLE.js` | Fonction de montage et branchement facultatif souris/tactile. |
| `DemoWorld.js`, `attacks-demo.js`, `demo.html` | Exemple complet ; physique simplifiée de démonstration. |
| `PROMPT_CLINE.txt` | Demande prête à copier dans Cline pour intégrer le kit au projet réel. |
| `asset_stats.json`, `attack_tests.json`, `transform_tests.json`, rapports de validation | Mesures et vérifications. |

Copie au minimum un GLB et les trois modules de contrôle. L’exemple requiert aussi `INTEGRATION_EXAMPLE.js`. Utilise la même installation de Three.js pour tous les modules, GLTFLoader et SkeletonUtils.

## Règles des attaques

**Langue :** un clic accepté lance l’extrémité dans la direction de visée capturée au départ. À chaque pas physique, un balayage continu teste le segment parcouru, avec l’épaisseur de la langue. Le premier contact arrête le vol, quel que soit le type d’objet. Un joueur valide est ramené vers le tireur ; un mur ou un autre objet provoque un retour vide. Une sortie de carte provoque également un retour vide.

Il n’existe ni portée maximale ni expiration du projectile. La limite est celle de la carte fournie par le jeu. `maxDistance` dans le callback de traction désigne seulement le déplacement autorisé pendant **un pas physique**, pas la portée de l’attaque. `pullStopDistance` est l’écart d’arrivée entre les joueurs.

La traction utilise le déplacement physique du joueur, avec ses collisions. Si un obstacle bloque le joueur, la langue le relâche et revient. La mort ou la disparition de la cible déclenche aussi un retour. Le point d’arrivée suit le tireur lorsqu’il se déplace. L’extrémité reste droite entre la bouche et la cible : le kit ne simule pas une corde s’enroulant autour des obstacles.

**Morsure :** ouverture, claquement, agitation rapide et second effort de déchirement, puis retour à l’attente. Deux fenêtres de contact sont prévues, de 0,14 à 0,24 s et de 0,36 à 0,70 s. Une cible reçoit au plus un événement par fenêtre, donc deux par attaque, indépendamment du nombre d’images par seconde. Le jeu décide des dégâts, sons et effets sur les éléments destructibles.

Une seule attaque est active à la fois. `tryTongue()` et `tryBite()` retournent `false` si l’arme est occupée. Il n’y a pas de répétition automatique à l’appui maintenu.

## Branchement dans Three.js

Cet exemple concerne un jeu local où la simulation est autoritaire. Les objets `weaponHolder`, `scene`, `gamePhysics`, `player`, `aim`, `damageSystem`, `gamePaused` et `renderer` correspondent aux systèmes existants de ton jeu.

```js
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createHexSniper, bindHexSniperInputs } from './INTEGRATION_EXAMPLE.js';

// Charger une fois et conserver l’asset dans le cache du jeu.
const gltf = await new GLTFLoader().loadAsync('/assets/HexSniper_LOD1.glb');
const sniper = createHexSniper({
  gltf,
  holder: weaponHolder,
  effectsParent: scene, // scène du monde, où se trouve la langue extensible
  world: gamePhysics.hexSniperAdapter, // les cinq callbacks ci-dessous
  ownerId: player.id,
  pose: {
    origin: out => player.getWeaponOriginWorld(out),
    direction: out => aim.getDirectionWorld(out),
    pullDestination: out => player.getPullDestinationWorld(out)
  },
  onEvent(event) {
    if (event.type === 'bite-hit') {
      damageSystem.applyWeaponHit({
        attackerId: player.id, targetId: event.hit.id,
        weapon: 'hex-sniper', attackId: event.attackId, pulse: event.pulse
      });
    }
  }
});

// Modèle : avant = -X, haut = +Y. Pour un conteneur visant vers -Z :
sniper.object.rotation.y = -Math.PI / 2;

// Facultatif : si le jeu a déjà ses actions d’entrée, brancher directement
// sniper.primary() et sniper.secondary() dans ces actions existantes.
const unbind = bindHexSniperInputs({
  element: renderer.domElement,
  requestTongue: sniper.primary,
  requestBite: sniper.secondary,
  tongueButton: document.querySelector('#attack-primary'),
  biteButton: document.querySelector('#attack-secondary'),
  enabled: () => player.equippedWeapon === 'hex-sniper' && !gamePaused
});

// Dans le pas physique EXISTANT du jeu, en secondes :
sniper.fixedUpdate(fixedDeltaSeconds);

// Dans la boucle de rendu EXISTANTE, après la mise à jour du joueur :
sniper.updateVisuals(renderDeltaSeconds);

// Mort, étourdissement, déséquipement :
sniper.cancel('unequipped');

// À la destruction de l’instance :
unbind();
sniper.dispose();
```

Les appels de mise à jour et de destruction illustrent des moments distincts ; ne les exécute pas successivement au chargement. Réutilise les boucles existantes. Ne crée pas un second AnimationMixer sur les mêmes os.

L’origine physique doit se trouver dans le monde réel du jeu. Pour une vue FPS rendue avec une caméra séparée, ne prends pas les coordonnées artificielles du viewmodel comme origine physique. Utilise le repère d’arme du joueur dans la simulation. Si le viewmodel a son propre espace ou sa propre caméra, adapte le raccord de bouche à la scène des effets ou utilise une arme en espace monde.

## Adaptateur physique : cinq callbacks

Toutes les positions sont des `THREE.Vector3` en coordonnées mondiales, en mètres. Les callbacks sont synchrones. Les vecteurs de travail sont réutilisés : copie une valeur si tu dois la conserver.

### 1. distanceToMapExit(point, direction, radius)

Renvoie la distance jusqu’à la première sortie des limites de carte depuis `point`, dans la direction normalisée. Renvoie 0 si déjà dehors, `Infinity` si cette direction ne sort pas. Ne remplace pas cette distance par une portée fixe.

Pour une carte rectangulaire alignée sur les axes, utilise le helper exporté `distanceToBoxExit(point, direction, mapBounds, radius)` de `HexSniperAttacks.js`, avec `mapBounds` de type `THREE.Box3`. Pour des limites irrégulières, branche le volume de carte existant. Une carte sans aucun bord ni obstacle laisse logiquement la langue voler sans fin.

### 2. sweepTongue(from, to, { ownerId, radius })

Balaye une sphère de rayon `radius` sur le segment `from → to`. Teste ensemble décor, joueurs et objets interactifs, ignore le propriétaire, et retourne le résultat **le plus proche** ou `null`. Ne cherche pas les joueurs séparément des murs.

```js
// Joueur :
{ id: colliderId, kind: 'player', playerId, point: centerAtImpact }
// Autre collision :
{ id: colliderId, kind: 'world', point: centerAtImpact }
```

`point` est la position mondiale de l’extrémité/du centre de la sphère au premier impact, située sur le segment. Si le moteur renvoie un point de contact sur la surface et une distance de parcours, calcule `from + direction * distanceParcourue` pour ce champ. Traite aussi les chevauchements au départ. Utilise les colliders du jeu, pas le maillage animé de la langue.

### 3. getPlayerPosition(playerId, out)

Écrit la position actuelle du joueur dans `out` et renvoie `true`. Renvoie `false` si la cible n’est plus valide, par exemple morte ou déconnectée.

### 4. movePlayerToward(playerId, destination, options)

`options` contient `maxDistance`, `stopDistance` et `ownerId`. Déplace le collider complet du joueur vers `destination`, d’au plus `maxDistance`, et arrête-le à `stopDistance`. Utilise le character controller ou les balayages du moteur physique pour éviter murs et sols.

Retourne `{ reached: true }` à l’arrivée, `{ blocked: true }` en cas de blocage, `{ valid: false }` si la cible a disparu, ou `{}` si la traction continue. Mets à jour la position physique avant de revenir. Adapte l’état de mouvement du joueur pendant la traction pour que sa locomotion n’annule pas immédiatement le déplacement imposé.

### 5. queryBite({ origin, direction, range, radius, ownerId, attackId, pulse })

Retourne les cibles dans un volume court devant la bouche, par exemple une capsule orientée vers `direction`, et retire celles cachées derrière un mur. Chaque résultat possède un `id` stable et éventuellement `kind`, `playerId`. Retourne `[]` si rien n’est touché. L’identifiant stable permet la déduplication des dégâts par fenêtre. Inclue les objets destructibles selon les règles du jeu.

`DemoWorld.js` illustre ces contrats avec des sphères et boîtes. Ses volumes simplifiés ne remplacent pas les colliders de ton jeu.

## Multijoueur et réglages

Exécute `HexSniperAttacks` sur le serveur ou l’autorité de simulation, avec `visuals: null`. Les clics client demandent une attaque ; le serveur valide état, collision, traction et dégâts. Évite d’appliquer les dégâts une deuxième fois côté client.

Le client utilise `HexSniperController`. Réplique l’état, `attackId` et la position `tip` pendant l’attaque, puis interpole l’extrémité à l’affichage :

| Information reçue | Appel visuel |
|---|---|
| Début de langue | `visuals.beginTongue(tip)` |
| Nouvelle position d’extrémité | `visuals.setTongueEndpoint(tip)` |
| Joueur accroché | `visuals.beginPull()` |
| Début du retour | `visuals.beginReturn()` |
| Extrémité revenue à la bouche | `visuals.endTongue()` |
| Début de morsure | `visuals.bite()` |
| Annulation | `visuals.reset()` |

Les phases intermédiaires et le retour à Idle sont gérés par le contrôleur visuel. Utilise `attackId` pour ignorer les événements d’une ancienne attaque. Pour une arrivée tardive, synchronise aussi le temps écoulé et la phase selon le système réseau du jeu. Le kit fournit les briques locales, pas un protocole réseau complet.

Valeurs par défaut : `projectileSpeed: 35`, `returnSpeed: 45`, `pullSpeed: 12`, `tongueRadius: 0.04`, `pullStopDistance: 1.2`, `biteRange: 0.75`, `biteRadius: 0.38`. Distances en mètres, vitesses en m/s. Passe ces réglages dans `tuning` avec l’exemple, ou directement au constructeur `HexSniperAttacks`.

Garde `biteDuration = 29/30` et `recoverDuration = 10/30` avec les clips fournis. Si tu modifies leur vitesse, adapte ensemble durées, fenêtres de contact et vitesse des animations. La courte portée de morsure n’affecte pas la portée illimitée de la langue.

## Blender et animations

| Clip | Durée | Fonction |
|---|---:|---|
| `Idle` | 4 s, boucle | Halètement varié, tête et chapeau. |
| `Tongue_Cast` | 0,30 s | Ouverture et projection. |
| `Tongue_Hold` | 1 s, boucle | Bouche ouverte et tension pendant vol, prise et retour. |
| `Tongue_Return` | 0,333 s | Récupération et déploiement de la langue d’attente. |
| `Bite` | 0,967 s | Claquements et secousses vigoureuses, puis récupération. |
| `Fire` | 0,8 s | Ancienne réaction cosmétique ; `onFire()` ne déclenche pas la langue grappin. |

`02_GAME_Export` contient les éléments de jeu. `01_SOURCE_Editable` conserve les pièces de construction masquées ; `03_STUDIO` contient la présentation, exclue des GLB. Sur `Creature_Rig`, la piste NLA Idle est active. Pour examiner une autre animation, désactive Idle, active uniquement la piste voulue et lis sa plage à 30 images/s : Cast 0–9, Hold 0–30, Return 0–10, Bite 0–29. Remets Idle seule active ensuite.

Huit os : `BARREL_ANCHOR` fixe, `HEAD`, `HAT_BASE`, `HAT_TIP`, `TONGUE_ROOT`, `TONGUE_MID`, `TONGUE_TIP` et `JAW`. `Creature_Animated` contient la tête et les crocs ; `Tongue_Idle` est une peau séparée masquée pendant les attaques.

`Tongue_Tether` est le gabarit de langue projetée, avec une extrémité arrondie. Axe local +X, tige de 0 à 1, pointe jusqu’à 1,12. Il est rangé à une échelle de 0,001 dans la bouche dans le GLB ; c’est volontaire. Le contrôleur lui rend sa taille et étire sa longueur vers le point de collision en conservant l’épaisseur de la pointe. Ne supprime pas ce petit objet lors d’un export. Une trajectoire complète n’est pas précalculée dans Blender : sa longueur dépend des collisions du jeu.

Repères : `TongueOrigin` suit la tête dans la bouche, `BiteOrigin` suit la zone de morsure, `Muzzle` est le repère statique avant de l’arme. `GripSocket`, `OffhandSocket`, `ScopeAim` et `HeadSocket` restent disponibles. L’animation de tête est décorative et ne doit pas dévier la visée physique.

Le modèle regarde vers −X, avec +Y en haut après chargement glTF. Le conteneur Blender conserve une échelle de 0,19 pour convertir les unités de construction en mètres. Ajuste le conteneur externe pour le cadrage et conserve la hiérarchie interne. La largeur de langue projetée se règle séparément via `tongueWidthScale` dans le constructeur visuel si le jeu utilise une autre échelle.

## Web/mobile et vérification

Cinq matériaux opaques, huit os et aucune texture pour les deux variantes. Aucun morph target ni décodeur Draco/KTX. La langue projetée contient seulement 140 triangles ; sa complexité ne grandit pas avec la distance.

Au repos, l’arme détaillée affiche 14 490 triangles et LOD1 7 240, avec six appels de rendu dans cette démo sans ombres. Le gabarit de langue est caché. Pendant la projection, la langue d’attente est remplacée par la langue extensible : le nombre d’appels reste six. La morsure commence à cinq appels lorsque les deux langues sont cachées. Les autres passes du moteur, notamment les ombres, s’ajoutent à ces nombres.

Le contrôleur clone les squelettes, partage matériaux et géométries de base, et garde un petit tampon de langue par instance. `dispose()` libère les ressources propres à l’instance ; les ressources partagées du cache restent au jeu. Charge seulement les variantes nécessaires, choisis le LOD selon le budget et suspends l’animation cosmétique des armes invisibles. Une attaque active doit continuer d’être simulée par l’autorité même si elle est hors écran.

Vérifié dans Chrome avec Three.js 0.180.0 : premier obstacle avant joueur, premier joueur seulement, traction bloquée par un mur, disparition de cible, annulation, sortie exacte de carte, vol de 300 secondes sans expiration, balayage de 3,5 km et affichage de langue jusqu’à 10 km. Morsure testée à 60 Hz et avec un grand pas pour vérifier les fenêtres de contact et la déduplication. Les deux GLB ont été chargés et animés. Le bouton tactile a été testé dans un viewport de 390 × 844. Ce sont des tests sur ordinateur, pas un benchmark sur téléphone physique.

Les validateurs glTF rapportent zéro erreur et deux avertissements `NODE_SKINNED_MESH_NON_ROOT` par GLB, liés aux deux peaux dans la hiérarchie Blender. Les tests de transformation vérifient que ces peaux suivent leur conteneur dans Three.js. Détails dans les rapports JSON.

Références d’API : [AnimationAction](https://threejs.org/docs/pages/AnimationAction.html), [BufferAttribute](https://threejs.org/docs/pages/BufferAttribute.html), [Raycaster](https://threejs.org/docs/pages/Raycaster.html). Un raycast seul n’ajoute pas l’épaisseur du projectile ; utilise le shape cast du moteur ou un équivalent approprié.

