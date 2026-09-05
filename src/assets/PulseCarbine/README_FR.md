# PULSE — Carabine sonique

Modèle réalisé dans Blender à partir de l’image fournie : armure rouge et graphite, touches de piano, deux haut-parleurs latéraux, bouche évasée, molette, notes de musique, écran encastré, chargeur courbe, pontet et crosse ajourés. Les faces non visibles sur la référence ont été complétées dans le même style. Les neuf barres sont dupliquées sur les deux faces. Les 19 touches du piano sont désormais animées : pivot sur le bord arrière, appui décalé puis remontée, avec trois accords alternés lors des tirs.

## Fichiers

- **PulseCarbine.blend** : modèle éditable, pièces sources, version regroupée pour le jeu, animations et éclairage de présentation. Blender 4.3 ou ultérieur.
- **PulseCarbine.glb** : version détaillée pour l’arme en main / une vue proche.
- **PulseCarbine_LOD1.glb** : version allégée pour mobile, armes au sol et autres joueurs à distance. Les petites arêtes sont simplifiées.
- **PulseCarbineController.js** : contrôleur Three.js prêt à relier à l’événement de tir ; alterne automatiquement les accords du piano.
- **demo.html** : aperçu interactif, tir simple / rafale, animation en boucle, bouton Vue piano, rotation, choix du niveau de détail.
- **Lancer_apercu.cmd** : ouvre l’aperçu sous Windows avec un serveur local. Laisser la fenêtre de serveur ouverte pendant la consultation, la fermer pour arrêter. Si le navigateur s’ouvre avant le serveur, recharger la page.
- **server.mjs** : autre lancement possible avec `node server.mjs`, puis ouvrir `http://127.0.0.1:8091/demo.html`. Le serveur écoute uniquement sur cet ordinateur. Node.js est nécessaire ; le lanceur reconnaît aussi le runtime Codex présent sur la machine de création.
- **PulseCarbine_Hero.png / PulseCarbine_Side.png** : rendus du modèle.
- **Piano_Tir_Detail.png** : aperçu rapproché du clavier pendant un appui.
- **LED_Palette.png** : minuscule palette lumineuse, déjà intégrée dans les GLB et dans le fichier Blender. Aucune image externe à charger pour utiliser les GLB.
- **diagnostics/** : mesures et rapports de vérification.

L’aperçu est autonome : Three.js 0.180.0 et les modules nécessaires sont fournis dans `vendor/`, avec leur licence. Aucun CDN ni connexion à un compte n’est utilisé. Dans ton jeu, utilise ta propre installation de Three.js.

## Animations de l’écran et du piano

| Clip | Durée | Utilisation |
|---|---:|---|
| `Idle` | 1 s | Barres courtes et touches relevées, boucle sans variation. |
| `Fire` | 0,7 s | Premier accord de piano, variations de l’écran et retour au repos. |
| `Fire_AltA` | 0,7 s | Deuxième accord, même impulsion d’écran. |
| `Fire_AltB` | 0,7 s | Troisième accord, même impulsion d’écran. |
| `MusicLoop` | 2 s | Touches et égaliseur en boucle, raccord identique au début et à la fin. |

Le mouvement imite un égaliseur musical et des appuis sur un clavier. Aucun son ni analyse automatique d’un fichier audio n’est inclus. Le trait de forme d’onde sous les barres reste fixe. L’animation concerne l’écran et le piano ; les mains, le recul, les projectiles et le rechargement appartiennent à la logique du jeu.

Les touches restent rigides : aucune déformation de leur forme. Elles pivotent de 5,5 à 6 degrés au maximum et se déplacent d’environ 4 à 8,4 mm à l’avant selon la touche et l’accord. Les appuis sont légèrement décalés ; chaque clip finit avec toutes les touches relevées. `Piano_Keys` contient les 19 touches, avec les os `KEY_00` à `KEY_18` triés le long du clavier. Le fichier `diagnostics/piano_mapping.json` indique leur correspondance avec les pièces sources.

Dans Blender, la timeline de 0 à 60 images prévisualise `MusicLoop` à 30 images/seconde. Appuyer sur Espace dans la vue 3D pour lire / arrêter. Les autres clips se trouvent dans les pistes NLA de `Equalizer_Rig` ; activer une seule piste à la fois pour les prévisualiser.

## Branchement dans Three.js

```js
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { PulseCarbineController } from './PulseCarbineController.js';

const gltf = await new GLTFLoader().loadAsync('/assets/PulseCarbine.glb');
const weapon = new PulseCarbineController(gltf);
scene.add(weapon.object);

// À appeler lorsqu’un tir est réellement accepté par ta logique de jeu.
function onShotAccepted() {
  weapon.onFire();
}

// Dans ta boucle existante, avec un temps exprimé en secondes.
function updateWeapon(deltaSeconds) {
  weapon.update(deltaSeconds);
}

// Facultatif : animation continue hors tir.
weapon.setMusic(true);
weapon.setMusic(false);

// Lorsque cette instance n’est plus utilisée.
weapon.dispose();
```

`onFire()` relance l’impulsion à chaque appel, y compris en rafale, et alterne `Fire`, `Fire_AltA`, `Fire_AltB`. L’écran et le piano sont déclenchés ensemble, sans changer l’appel dans le jeu. Après la dernière impulsion, le contrôleur reprend `Idle` ou `MusicLoop` selon le réglage. Chaque instance possède son propre squelette et son propre mélangeur ; les géométries et matériaux restent partagés. `dispose()` arrête et détache l’instance, mais laisse les ressources partagées au gestionnaire d’assets de ton jeu. Le contrôleur accepte aussi l’ancien GLB, avec un seul clip `Fire`.

Les deux GLB possèdent les mêmes noms de clips et de points d’attache. Choisis l’un des deux fichiers au chargement. Pour un changement de LOD pendant une animation, synchronise les temps des mélangeurs. La démo redémarre la boucle lors du changement de fichier.

## Repères et échelle

- GLB en mètres, axe vertical **+Y**, bouche dirigée vers **−X**.
- Dimensions approximatives : **1,113 × 0,645 × 0,199 m** (longueur, hauteur, épaisseur).
- Pour viser vers −Z, appliquer `weapon.object.rotation.y = -Math.PI / 2` à partir de l’orientation d’origine.
- `Muzzle` : centre de sortie, pour effets et projectiles ; la direction de sortie reste l’axe −X transformé par la rotation de l’arme.
- `GripSocket`, `OffhandSocket`, `StockSocket` : repères de positionnement.
- Les repères sont des objets vides, sans géométrie de collision. Prévoir une collision simplifiée dans le jeu.

```js
import { Vector3, Quaternion } from 'three';

weapon.object.updateMatrixWorld(true);
const origin = weapon.muzzle.getWorldPosition(new Vector3());
const orientation = weapon.muzzle.getWorldQuaternion(new Quaternion());
const direction = new Vector3(-1, 0, 0).applyQuaternion(orientation).normalize();
```

## Budget de rendu

| Mesure | Détaillé | Mobile / distance |
|---|---:|---:|
| Triangles | 17 308 | 8 761 |
| Taille GLB | 1 200 848 octets | 773 972 octets |
| Appels de rendu du modèle | 7 | 7 |
| Matériaux PBR | 5 | 5 |
| Os animés | 28 | 28 |
| Texture embarquée | 2 × 256 pixels | 2 × 256 pixels |

Les pièces fixes sont regroupées par matériau, les dix-huit barres utilisent un seul maillage animé. Le piano utilise un maillage supplémentaire et un seul matériau existant : un appel de rendu ajouté, aucune texture ajoutée, 1 824 sommets supplémentaires à animer. Les anciennes touches fixes ont été retirées de la carrosserie ; elles ne sont pas dupliquées. Chaque sommet de touche dépend d’un seul os. Les touches gardent leur géométrie détaillée dans le LOD pour conserver des contours propres en mouvement. Couleurs par sommet pour la carrosserie ; palette partagée pour le dégradé lumineux. Les GLB ne nécessitent ni décodeur Draco ni Meshopt. Les triangles dégénérés ont été nettoyés. Pas de transparence ni d’effet de bloom requis. Les ombres et les passes supplémentaires du jeu augmentent les appels de rendu.

Sur mobile, commencer avec le GLB allégé, limiter le ratio de pixels et éviter les ombres dynamiques sur toutes les armes. Mesurer ensuite dans la scène et sur les téléphones ciblés : aucune promesse de fréquence d’images n’a été mesurée sur un appareil mobile physique.

## Organisation Blender

- `01_SOURCE_Pieces_editables` : pièces individuelles masquées, alignées à la même échelle par `Source_Scale`. Pour les éditer, masquer `02_GAME_Export` puis activer cette collection.
- `02_GAME_Export` : version regroupée, rig et points d’attache, utilisée dans les exports.
- `03_STUDIO_Non_exporte` : caméra, sol et lumières de présentation. Masqués dans la vue de travail, exclus des GLB.

Les pièces sources et la version regroupée sont des copies indépendantes. Après modification des sources, reconstruire la version de jeu ou exporter les pièces sélectionnées puis les regrouper. Pour réexporter les animations depuis Blender : sélectionner uniquement la collection GAME, choisir glTF binaire, animations par pistes NLA, skins activés, axe Y vers le haut. Les tailles indiquées correspondent aux GLB optimisés fournis.

## Vérifications

Validation glTF : **zéro erreur** sur les deux exports. Le validateur émet deux avertissements de hiérarchie sur les maillages animés ; leurs positions et animations ont été vérifiées dans Three.js. Les objets vides signalés correspondent aux repères d’attache.

Tests exécutés avec Three.js 0.180.0 et Chrome : lecture des clips, retour au repos, reprise de la boucle musicale, 50 déclenchements successifs, indépendance des squelettes entre instances, suivi de la translation du modèle par les barres, chargement du LOD et affichage dans un viewport de téléphone. Pour le piano, dans les deux GLB : mouvement descendant des 19 touches, rigidité de la géométrie, distinction des trois accords, retour exact en position après chaque clip et après 50 tirs, reprise de la musique. Zéro erreur de chargement / JavaScript dans la vérification finale. L’intégration à ton jeu existant reste à brancher via l’événement ci-dessus.

Références d’intégration : [GLTFLoader](https://threejs.org/docs/#GLTFLoader), [AnimationAction](https://threejs.org/docs/#AnimationAction), [SkeletonUtils](https://threejs.org/docs/#SkeletonUtils).
