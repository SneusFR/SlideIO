# Lance-Frisbee — intégration

Arbalète cartoon **à deux mains** qui lance des **frisbees**. Un disque est posé sur le pont, une **cage de 5 disques** est accrochée sous l'arme : **6 frisbees** en tout.

- **Tir : vrai projectile** (pas de hitscan). La corde élastique claque, le chariot pousse le disque, le frisbee part à **34 m/s**, plane, **rebondit** sur les murs et le sol (3 rebonds max), puis se pose et disparaît.
- **Réarmement automatique** après chaque tir, comme une arbalète : la main gauche tire le chariot en arrière (les cordes se tendent, clic), prend le disque suivant **dans la cage, en dessous**, et le pose sur le pont. Tir suivant possible à 1,50 s.
- **Recharge = changer la cage** : la cage vide est tirée vers le bas et **jetée** — elle tombe (en FP elle sort de l'écran par le bas, en TP elle tombe au sol, roule, reste couchée quelques secondes puis s'enfonce). La main va chercher une cage pleine (5) à la ceinture et l'enclenche. **La cage ne disparaît jamais à l'écran.** Si le pont était vide, le réarmement suit.
- **Touche : dégâts + petit recul** (le disque rebondit sur le joueur). Proposition : 45 au corps, ×1,5 à la tête, ×0,6 après un rebond sur un mur.
- **Branchement :** comme le HexSniper, le Popcorn Shotgun, le Paintball Rifle et le FAMAS à eau, le paquet se branche sur le `ViewmodelSystem` existant **sans le modifier**.

## Fichiers

| Fichier | À placer dans | Rôle |
|---|---|---|
| `assets/potato/FrisbeeLauncher_Weapon.glb` | `src/assets/potato/` | Arme : root 0.19, avant = −X. Gâchette, chariot, branches, cordes élastiques, disque du pont, disque en main, cage + 5 disques, sockets, clips de l'arme. ~5 600 triangles, 1 matériau (couleurs de sommets). |
| `assets/potato/FrisbeeLauncher_FP_Poses.glb` | `src/assets/potato/` | 14 clips FP sur `Potato_FP_CommonArms`, animations seules. |
| `assets/potato/FrisbeeLauncher_TP_Poses.glb` | `src/assets/potato/` | 9 clips TP sur `Potato_TP_Character`, animations seules. |
| `assets/potato/WeaponProfile_FrisbeeLauncher.json` | `src/assets/potato/` | Matrices de montage FP/TP, clips, timelines d'événements, données des disques. |
| `profiles/FrisbeeLauncherProfile.ts` | à côté de `HexSniperProfile.ts` | `WeaponViewProfile`, `FRISBEE_LAUNCHER_TP_AIM_CLIPS`, `FRISBEE_LAUNCHER_TIMELINE`. |
| `weapons/frisbee/FrisbeeLauncherController.ts` | ex. `src/game/weapons/frisbee/` | Contrôleur de présentation : tir + réarmement, cage, recharge, inspection, disques visibles dans la cage. |
| `weapons/frisbee/FrisbeeProjectiles.ts` | même dossier | **Simulation déterministe** des frisbees (`FrisbeeSim`, sans rendu, utilisable sur le serveur) + visuels (disque qui tourne, traînée, anneaux d'impact). |
| `weapons/frisbee/FrisbeeLauncherGameplay.ts` | même dossier | Référence gameplay : capacité, dispersion, seed, dégâts proposés. |
| `weapons/frisbee/DroppedCages.ts` | même dossier | Les cages vides jetées pendant la recharge : copie monde qui tombe, rebondit, se couche au sol puis s'enfonce (cosmétique, 1 instance pour la partie). |

- **Perso TP.** Le paquet ne contient **pas** `Potato_TP_Character.glb` : garde celui livré avec le Popcorn Shotgun (v5, flancs et aisselles corrigés).
- **Dépendances.** Les modules de `weapons/frisbee/` n'importent que `three` et leurs voisins. Vérifiés avec `tsc --strict --noUnusedLocals --noUnusedParameters --erasableSyntaxOnly`.

## Équiper (vue FP, joueur local)

```ts
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { FrisbeeLauncherProfile, FRISBEE_LAUNCHER_TIMELINE } from "../profiles/FrisbeeLauncherProfile";
import { FrisbeeLauncherController } from "../weapons/frisbee/FrisbeeLauncherController";

const gltf = await new GLTFLoader().loadAsync(FrisbeeLauncherProfile.weaponUrl);   // à mettre en cache (FP + TP)
const launcher = new FrisbeeLauncherController(gltf, {
  firstPerson: true,
  timeline: FRISBEE_LAUNCHER_TIMELINE,
  events: { onShot, onDryFire, onCocked, onDiscTaken, onDiscSeated, onCageOut, onCageDrop, onCageIn, onReloadEnd },
  // recoil: 0.06,           // secousse cosmétique du viewmodel au tir
  // startCage: 5,           // disques dans la cage au spawn
});
launcher.attachViewmodel(viewmodel);
await viewmodel.equip(FrisbeeLauncherProfile, launcher.object, { playEquipClip: true });
```

## Ordre par frame

```ts
viewmodel.update(dt, input);      // input.straight = ADS…
viewmodel.syncCamera(gameCamera);
launcher.update(dt);              // événements du réarmement / de la recharge, disques de la cage
frisbees.update(dt);              // tous les frisbees en vol (pas fixe 1/120 s en interne)
droppedCages.update(dt);          // les cages vides jetées (toutes les armes)
// rendu du monde, puis viewmodel.render(renderer)
```

## Tir

```ts
if (triggerPressedThisFrame) launcher.fire(isAiming);   // un disque par appui
if (reloadPressed) launcher.reload();
if (inspectPressed) launcher.inspect();
onWeaponSwitch(() => launcher.cancelAction());   // interrompt la recharge / termine le réarmement
```

- `fire(aiming)` lance le disque **tout de suite** : `onShot(aiming)` est appelé pendant l'appel. C'est là qu'on crée le projectile (voir plus bas) et qu'on envoie le tir au serveur.
- Si la cage contient encore un disque, l'action `fire` (`fireAim` en visée) enchaîne le **réarmement** (1,58 s). Sinon `fireLast` (0,5 s) : l'arme reste vide, il faut recharger.
- `canFire` = un disque sur le pont et (au repos ou après `readyToFire`). Sans disque : `onDryFire`.
- `ammo` = (disque sur le pont ? 1 : 0) + `cageCount`, `capacity` = 6.

### Événements (secondes depuis le début de l'action)

| Action | Durée | Événements |
|---|---|---|
| `fire` | 1,58 | `shot` 0 · `cocked` 0,70 · `discTaken` 0,95 · `discSeated` 1,29 · `readyToFire` 1,50 |
| `fireLast` | 0,50 | `shot` 0 · `readyToReload` 0,25 |
| `reload` (pont chargé) | 1,40 | `cageOut` 0,40 · `cageDrop` 0,45 · `cageSwap` 0,71 · `cageIn` 1,10 · `readyToFire` 1,30 |
| `reloadEmpty` (pont vide) | 2,48 | `cageOut` 0,40 · `cageDrop` 0,45 · `cageSwap` 0,71 · `cageIn` 1,10 · `cocked` 1,60 · `discTaken` 1,85 · `discSeated` 2,19 · `readyToFire` 2,40 |

- `discTaken` : la cage perd un disque (les disques restants remontent d'un cran, 0,22 s). `discSeated` : le pont est chargé.
- `cageSwap` : cage pleine (5). `cancelAction()` (changement d'arme, mort) : une recharge annulée avant `cageIn` rend la cage d'avant ; après `cageIn` la nouvelle cage reste (un disque déjà pris pour le réarmement y retourne, le pont reste vide et la recharge suivante réarme) ; un réarmement interrompu est terminé tout de suite (le disque finit sur le pont).
- `cageDrop` : la main lâche la cage vide → `onCageDrop({ world, velocity, discs })` (voir « Cages jetées »). La nouvelle cage apparaît à 0,78 s **hors écran** en FP (dans la main, sous la vue ; tout le bras gauche est sous le bord bas de 0,53 à 0,87 s) et à 0,82 s **à la ceinture** en TP (elle sort de la poche en 0,06 s).
- Les rappels d'une action remplacée sont ignorés (jeton par action) ; si le `ViewmodelSystem` refuse une action, le contrôleur la termine avec sa propre horloge.

## Frisbees en vol

```ts
import { FrisbeeProjectiles } from "../weapons/frisbee/FrisbeeProjectiles";
import { discDirection } from "../weapons/frisbee/FrisbeeLauncherGameplay";

const frisbees = new FrisbeeProjectiles(worldScene, launcher.discTemplate, sweptSphereCast, {
  onHit: (e) => { /* serveur : dégâts e.damage, impulsion e.impulse (m/s) sur e.target */ },
  onBounce: (id, point, normal, speed) => { /* son « tok » */ },
});

// dans onShot (local) :
const dir = discDirection(camForward, camUp, aiming, seed, new THREE.Vector3());
const from = viewmodel.socketWorldForGameCamera(launcher.launchSocket, gameCamera, new THREE.Vector3());
frisbees.fire({ origin: gameCamera.position.clone(), direction: dir, owner: localPlayer, visualFrom: from, roll: -0.1, seed });
```

- **La simulation part de l'œil** (comme le serveur) ; le disque qu'on voit part **du lance-frisbee** et rejoint la trajectoire simulée en ~0,1 s.
- `sweptSphereCast(from, dir, maxDist, radius, ignore)` : c'est **la collision du jeu** (sphère de 0,12 m qui avance), qui renvoie `{ distance, point, normal, target?, headshot? }`. `target` = un joueur (dégâts), rien = décor (rebond). Ne jamais renvoyer `ignore` (le tireur).
- Vol : lift (le disque plane tant qu'il est rapide), léger freinage, rebond (0,55 sur la normale, 0,8 sur la tangente), il perd son lift après le premier rebond, se pose puis s'efface.
- Visuel : disque qui tourne et penche, traînée additive courte (apparaît après 0,03 s), anneau à chaque impact. `max` 24 disques en vol pour toute la partie.

## Cages jetées (recharge)

```ts
import { DroppedCages } from "../weapons/frisbee/DroppedCages";

// une instance pour la partie (les cages de tous les joueurs), avec la hauteur du sol du jeu
const droppedCages = new DroppedCages(worldScene, launcher.cageTemplate, {
  ground: (x, z) => groundHeightAt(x, z),       // raycast vers le bas (par défaut : y = 0)
  // life: 6, max: 12,
});

// TP (joueurs distants) : dans les events du contrôleur distant
onCageDrop: (d) => { if (d.world) droppedCages.spawn(d.world, d.velocity, d.discs); }

// FP (joueur local) : la cage sort déjà de l'écran dans le clip ; une copie tombe sous la vue pour la retrouver au sol
onCageDrop: (d) => droppedCages.spawnAt(feetLeftPosition, cameraYawQuat, new THREE.Vector3(0, -1, 0), d.discs)
```

- **TP :** à `cageDrop`, le contrôleur donne la **matrice monde** du nœud `Cage` (échelle TP incluse) et sa **vitesse** ; le nœud est masqué la frame suivante et la copie monde continue le geste (gravité, petit rebond, elle se couche sur le côté). Aucun saut : même pose, même vitesse. Le contrôleur distant doit être mis à jour **après** l'animation du perso et son `updateMatrixWorld` (il lit la position de la cage).
- **FP :** le clip fait tomber la cage hors de l'écran par le bas (elle n'est masquée qu'une fois entièrement sortie, à 0,70 s) ; le bras gauche **glisse vers le bas hors de la vue** (il garde son orientation : aucune manche ne traverse l'écran), la nouvelle cage apparaît dans sa main hors écran à 0,78 s et remonte avec lui par le bas. `spawnAt` pose une copie à la bonne échelle (TP) près des pieds, à gauche : si le joueur regarde par terre, elle y est.
- La copie garde les disques qui restaient dans la cage (`discs`). Elle reste 6 s au sol puis s'enfonce en 1,2 s. Cosmétique : rien à synchroniser.
- Coût : 1 draw call par cage au sol (+ ses disques), 12 max.

## Vue TP (joueurs distants)

```ts
const remote = new FrisbeeLauncherController(gltf, { firstPerson: false, timeline: FRISBEE_LAUNCHER_TIMELINE,
  events: { onShot: () => spawnRemoteDisc(remote),
            onCageDrop: (d) => { if (d.world) droppedCages.spawn(d.world, d.velocity, d.discs); } } });
const mount = createWeaponMount("FrisbeeLauncherTPMount", FrisbeeLauncherProfile.tpMount);
character.getObjectByName("Weapon_R")!.add(mount);
mount.add(remote.object);
// tir reçu :      remote.playRemote("fire", { aiming, cage })           + action TP fire / fireLast sur le perso
// recharge reçue: remote.playRemote("reload", { cage, deckLoaded })     + action TP reload / reloadEmpty
```

`cage` / `deckLoaded` = les munitions du tireur au moment de l'action (dans le message du serveur) : le miroir choisit le même clip que le tireur. Le contrôleur prend tout seul les clips arme `Reload_TP` / `ReloadEmpty_TP`.

## Données du modèle

- Racine `FrisbeeLauncher` à l'échelle 0,19 (à garder), avant = −X, haut = +Y. Matrices de montage (FP ×0,40, TP ×0,35) : une seule fois.
- Nœuds animés : `Trigger`, `Sled` (le chariot, sockets `SledHandle` / `SledGrabSocket`), `LimbL/LimbR` (+ `LimbTipL/R`), `CordL/CordR` (cordes : mesh unité le long de +X, échelle X = longueur), `DiscDeck`, `DiscHand`, `Cage` (+ `CageDisc0..4`, visibles selon `cageCount`, pilotés par le contrôleur).
- Sockets : `LaunchSocket` (départ visuel du disque), `GripSocket`, `ForegripSocket`.
- Clips arme : `Idle`, `IdleEmpty`, `Fire`, `FireLast`, `Reload`, `ReloadEmpty`, `Reload_TP`, `ReloadEmpty_TP`, `Inspect`, `InspectEmpty`, `Equip`, `EquipEmpty`.
- `Cage` : échelle interpolée (LINEAR) — masquée hors écran (FP) ou à la reprise par la copie monde (TP), la nouvelle cage grandit de 0,3 à 1 en 0,06 s en sortant de la poche. Le bloc `droppedCage` du profil donne ces instants.
- Coût : 1 draw call par pièce (9 + 5 disques de cage) par arme, + 2 par frisbee en vol (disque + traînée).
