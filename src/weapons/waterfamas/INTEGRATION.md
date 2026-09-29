# Water FAMAS — intégration

FAMAS à eau cartoon, **à une main**, qui tire en **rafales de 3 jets d'eau** (comme un FAMAS en mode rafale). Le réservoir transparent posé sur l'arme contient **9 jets = 3 rafales**, et l'eau qu'on voit dedans est **vivante** : son niveau baisse à chaque jet, remonte pendant la recharge, reste à plat quand on penche l'arme et **clapote** quand on court, tourne, tire ou pendant l'inspection.

- **Tir : hitscan.** Chaque jet = un raycast instantané depuis la caméra, au moment où le jet part (0 / 0,075 / 0,15 s après l'appui). Le jet d'eau qu'on voit voler est visuel.
- **Impacts : « mouillé qui sèche ».** Éclaboussure à l'impact, trace mouillée (avec coulures sur les murs) qui sèche en ~6 s ; un joueur touché devient mouillé et brillant pendant ~10 s.
- **Bras gauche FP au repos : le long du corps**, comme en TP (épaule à côté de l'œil, bras qui pend, entièrement hors champ). Il ne remonte dans l'écran que pendant la recharge.
- **Recharge : remplissage au bouchon.** La main gauche dévisse le bouchon arrière (un demi-tour en 2 quarts de tour : la main droite fait rouler l'arme en sens inverse, comme pour un bocal), l'écarte sur sa charnière, verse une bouteille d'eau dans le réservoir, referme et revisse. Bras FP résolus sous limites naturelles (poignet ≤ 12° de torsion, avant-bras ≤ 25°).
- **Branchement :** comme le HexSniper, le Popcorn Shotgun et le Paintball Rifle, le paquet se branche sur le `ViewmodelSystem` existant **sans le modifier**.

## Fichiers

| Fichier | À placer dans | Rôle |
|---|---|---|
| `assets/potato/WaterFamas_Weapon.glb` | `src/assets/potato/` | Arme : root 0.19, avant = −X. Gâchette, bouchon, charnière et bouteille animés, sockets, données du réservoir (extras du nœud `Tank`). ~4 900 triangles. |
| `assets/potato/WaterFamas_FP_Poses.glb` | `src/assets/potato/` | 11 clips FP sur `Potato_FP_CommonArms`, animations seules, mêmes 20 canaux que le HexSniper. |
| `assets/potato/WaterFamas_TP_Poses.glb` | `src/assets/potato/` | 7 clips TP sur `Potato_TP_Character`, animations seules. |
| `assets/potato/WeaponProfile_WaterFamas.json` | `src/assets/potato/` | Matrices de montage FP/TP, clips, timelines d'événements, données du réservoir. |
| `profiles/WaterFamasProfile.ts` | à côté de `HexSniperProfile.ts` | `WeaponViewProfile`, `WATER_FAMAS_TP_AIM_CLIPS`, `WATER_FAMAS_TIMELINE`. |
| `weapons/waterfamas/WaterFamasController.ts` | ex. `src/game/weapons/waterfamas/` | Contrôleur de présentation (rafales, recharge, inspection, niveau d'eau). |
| `weapons/waterfamas/WaterTank.ts` | même dossier | L'eau du réservoir : surface libre, niveau, clapotis, filet de versement. |
| `weapons/waterfamas/WaterJets.ts` | même dossier | 3 jets d'eau séparés par rafale (paquets d'eau) + gouttes + éclaboussures, purement visuels (2 draw calls pour tous les joueurs). |
| `weapons/waterfamas/WetMarks.ts` | même dossier | Traces mouillées qui sèchent (décor, 1 draw call) et joueurs mouillés (par sommet). |
| `weapons/waterfamas/WaterFamasGameplay.ts` | même dossier | **Référence gameplay** : 9 jets, rafale, dispersion, dégâts (proposition), seed. |

- **Perso TP.** Le paquet ne contient **pas** de `Potato_TP_Character.glb` : garde celui livré avec le Popcorn Shotgun (flancs et aisselles corrigés).
- **Imports.** Les imports d'assets de `WaterFamasProfile.ts` suivent les chemins de `HexSniperProfile.ts` (`../../assets/potato/...?url`).
- **Dépendances.** Les modules de `weapons/waterfamas/` n'importent que `three` et leurs voisins. Vérifiés avec `tsc --strict --noUnusedLocals --noUnusedParameters --erasableSyntaxOnly`.

## Équiper (vue FP, joueur local)

```ts
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { WaterFamasProfile, WATER_FAMAS_TIMELINE } from "../profiles/WaterFamasProfile";
import { WaterFamasController } from "../weapons/waterfamas/WaterFamasController";

const gltf = await new GLTFLoader().loadAsync(WaterFamasProfile.weaponUrl);   // à mettre en cache (FP + TP)
const famas = new WaterFamasController(gltf, {
  firstPerson: true,
  timeline: WATER_FAMAS_TIMELINE,
  events: { onBurstStart, onJet, onBurstEnd, onDryFire, onCapGrab, onCapOff, onHingeOpen, onBottleIn,
            onPourStart, onAmmoRefilled, onBottleOut, onHingeClose, onCapScrewed, onReloadEnd },
  // recoilPerJet: 0.035,       // secousse cosmétique du viewmodel par jet
  // tank: { sloshHz: 1.6, sloshDamping: 0.12, color: 0x3f9fe6 },
});
famas.attachViewmodel(viewmodel);
await viewmodel.equip(WaterFamasProfile, famas.object, { playEquipClip: true });
```

## Ordre par frame

```ts
viewmodel.update(dt, input);      // input.straight = ADS…
viewmodel.syncCamera(gameCamera);
famas.update(dt);                 // APRÈS syncCamera : l'eau lit la pose monde finale de l'arme (clapotis)
jets.update(dt);                  // jets en vol + éclaboussures
wetMarks.update(dt);              // horloge de séchage
// rendu du monde, puis viewmodel.render(renderer)
```

## Rafale

```ts
if (triggerPressed && famas.canFire) famas.fire(isAiming);   // UNE rafale par appui (pas de tir auto en maintenant)
// → onJet(k, ammoLeft) × 3 : k = 0 tout de suite (dans fire()), puis 1 et 2 depuis update() à 0,075 / 0,15 s
if (reloadPressed) famas.reload();
if (inspectPressed) famas.inspect();
onWeaponSwitch(() => famas.cancelReload());
```

- `fire(aiming)` joue l'action `fire` (ou `fireAim` en visée) et le clip arme `Fire` la même frame.
- **Le raycast de chaque jet se fait dans `onJet`** : c'est l'instant où le jet part. Une rafale tirée en bougeant la visée peut donc toucher 3 points différents.
- La rafale suivante est possible 0,45 s après (`actions.fire.burstInterval`). Le clip de rafale dure 0,42 s.
- Chaque jet enlève 1 munition et fait baisser l'eau du réservoir.

### Événements de la recharge (secondes depuis le début du clip, 3,3 s)

| Événement | t | Effet |
|---|---|---|
| `capGrab` | 0,32 | la main gauche saisit le bouchon (2 quarts de tour partagés entre les mains, lâche et reprend entre les deux) |
| `capOff` | 0,66 | bouchon dévissé (un demi-tour) |
| `hingeOpen` | 0,70 | le bouchon est écarté sur sa charnière (ouvert à 0,88) |
| `bottleIn` | 1,10 | bouteille en main (hors champ en FP, prise à la ceinture en TP) |
| `pourStart` | 1,44 | l'eau coule : filet bouteille → trou de remplissage, le niveau monte |
| `pourEnd` | 1,98 | **munitions = 9** (une annulation après ce point garde le plein) |
| `bottleOut` | 2,30 | la bouteille disparaît |
| `hingeClose` | 2,62 | bouchon refermé sur le trou (clic) |
| `capScrewed` | 2,86 | revissé (2 quarts de tour) |
| `readyToFire` | 2,95 | on peut tirer (la fin du clip est interrompue proprement) |

## Vue TP (joueurs distants)

```ts
const remote = new WaterFamasController(gltf, { firstPerson: false, timeline: WATER_FAMAS_TIMELINE,
  events: { onJet: () => spawnRemoteJet(remote) } });
const mount = createWeaponMount("WaterFamasTPMount", WaterFamasProfile.tpMount);
character.getObjectByName("Weapon_R")!.add(mount);
mount.add(remote.object);
// rafale reçue du serveur : remote.playRemote("fire", aiming) + action TP "fire" (TP_Fire_WaterFamas, one-shot) sur le perso
// recharge reçue :          remote.playRemote("reload")        + action TP "reload" sur le perso, la même frame
```

Le contrôleur choisit tout seul le clip arme `Reload_TP` (la bouteille est un peu agrandie en TP pour garder sa taille réelle dans la main).

## Visuels

- **Jets :** `new WaterJets(worldScene, wetMarks)` une fois pour la partie. Pour chaque jet (local ou distant) : `jets.spawn(from, to, hit, 1, { source })`.
  - **3 tirs séparés par rafale**, comme les 3 cartouches d'un FAMAS : chaque jet est un paquet d'eau allongé (0,04 s d'eau, ~1 m) suivi d'un espace vide (~1 m) avant le suivant. Pas de spray, pas de jet continu.
  - `source` = une closure stable par arme qui renvoie la position du canon maintenant (relue tant que l'eau sort). FP : `() => viewmodel.socketWorldForGameCamera(famas.muzzle, gameCamera, tmp)` ; TP : `() => remote.muzzle.getWorldPosition(tmp)`.
  - `hit` = `{ normal, seed }` (décor), `{ mesh, faceIndex, bary }` (joueur, `waterHitBarycentric`), ou `null` (raté).
  - Paquet d'eau calculé dans le vertex shader : sortie du canon à ~10 m/s puis 30 m/s, grossit avec la distance, renflements qui voyagent avec l'eau, tête arrondie, queue effilée ; ombrage d'eau (cœur transparent, bord bleu, reflets et bulles qui scintillent). Gouttelettes à la bouche, gouttes qui se détachent, éclaboussure à l'impact.
- **Traces mouillées :** `new WetMarks(worldScene)`. Décor : trace sombre et brillante (coulures vers le bas sur les murs), sèche en 2,5 + 3,5 s, fusionne si un jet retombe au même endroit. Joueurs : `wetMarks.attach(mesh)` au spawn (ou au 1er impact), mouillé/brillant 4 s puis sèche en 6 s ; `wetMarks.dryUnder(characterRoot)` à la mort / au respawn.
- **Compatibilité peinture :** si le Paintball Rifle est intégré, `attach` d'abord `PaintSplats` puis `WetMarks` sur le même mesh (le patch mouillé enchaîne le patch peinture).
- **Coût :** jets 2 draw calls, traces 1 draw call (masquées quand tout est sec), eau du réservoir 2 draw calls + le filet pendant le versement.

## Réservoir (déjà fait, rien à coder)

- Données dans les extras du nœud `Tank` (`capacity` 9, `jetsPerShot` 3, rayon et longueur du cylindre d'eau, `emptyLevel` 0,06).
- Le contrôleur remplace le matériau du nœud `Water` par le shader d'eau (`WaterTank`). Le verre (`TankGlass`) est dessiné après (`renderOrder = 3`).
- Niveau = `emptyLevel + (1 − emptyLevel) × ammo / 9`, lissé ; pendant le versement il suit `pourStart → pourEnd`.
- Clapotis : ressort sous-amorti (1,6 Hz) sur la gravité apparente (g − accélération du réservoir). Réglages : option `tank` du contrôleur. `famas.tank.resetMotion()` après une téléportation.
