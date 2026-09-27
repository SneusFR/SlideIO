# Paintball Rifle — intégration

Fusil de paintball façon AK, à deux mains et **automatique** : **32 billes**, 600 coups/min (0,1 s entre deux billes). Les billes sont de 3 couleurs mélangées dans le réservoir transparent posé sur l'arme. Chaque bille garde sa couleur, qui colore la surface ou le joueur touché.

- **Tir : hitscan.** Un raycast instantané par bille, 12 dégâts au corps, ×1,5 à la tête (18), portée 45 m. La bille qu'on voit voler est visuelle.
- **Peinture :** les taches restent sur le décor, et un joueur garde sa peinture jusqu'à sa mort.
- **Recharge : changement de réservoir.** Le pouce appuie sur le bouton, la main arrache le réservoir vide et le lâche, va chercher un réservoir plein (hors champ en FP, à la ceinture en TP), le clipse, tape dessus, puis tire le levier d'armement.
- **Branchement :** comme le HexSniper et le Popcorn Shotgun, le paquet se branche sur le `ViewmodelSystem` existant **sans le modifier**.

## Fichiers

| Fichier | À placer dans | Rôle |
|---|---|---|
| `assets/potato/PaintballRifle_Weapon.glb` | `src/assets/potato/` | Arme : root 0.19, avant = −X. Contient la gâchette, le levier d'armement et le réservoir animés, les sockets, le gabarit de bille et les données physiques du réservoir. |
| `assets/potato/PaintballRifle_FP_Poses.glb` | `src/assets/potato/` | 11 clips FP sur `Potato_FP_CommonArms`, animations seules, mêmes 20 canaux que le HexSniper. |
| `assets/potato/PaintballRifle_TP_Poses.glb` | `src/assets/potato/` | 8 clips TP sur `Potato_TP_Character`, animations seules. |
| `assets/potato/WeaponProfile_PaintballRifle.json` | `src/assets/potato/` | Matrices de montage FP/TP, clips, timelines d'événements, données du réservoir. |
| `profiles/PaintballRifleProfile.ts` | à côté de `HexSniperProfile.ts` | `WeaponViewProfile`, `PAINTBALL_TP_AIM_CLIPS` et `PAINTBALL_RIFLE_TIMELINE`. |
| `weapons/paintball/PaintballRifleController.ts`, `PaintballHopper.ts`, `PaintballHopperSim.ts` | ex. `src/game/weapons/paintball/` | Contrôleur, réservoir three.js et solveur physique pur. |
| `weapons/paintball/PaintballProjectiles.ts` | même dossier | Billes en vol, purement visuelles (1 draw call). |
| `weapons/paintball/PaintSplats.ts` | même dossier | Taches de peinture : décor (1 draw call) et joueurs (peinture par sommet qui suit l'animation). |
| `weapons/paintball/PaintballSpread.ts` | même dossier | **Référence gameplay** : dégâts (12 corps, ×1,5 tête), dispersion qui s'ouvre en rafale, seed déterministe. |

- **Perso TP.** Le paquet ne contient **pas** de `Potato_TP_Character.glb`. Il utilise le perso corrigé (flancs et aisselles) livré avec le Popcorn Shotgun : garde celui-là.
- **Imports.** Les imports d'assets de `PaintballRifleProfile.ts` suivent exactement les chemins de `HexSniperProfile.ts` (`../../assets/potato/...?url`).
- **Dépendances.** Les modules de `weapons/paintball/` n'importent que `three` et leurs voisins.

## Équiper (vue FP, joueur local)

```ts
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { PaintballRifleProfile, PAINTBALL_RIFLE_TIMELINE } from "../profiles/PaintballRifleProfile";
import { PaintballRifleController } from "../weapons/paintball/PaintballRifleController";

const gltf = await new GLTFLoader().loadAsync(PaintballRifleProfile.weaponUrl);   // à mettre en cache (FP + TP)
const rifle = new PaintballRifleController(gltf, {
  firstPerson: true,                    // physique des billes activée
  timeline: PAINTBALL_RIFLE_TIMELINE,
  dropParent: viewmodel.scene,          // le réservoir vide lâché pendant la recharge (copie cosmétique qui tombe)
  events: { onShot, onDryFire, onBurstStart, onBurstEnd, onHopperRelease, onHopperDrop, onHopperIn,
            onAmmoRefilled, onSlap, onChargeBack, onChargeRelease, onReloadEnd },
});
rifle.attachViewmodel(viewmodel);
await viewmodel.equip(PaintballRifleProfile, rifle.object, { playEquipClip: true });
```

## Ordre par frame

```ts
viewmodel.update(dt, input);      // input.straight = ADS, running, speed…
viewmodel.syncCamera(gameCamera);
rifle.update(dt);                 // APRÈS syncCamera : le réservoir lit la pose monde finale
projectiles.update(dt);           // billes en vol (voir « Peinture »)
// rendu du monde, puis viewmodel.render(renderer)
```

## Tir automatique

```ts
if (triggerHeld && rifle.canFire) {   // canFire : munitions, pas en pleine recharge, 0,1 s écoulée depuis la bille précédente
  rifle.fire();                         // une bille ; la 1re d'une rafale lance la boucle bras + arme
  // tes raycasts / dégâts ici, depuis la caméra (une bille par tir)
}
if (reloadPressed) rifle.reload();
if (inspectPressed) rifle.inspect();
onWeaponSwitch(() => rifle.cancelReload());
```

- **Boucle de tir.** `fire()` démarre, à la première bille, la boucle **FP_Fire** (0,1 s, un recul par cycle) et le clip arme **Fire** (gâchette tenue, levier qui cycle). Les billes suivantes ne font qu'alimenter : une bille aspirée par le trou d'alimentation, plus un petit recul.
- **Vibration au tir (v3, réduite).**
  - Le recul par bille des clips est à environ 45 % de la v2 : la bouche du canon bouge d'environ 15 mm par coup au lieu de 34.
  - La poussée de rafale et le bruit coup à coup sont réduits aussi, en FP comme en TP.
  - Le recul cosmétique du `ViewmodelSystem` passe de 0,12 à **0,05** par bille. C'est l'option `recoilPerShot` du contrôleur, à ajuster si tu veux encore moins.
- **Fin de rafale.** Dès qu'aucune bille n'est partie depuis 0,16 s (gâchette relâchée ou vide), le contrôleur joue **FP_FireEnd** (0,3 s) et le clip arme **Fire_End**.
- **Cadence.** Elle est décidée par ton gameplay. Les clips sont calés sur 0,1 s (600 coups/min). Avec une autre cadence, ça reste correct : la boucle continue simplement.
- **Couleur.** `onShot(ammoLeft, color)` donne la couleur de la bille qui vient de partir. Utilise-la pour le projectile et la tache.

### Événements de la recharge (secondes depuis le début du clip, 2,45 s)

| Événement | t | Effet |
|---|---|---|
| `hopperRelease` | 0,40 | pouce sur le bouton (clic) |
| `hopperDrop` | 0,78 | le réservoir vide quitte la main. Une copie tombe (monde, 1,1 s, disparaît en rétrécissant) ; le vrai nœud `Hopper` est masqué |
| `hopperIn` | 1,10 | le réservoir plein apparaît dans la main (hors champ en FP) |
| `hopperSeat` | 1,52 | **clic : munitions = 32** (`onAmmoRefilled`). Annuler avant ce point garde les munitions d'avant |
| `slap` | 1,64 | la main tape le réservoir |
| `chargeBack` / `chargeRelease` | 1,98 / 2,03 | levier d'armement tiré, puis relâché |
| `readyToFire` | 2,10 | on peut retirer (la fin du clip est coupée par le tir) |

## Vue 3e personne (joueurs distants)

```ts
const remote = new PaintballRifleController(gltf, {
  firstPerson: false, timeline: PAINTBALL_RIFLE_TIMELINE,
  dropParent: worldScene, groundY: (x, z) => terrainHeight(x, z),   // le réservoir lâché rebondit au sol
  events: {
    onBurstStart: () => character.playAction(PaintballRifleProfile.tpClips.actions.fire),     // boucle
    onBurstEnd: () => character.playAction(PaintballRifleProfile.tpClips.actions.fireEnd),
  },
});
const mount = createWeaponMount("PaintballRifleTPMount", PaintballRifleProfile.tpMount);
character.getObjectByName("Weapon_R")!.add(mount);
mount.add(remote.object);
// à chaque bille annoncée par le serveur : remote.playRemote("fire") ; recharge : remote.playRemote("reload")
// + le clip TP reload sur le perso LA MÊME FRAME ; remote.update(dt) chaque frame
```

- **Posture TP : toujours en visée.** Dans tous les clips (hold, visée, course, tir), l'arme pointe droit devant, à l'horizontale, sans roulis.
- **Buste.** Il est de trois-quarts (`Spine_1` : −14° de lacet, 8,5° d'inclinaison) pour que le bras gauche, court, atteigne la poignée avant. La main gauche tient cette poignée sur `OffhandSocketTP`.
- **Recharge en TP.** Le clip arme **Reload_TP** suit la main TP. Le réservoir vide est lâché sur le côté gauche, le plein vient de la ceinture. Pendant qu'il est porté, le réservoir est collé à la main **réellement résolue** (et pas à la cible IK), donc la main ne flotte jamais à côté.
- **Réservoir sans physique.** 33 dispositions précalculées (une par nombre de billes), plus l'animation d'aspiration.

## Tir hitscan, billes visibles et peinture

**Le tir est du hitscan** : le raycast part de la caméra au moment du tir et les dégâts sont appliqués tout de suite (12 au corps, ×1,5 à la tête = 18, sans atténuation, portée 45 m). La bille qu'on voit voler et la peinture sont **purement visuelles** et identiques pour tous les joueurs (même seed).

```ts
import { PaintSplats, hitBarycentric } from "../weapons/paintball/PaintSplats";
import { PaintballProjectiles } from "../weapons/paintball/PaintballProjectiles";

const splats = new PaintSplats(worldScene);                       // UNE instance pour toute la partie (4096 taches persistantes)
const projectiles = new PaintballProjectiles(gltf.scene.getObjectByName("Ball_Template") as THREE.Mesh, worldScene, splats);

// pour CHAQUE bille (la tienne en FP, celles des autres en TP), avec le résultat du raycast du tir :
// FP : viewmodel.socketWorldForGameCamera(rifle.muzzle, gameCamera, from)   TP : remote.muzzle.getWorldPosition(from)
if (!hit) projectiles.spawn(from, maxRangePoint, color, null);
else if ((hit.object as THREE.SkinnedMesh).isSkinnedMesh)                 // un joueur : peinture sur sa peau
  projectiles.spawn(from, hit.point, color, { mesh: hit.object as THREE.SkinnedMesh, faceIndex: hit.faceIndex!,
                                               bary: hitBarycentric(hit.object as THREE.Mesh, hit.faceIndex!, hit.point, new THREE.Vector3()) });
else                                                                      // le décor : une tache persistante
  projectiles.spawn(from, hit.point, color, { normal: hit.face!.normal.clone().transformDirection(hit.object.matrixWorld), seed });
```

- **Billes en vol** (`PaintballProjectiles`) :
  - un seul `InstancedMesh` pour tous les joueurs (256 billes), qui réutilise `Ball_Template`, donc 1 draw call ;
  - bille de 3,2 cm, étirée dans le sens du vol, vitesse moyenne 45 m/s ;
  - **départ lent puis accélération** (`easeIn` 1,8, même temps d'arrivée). À vitesse constante, une bille vue par le tireur parcourt 70 % de son trajet à l'écran dès le premier mètre et semble apparaître directement au réticule. Avec ce départ lent, on voit **chaque bille sortir du canon**, en FP comme en TP ;
  - options : `{ max, speed, radius, stretch, easeIn }`.
- **Décor : taches persistantes et optimisées** (`PaintSplats`) :
  - un seul `InstancedMesh` de quads à forme procédurale, sans texture, sans `DecalGeometry` et sans allocation par tache ; **1 draw call** pour toute la partie ;
  - les taches **restent** jusqu'à `clearSurfaces()` (nouvelle manche ou changement de carte). Au-delà de `maxSurface` (4096), la plus ancienne est réutilisée ;
  - **fusion** : une tache qui tombe à moins de 0,35 × sa taille d'une autre, sur le même mur, la réutilise (nouvelle couleur par-dessus, légère croissance jusqu'à ×1,5) au lieu d'empiler un quad. Test : une soixantaine de billes tirées au même endroit du mur donnent 8 instances. Le nombre de taches et l'overdraw restent bas même sous un tir soutenu ;
  - chaque tache n'envoie au GPU **que sa propre instance** (`addUpdateRange`), jamais les buffers entiers ;
  - avec la **seed** du tir, forme, rotation et taille sont les mêmes sur tous les clients ;
  - **décor statique seulement.** Sur un objet qui bouge (porte, plateforme), pas de tache, ou alors un autre système.
- **Joueurs** : la peinture est stockée **par sommet** (attribut `paint`, soit 3 754 sommets pour le corps du Potato), sur une géométrie propre au joueur qui **partage** tous les autres attributs. Elle est donc skinnée avec le mesh et suit l'animation sans coût.
  - Le matériau cloné mélange la peinture avec un bord bruité, pour un rendu éclaboussé.
  - Le point touché est converti en espace de bind (face + barycentriques), puis étalé sur le voisinage soudé (coutures UV comprises), sur environ 7,5 cm de rayon.
  - **À la mort : `splats.clearPaintUnder(characterRoot)`**, sur tous les clients : le joueur perd toute sa peinture. À la déconnexion : `detach(mesh)`.
- **Raycast des personnages.** Il faut que `raycaster.intersectObject(skinnedMesh)` fonctionne sur les persos (three r169 prend en compte le skinning). Appelle `skinnedMesh.computeBoundingSphere()` après le chargement si le mesh se déplace loin de son origine.

## Physique du réservoir (optimisée)

- **Solveur.** 32 billes, Verlet par positions dans l'espace local du nœud `Hopper` : cylindre horizontal avec un fond en V vers le trou d'alimentation (l'agitateur des vrais réservoirs). Contacts bille/bille avec tri-balayage sur X, 8 itérations.
- **Coût.** Pas fixe de 60 Hz, 3 sous-pas max, **mise en veille** quand plus rien ne bouge : aucun calcul ni upload GPU au repos. Environ 0,05 ms par pas.
- **Forces.** Gravité réelle, plus l'inertie de l'arme (course, pas chassés, saut, recul, et le balancement du réservoir pendant la recharge).
- **Tir.** Chaque tir aspire la bille la plus proche du trou ; les autres roulent pour combler.
- **Rendu.** 1 `InstancedMesh` avec une couleur par instance. L'arme complète fait 5 draw calls de meshes + 1 instancié.
- **Réglages.** `rifle.hopper.inertiaScale` (0,5), `rifle.hopper.maxInertiaG` (2,5), `rifle.hopper.sim.friction` (0,35).

## Modèle

- **Modélisation.** Faite **dans Blender** (via le MCP) d'après l'image de référence, par un script procédural (`_authoring/blender/pb_model.py`) : coques convexes + chanfreins bmesh, couleurs de sommets, 2 matériaux (+ 1 pour les billes). Environ 3 650 triangles, plus 80 par bille.
- **Crosse (v3).** La jambe diagonale de la crosse flottait juste derrière le collier teal, sans le toucher. Elle part maintenant d'un **bloc charnière** gris foncé fixé au collier et à la barre du dessus : toute la crosse est collée au reste.
- **Pastilles orange (v4).** Retirées sur la carcasse (avant et bas arrière), sur le support de la poignée avant et sur le collier / la charnière de la crosse. Restent en orange : la bague du canon, les panneaux latéraux, le bouton du levier d'armement, le téton sous la poignée pistolet et l'embout avant du réservoir.
- **Échelle.** L'arme est **1,4 fois plus grande** que le Popcorn Shotgun (7,4 unités, proche des 7,8 du HexSniper). Les mains du Potato sont énormes : à l'échelle du Popcorn, elles ne pouvaient pas tenir la poignée verticale.
- **Poignées.**
  - La poignée pistolet est au même point que celle du Popcorn Shotgun : même montage FP/TP et même main droite.
  - La **poignée avant verticale** a été épaissie.
  - **Prise FP v2** (`fore_fit4.py`) : le poing est fermé **autour** de la poignée, et plus à côté. Les doigts sont visibles dessus depuis la caméra. La main du Potato est trop grosse pour une prise exacte : la poignée passe dans le poing, ce qui ne se voit pas. Les pièces visibles au-dessus (support, canon, carcasse) ne sont jamais touchées. Le bras garde la même direction et la même torsion (≈ 13° à l'avant-bras).
  - La prise v1 (`fore_fit2.py`, poing sur le côté) reste utilisée en TP et pour les prises du réservoir et du levier pendant la recharge.
- **Nœuds.**
  - `Body`, `Trigger` (pivot +Z), `ChargingHandle` (glisse vers +X, sockets `ChargeSocket` / `ChargeSocketTP`).
  - `Hopper` : `HopperFrame`, `HopperGlass`, `Ball_Fill` (aperçu `EXT_mesh_gpu_instancing`), `Ball_Template` (bille de rayon 1), `BallFeed`, `HopperGrabSocket` / `HopperGrabSocketTP`. Ses extras contiennent les dispositions et la palette.
  - `OffhandSocket` / `OffhandSocketTP`, `Muzzle`, `GripSocket`.
- **Clips de l'arme.** `Idle`, `Fire` (boucle 0,1 s), `Fire_End`, `Reload` (FP), `Reload_TP`, `Inspect`, `Equip`. Chacun anime la gâchette, le levier et le réservoir (translation, rotation, échelle 0 pendant l'échange) : aucun canal ne reste bloqué d'un clip à l'autre.

## Scène Blender

`Documents\PopcornShotgun_Blender\PaintballRifle\PaintballRifle.blend` contient trois scènes :

- **Model** : le modèle procédural, reconstructible avec `pb_model.build()`.
- **FP** : les bras + l'arme montée comme en jeu, la caméra `Cam_FP` (65°) et les 11 clips sur une timeline à 60 i/s, un marqueur par clip.
- **TP** : le perso corrigé + l'arme sur `Weapon_R` + les 8 clips (même convention : 60 i/s, un marqueur par clip ; recharge à la frame 500).

## Régénérer

Le dossier `_authoring/` contient le pipeline (Python : numpy, scipy, Pillow ; tsx pour `bake_hopper.ts`) :

1. modèle Blender (`blender/pb_model.py`) → `pb_dump.json` ;
2. `hopper_sim.py` puis `tsx ts/bake_hopper.ts` : dispositions du réservoir ;
3. `fore_fit2.py` (v1 : TP + recharge) puis `fore_fit4.py` (v2 : prise FP) ;
4. `author_fp.py` : clips FP ;
5. `tp_key_search.py` puis `author_tp.py` : posture et clips TP ; `tp_hopper_follow.py` recolle le réservoir porté sur la main TP, `merge_tp.py` fusionne les bakes ;
6. `export_weapon.py`, `export_poses.py fp|tp`, `make_profile.py` : GLB et profil ;
7. `to_blender.py` + `blender/pb_anim.py` : scènes Blender.
