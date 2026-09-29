# Prompt pour Cline : intégrer le FAMAS à eau

## 0. Contexte et mission

Tu travailles sur mon jeu three.js (r169, TypeScript, Vite), avec des personnages « Potato ». Des armes sont déjà intégrées et servent de référence :

- le **HexSniper** : `HexSniperProfile.ts`, `WeaponProfile_HexSniper.json`, `ViewmodelSystem`, `FPArmsRig`, `WeaponProfile.ts` ;
- le **Popcorn Shotgun** : `PopcornShotgunController`, son profil, son branchement réseau, ses sons, son HUD… ;
- le **Paintball Rifle** (s'il est déjà intégré) : même famille de pack que celui-ci, **hitscan + visuels séparés** (projectiles visibles, taches).

**Ta mission :** intégrer une nouvelle arme, le **FAMAS à eau** (`WaterFamas`), **en t'inspirant du Popcorn Shotgun** pour tout le branchement, et **du Paintball Rifle** pour le hitscan et les visuels d'impact.

- **Avant d'écrire du code, relis comment le Popcorn Shotgun est intégré :**
  - où son profil est enregistré, comment il entre dans l'inventaire / la sélection d'arme ;
  - comment les entrées (tir, recharge, inspection) arrivent au contrôleur ;
  - quels messages réseau il envoie et reçoit ;
  - comment l'arme est accrochée au perso TP et comment le perso joue ses clips ;
  - où sont joués ses sons et où est mis à jour le HUD des munitions ;
  - comment les dégâts sont appliqués et comment la tête est détectée.
- **Reproduis le même schéma pour le FAMAS à eau.** Mêmes dossiers, mêmes conventions de nommage, mêmes points d'entrée. Si le Paintball Rifle est intégré, réutilise son chemin hitscan (raycast serveur, seed, résultat renvoyé à tous).
- **Les différences sont listées au §1.3.** Ne réinvente rien de ce qui existe déjà.

### Règles

- **Pas de modification** de `ViewmodelSystem.ts`, `FPArmsRig.ts` ni `WeaponProfile.ts`.
- **Pas de réexport des GLB** (Blender, gltf-transform, optimiseurs…). Ne change ni leur échelle ni les noms de nœuds : les extras du réservoir, les 20 canaux FP, les sockets et le nœud `Water` en dépendent.
- **Aucune nouvelle dépendance :** seulement `three`.
- **`tsc` doit passer.** Les modules du pack ont été vérifiés en `strict`, `noUnusedLocals`, `noUnusedParameters` et `erasableSyntaxOnly`.

---

## 1. L'arme

### 1.1 En une phrase

Un **FAMAS à eau** cartoon (rouge, crème et bleu), **tenu à une main**, qui tire en **rafales de 3 jets d'eau** comme un FAMAS en mode rafale. Il a un **réservoir d'eau transparent** sur le dessus, où l'eau bouge vraiment. Les jets **mouillent** ce qu'ils touchent : les murs gardent une trace qui **sèche en quelques secondes**, et les joueurs touchés deviennent **mouillés et brillants** pendant un moment.

### 1.2 Fiche technique

| | |
|---|---|
| Type | pistolet à eau **à une main**, **tir hitscan** |
| Tir | **rafale de 3 jets par appui** : jets à 0 / 0,075 / 0,15 s. Une seule rafale par appui (pas de tir auto en maintenant). Rafale suivante possible 0,45 s après. |
| Munitions | **9 jets = 3 rafales**, visibles dans le réservoir (l'eau baisse à chaque jet) |
| **Dégâts** | **proposition : 16 par jet au corps, ×1,5 à la tête (24)**, pas d'atténuation. Voir §7 : **à valider avec moi**, c'est une valeur par défaut. |
| Portée | 28 m (c'est de l'eau) |
| Dispersion | par jet dans la rafale : 0,35° / 0,8° / 1,25°, ×0,55 en visée |
| Recharge | **remplissage au bouchon**, 3,3 s. Munitions pleines à la fin du versement (1,98 s), tir possible à 2,95 s. |
| Inspection | à une main, 3,6 s : côté gauche, puis le réservoir vu d'en haut avec 3 petites secousses (l'eau clapote) |

Avec 100 PV (valeurs proposées) : 2 rafales au corps = 96, pas de kill ; 2 rafales dont un jet à la tête = kill. Un réservoir plein (9 jets) = un kill et un peu de reste.

### 1.3 Ce qui change par rapport au Popcorn Shotgun

| Popcorn Shotgun | FAMAS à eau |
|---|---|
| Tenu à deux mains | **À une main** : la main gauche pend le long du corps (hors champ en FP) et ne vient sur l'arme que pour la recharge |
| Un tir par appui | **Rafale de 3 jets** par appui, émis par le contrôleur (`onJet` × 3) |
| Projectiles | **Hitscan** : un raycast instantané **par jet**, au moment où le jet part. Le jet qu'on voit est **visuel**. |
| Recharge par le haut | **Remplissage au bouchon** : dévisser, écarter le bouchon, verser une bouteille, refermer, revisser |
| — | **Réservoir d'eau dynamique** (niveau, clapotis, versement) |
| — | **Impacts « mouillé qui sèche »** : éclaboussure, trace mouillée qui sèche, joueurs mouillés et brillants |

---

## 2. Fichiers : je les dépose dans `assets/`, à toi de les ranger

Je vais mettre tous les fichiers du pack dans le dossier `assets/` du projet, peut-être en vrac. **À toi de les ranger** aux bons endroits, **comme ceux du Popcorn Shotgun** (normalement `src/game/profiles/` et `src/assets/potato/`).

| Fichier | Destination | Rôle |
|---|---|---|
| `WaterFamas_Weapon.glb` | `src/assets/potato/` | l'arme |
| `WaterFamas_FP_Poses.glb` | `src/assets/potato/` | 11 clips FP (animations seules) |
| `WaterFamas_TP_Poses.glb` | `src/assets/potato/` | 7 clips TP (animations seules) |
| `WeaponProfile_WaterFamas.json` | `src/assets/potato/` | montages, clips, timelines, données du réservoir |
| `WaterFamasProfile.ts` | à côté de `HexSniperProfile.ts` | `WeaponViewProfile` + `WATER_FAMAS_TP_AIM_CLIPS` + `WATER_FAMAS_TIMELINE` |
| `WaterFamasController.ts`, `WaterTank.ts` | à côté des fichiers du Popcorn Shotgun, ex. `src/game/weapons/waterfamas/` | contrôleur de présentation, eau du réservoir |
| `WaterJets.ts`, `WetMarks.ts` | même dossier | jets visibles en vol + éclaboussures, traces mouillées + joueurs mouillés |
| `WaterFamasGameplay.ts` | même dossier | gameplay de référence : rafale, dispersion, dégâts, seed |
| `INTEGRATION.md` | `docs/` ou à côté du contrôleur | doc technique détaillée |
| `_authoring/`, `renders/`, `preview/` | **hors de `src/`** (ex. `tools/waterfamas/`), ou à ne pas committer | pipeline de génération, images de contrôle, page de test. Rien n'est chargé au runtime. |

- **Perso TP.** Le pack ne contient **pas** de `Potato_TP_Character.glb`. Il faut celui livré avec le Popcorn Shotgun (flancs et aisselles corrigés) : vérifie qu'il est bien en place.
- **Noms.** Garde les noms de fichiers exacts : le JSON les référence.
- **Imports du profil.** `WaterFamasProfile.ts` importe les assets comme `HexSniperProfile.ts` (`../../assets/potato/<fichier>?url` pour les GLB, le JSON en import direct, le type depuis `./WeaponProfile`). Si tu ranges ailleurs, corrige ces chemins relatifs.

---

## 3. Ce que contient le pack (pour comprendre l'arme)

### 3.1 Le modèle (`WaterFamas_Weapon.glb`)

- Modélisé **dans Blender** d'après mon image de référence : low-poly, **couleurs de sommets**, ~4 900 triangles. Même poignée pistolet, même gâchette et même main droite que le Paintball Rifle (mêmes montages).
- Conventions du HexSniper : racine `WaterFamas` à l'**échelle 0,19** (garde-la), avant = **−X**, haut = **+Y**. Les matrices de montage (FP ×0,40, TP ×0,35) sont dans le profil : applique-les **une seule fois**.
- 3 matériaux : `VertexColor` (opaque), `TankGlass` (verre, alpha 0,28, `renderOrder = 3` posé par le contrôleur), `Water` (remplacé au runtime par le shader d'eau).

| Nœud | Rôle |
|---|---|
| `Body` | tout le statique : canon, carcasse, poignée de transport, crosse bleue, pontet |
| `Trigger` | gâchette (pivot +Z) |
| `Tank` | le réservoir : `TankFrame` (bagues), `Water` (l'eau, pilotée par `WaterTank`), `TankGlass`, `FillPoint` (trou de remplissage), `CapHinge` > `Cap` (bouchon arrière et sa charnière). **Extras** : capacité 9, 3 jets par tir, dimensions du cylindre d'eau. |
| `Bottle` | la bouteille d'eau de la recharge (échelle 0 hors recharge), sockets `BottleGrabSocket(TP)` et `BottleNozzle` (départ du filet d'eau) |
| `CapGrabSocket` / `CapGrabSocketTP` | main gauche sur le bouchon (référence) |
| `Muzzle` | bout du canon. **C'est de là que partent les jets visibles.** |
| `GripSocket` | prise main droite |

**Clips de l'arme** (gâchette, bouchon, charnière, bouteille) : `Idle`, `Fire` (rafale 0,42 s), `Reload` (FP), `Reload_TP` (TP), `Inspect`, `Equip`.

### 3.2 Animations FP (`WaterFamas_FP_Poses.glb`)

11 clips pour `Potato_FP_CommonArms`, avec les mêmes 20 canaux que le HexSniper :

`FP_WaterFamas_Hold`, `FP_WaterFamas_Run`, `FP_Aim_WaterFamas`, `FP_Raise_WaterFamas`, `FP_Lower_WaterFamas`, `FP_Fire_WaterFamas`, `FP_FireAim_WaterFamas`, `FP_Reload_WaterFamas`, `FP_Inspect_WaterFamas`, `FP_Equip_WaterFamas`, `FP_Unequip_WaterFamas`.

- **À une main** : cadrage en diagonale qui montre le réservoir et le flanc gauche.
- **Bras gauche au repos = le long du corps**, comme en TP : l'épaule est à côté de l'œil et le bras pend tout droit, **entièrement hors champ** (bras, main et manche), dans tous les clips sauf la recharge. Pendant la recharge, la main gauche remonte du bas de l'écran vers le bouchon / la bouteille puis redescend le long du corps (la manche ne traverse jamais l'écran).
- **Tir (`fire` / `fireAim`)** : une rafale = 3 petits reculs (un par jet), gâchette tenue pendant la rafale, retour en 0,42 s. Pas de boucle.
- **Recharge (3,3 s, v2 « bras naturels »)** : la main droite baisse l'arme au centre, canon vers la droite, bouchon tourné vers la main gauche. Le bouchon est dévissé en **2 quarts de tour partagés entre les deux mains**, comme un bocal : la main gauche tourne de 45° pendant que la droite fait rouler l'arme de 45° en sens inverse, puis les deux lâchent et reprennent. La main gauche écarte le bouchon sur sa charnière, sort de l'écran, revient avec une bouteille ; **l'arme pique du nez** (trou vers le haut) et la bouteille est versée depuis la gauche (filet d'eau, le niveau monte), puis la main referme et revisse le bouchon.
  - Poignets et avant-bras restent dans leur plage naturelle sur toute la recharge (torsion du poignet ≤ 12°, de l'avant-bras ≤ 25°, coudes vers le bas, bras gauche qui entre toujours par le bas de l'écran) : plus de poignet tordu ni de bras qui se plie en crochet.
- **Inspection (3,6 s)** : dans le même style que les autres armes (une main) — côté gauche, puis le réservoir vu d'en haut avec 3 secousses : l'eau clapote.

### 3.3 Animations TP (`WaterFamas_TP_Poses.glb`)

7 clips pour `Potato_TP_Character` : `TP_Hold_WaterFamas`, `TP_Run_WaterFamas`, `TP_Aim_WaterFamas`, `TP_Raise_WaterFamas`, `TP_Lower_WaterFamas`, `TP_Fire_WaterFamas` (rafale, one-shot), `TP_Reload_WaterFamas`.

- Arme tenue **à une main**, droit devant, à hauteur de poitrine, côté droit. Le bras gauche pend contre le ventre et **balance pendant la course**.
- Recharge TP : même timeline que la FP ; la bouteille est prise **à la ceinture** (hanche gauche) et y retourne.
- `upperBodyMask` (dans le profil) contient `Spine_1` et `Weapon_R`.

---

## 4. Vue FP (joueur local)

```ts
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { WaterFamasProfile, WATER_FAMAS_TIMELINE } from "../profiles/WaterFamasProfile";
import { WaterFamasController } from "../weapons/waterfamas/WaterFamasController";

const gltf = await new GLTFLoader().loadAsync(WaterFamasProfile.weaponUrl);   // à mettre en cache (FP + TP)
const famas = new WaterFamasController(gltf, {
  firstPerson: true,
  timeline: WATER_FAMAS_TIMELINE,
  events: { /* §6 */ },
  // recoilPerJet: 0.035,                // secousse cosmétique du viewmodel par jet
});
famas.attachViewmodel(viewmodel);
await viewmodel.equip(WaterFamasProfile, famas.object, { playEquipClip: true });
```

Ordre **par frame** :

```ts
viewmodel.update(dt, input);
viewmodel.syncCamera(gameCamera);
famas.update(dt);            // APRÈS syncCamera, à chaque frame, même au repos (l'eau du réservoir en dépend)
jets.update(dt);             // §8
wetMarks.update(dt);         // §8
// rendu du monde, puis viewmodel.render(renderer)
```

**API du contrôleur (présentation seulement, aucun gameplay)**

| Membre | Rôle |
|---|---|
| `fire(aiming = false): boolean` | **Une rafale de 3 jets.** Le 1er jet part tout de suite (`onJet(0)` pendant l'appel), les 2 autres depuis `update()` à 0,075 et 0,15 s. Joue `fire` ou `fireAim` (visée) + le clip arme `Fire`. Renvoie `false` (et `onDryFire` si vide). |
| `canFire` | munitions > 0, pas en pleine recharge, 0,45 s depuis la rafale précédente |
| `firing` · `jetsFired` · `burstIsAimed` | rafale en cours, jets déjà partis, rafale tirée en visée |
| `reload(): boolean` · `canReload` | remplissage (3,3 s) |
| `cancelReload()` | changement d'arme ou mort. Avant la fin du versement (1,98 s), les munitions d'avant sont gardées. |
| `inspect(): boolean` | inspection (3,6 s), refusée pendant une rafale ou une recharge |
| `setAmmo(n)` | synchro réseau ou respawn (0 à 9) — niveau d'eau instantané |
| `ammo` · `capacity` (= 9) · `jetsPerBurst` (= 3) · `reloading` | état |
| `muzzle` | nœud `Muzzle` (départ des jets visibles) |
| `tank` | l'eau du réservoir (`tank.resetMotion()` après une téléportation) |
| `dispose()` | si tu ne gardes pas l'instance au déséquipement |

---

## 5. Vue TP (joueurs distants)

```ts
const remote = new WaterFamasController(gltf, {
  firstPerson: false, timeline: WATER_FAMAS_TIMELINE,
  events: { onJet: (k) => spawnRemoteJet(remote, k) },        // §8 : le jet visible part de remote.muzzle
});
const mount = createWeaponMount("WaterFamasTPMount", WaterFamasProfile.tpMount);
character.getObjectByName("Weapon_R")!.add(mount);
mount.add(remote.object);
```

- **Clips du perso.** `PotatoCharacter` joue `tpClips.hold` / `run`, le trio `WATER_FAMAS_TP_AIM_CLIPS` et les actions `fire` (one-shot, **pas une boucle**) et `reload`, avec `upperBodyMask`.
- **Rafale reçue du serveur :** `remote.playRemote("fire", aiming)` et l'action TP `fire` sur le perso, **la même frame**. Le contrôleur émet alors ses 3 `onJet` au bon rythme.
- **Recharge :** `remote.playRemote("reload")` et l'action TP `reload`, la même frame. Le contrôleur choisit tout seul le clip arme `Reload_TP`.
- `remote.update(dt)` à chaque frame (après l'animation du perso) ; `remote.setAmmo(n)` pour resynchroniser.

---

## 6. Événements et sons

**Recharge (secondes depuis le début, 3,3 s)**

| Événement | t | Effet |
|---|---|---|
| `capGrab` | 0,32 | la main saisit le bouchon |
| `capOff` | 0,66 | bouchon dévissé |
| `hingeOpen` | 0,70 | bouchon écarté sur sa charnière |
| `bottleIn` | 1,10 | bouteille en main |
| `pourStart` | 1,44 | l'eau coule dans le réservoir |
| `pourEnd` | 1,98 | **munitions = 9** |
| `bottleOut` | 2,30 | bouteille rangée |
| `hingeClose` | 2,62 | bouchon refermé |
| `capScrewed` | 2,86 | revissé |
| `readyToFire` | 2,95 | on peut tirer |

**Callbacks** (branche les sons comme pour le Popcorn Shotgun)

| Callback | Son suggéré |
|---|---|
| `onBurstStart(aiming)` | TP : action `fire` du perso ; réseau : message de rafale |
| `onJet(k, ammoLeft)` | « pssht » d'eau sous pression, un par jet. **Raycast du jet + HUD ici.** |
| `onBurstEnd()` | — |
| `onDryFire()` | petit clic + « pff » vide |
| `onCapGrab()` · `onCapOff()` | grincement du pas de vis · petit « pop » |
| `onHingeOpen()` · `onHingeClose()` | clic plastique |
| `onBottleIn()` · `onBottleOut()` | bouteille plastique |
| `onPourStart()` | glouglou (0,54 s) |
| `onAmmoRefilled()` | petit son « plein » ; HUD à 9 |
| `onCapScrewed()` | clac de fin de vissage |
| `onReloadEnd(cancelled)` | — |

---

## 7. Gameplay : tir **hitscan** en rafale et dégâts

Le pack ne contient **aucun gameplay** : c'est à toi de le coder, en suivant le Popcorn Shotgun (et le Paintball Rifle s'il est intégré) pour le réseau, l'autorité serveur et la détection de la tête. Les valeurs sont dans `WaterFamasGameplay.ts`.

- **C'est du hitscan, jet par jet.** Chaque jet = **un raycast instantané** depuis la **caméra de jeu**, portée 28 m, **au moment où le jet part** (`onJet`, soit 0 / 0,075 / 0,15 s après l'appui). Les dégâts tombent **tout de suite**, pas à l'arrivée du jet visible.
- **Dégâts (proposition à me faire valider) : 16 au corps, 24 à la tête (×1,5)**, pas d'atténuation. Utilise `jetDamage(headshot)` et la même détection de tête que les autres armes. Si le projet a une autre échelle de PV, demande-moi avant de changer les valeurs.
- **Direction et dispersion :** `jetDirection(forward, up, k, aiming, seed, out)` (k = numéro du jet dans la rafale).
- **Seed.** Chaque jet a une seed (ou une seed de rafale + k), envoyée avec l'événement de tir. Serveur et clients calculent **la même direction** et **la même trace mouillée** (§8).
- **Autorité.** Le serveur fait le raycast qui compte (même compensation de latence que les autres armes hitscan). Il applique les dégâts et renvoie le résultat à tous : rien touché, décor (point + normale), ou joueur (id + zone).
- **Rafale et munitions côté serveur :**
  - 3 jets par rafale, **0,45 s minimum** entre deux rafales ;
  - 9 munitions ; une rafale commencée avec moins de 3 jets n'en tire que ce qu'il reste ;
  - pendant la recharge, les munitions ne reviennent qu'à la fin du versement (1,98 s) ; tir possible à 2,95 s.
- **Ignore le tireur** dans le raycast. L'arme, les jets, les éclaboussures et les traces ne sont jamais touchés : leur `raycast` est neutralisé.
- **Feedback immédiat** (hitmarker, son de touche) au moment du jet ; la trace mouillée arrive avec le jet visible.

Boucle locale minimale :

```ts
if (triggerPressedThisFrame && famas.canFire) famas.fire(isAiming);   // → onJet(k, ammoLeft) × 3 : raycast + réseau + visuels
if (reloadPressed) famas.reload();
if (inspectPressed) famas.inspect();
onWeaponSwitch(() => famas.cancelReload());
```

---

## 8. Visuel : **les jets doivent se voir partir de l'arme**, et l'eau **mouille puis sèche**

Tout est déjà codé et testé (`WaterJets.ts`, `WetMarks.ts`). À toi de le brancher **pour tous les jets de tous les joueurs**.

### 8.1 Jets visibles (FP et TP)

```ts
import { WaterJets } from "../weapons/waterfamas/WaterJets";
import { WetMarks, waterHitBarycentric } from "../weapons/waterfamas/WetMarks";

const wetMarks = new WetMarks(worldScene);             // une instance pour la partie
const jets = new WaterJets(worldScene, wetMarks);      // une instance pour tous les joueurs (2 draw calls)

// UNE source par arme (closure stable, créée une fois par joueur) : la position du canon MAINTENANT
// (relue à chaque frame tant que l'eau du jet sort du canon).
const tmp = new THREE.Vector3();
const muzzleSource = isLocal
  ? () => viewmodel.socketWorldForGameCamera(famas.muzzle, gameCamera, tmp)   // FP : le canon du viewmodel à l'écran
  : () => remote.muzzle.getWorldPosition(tmp);                                 // TP : le canon du joueur distant
const jetOpts = { source: muzzleSource };

// pour CHAQUE jet (local ou distant), avec le résultat du raycast et la seed :
const from = muzzleSource().clone();
if (!hit) jets.spawn(from, maxRangePoint, null, 1, jetOpts);
else if ((hit.object as THREE.SkinnedMesh).isSkinnedMesh) {
  const bary = waterHitBarycentric(hit.object as THREE.Mesh, hit.faceIndex!, hit.point, new THREE.Vector3());
  jets.spawn(from, hit.point, { mesh: hit.object as THREE.SkinnedMesh, faceIndex: hit.faceIndex!, bary }, 1, jetOpts);
} else {
  const normal = hit.face!.normal.clone().transformDirection(hit.object.matrixWorld);
  jets.spawn(from, hit.point, { normal, seed }, 1, jetOpts);
}
```

- **3 tirs bien séparés, comme les 3 cartouches d'une rafale de FAMAS** (pas un spray, pas un jet continu, pas des petits points). Chaque jet est un **paquet d'eau allongé** (l'eau sort du canon pendant 0,04 s, soit ~1 m d'eau), suivi d'un espace vide avant le jet suivant (0,075 s entre deux jets, ~1 m d'air) : on voit nettement 3 paquets d'eau se suivre du canon jusqu'à la cible.
- **Aspect eau :** chaque paquet grossit avec la distance, porte des **renflements qui voyagent avec l'eau**, a une tête arrondie et une queue qui s'effile ; ombrage d'eau (cœur clair et transparent, bord bleu plus dense, reflets blancs et petites bulles qui scintillent). Gouttelettes à la bouche, gouttes qui se détachent, **éclaboussure** à chaque impact.
- **FP :** départ du canon **du viewmodel** (`socketWorldForGameCamera`) ; la `source` est relue à chaque frame tant que l'eau sort : le paquet part bien du canon même quand l'arme bouge (recul de la rafale, visée).
- **TP :** départ de `remote.muzzle`, impact reçu du serveur ou recalculé avec la seed.
- **Vitesse :** l'eau sort du canon à ~10 m/s et atteint 30 m/s en ~0,06 s (on la voit sortir), petite courbe de gravité nulle aux deux bouts : **le jet arrive exactement au point du raycast**. Rappel : les dégâts sont hitscan (instantanés), la trace mouillée apparaît quand la tête du jet arrive.
- **Coût :** 2 draw calls pour tous les jets de tous les joueurs (paquets d'eau + gouttes), le CPU n'écrit un jet qu'une fois (+ la position du canon pendant 0,04 s). Tout le reste est calculé dans le vertex shader.
- Options : `new WaterJets(scene, wetMarks, { maxStreams, maxDroplets, speed, launchSpeed, accelTime, radius, emitDuration, joinOverlap, gravity, color })`. Défauts réglés sur la preview (`speed` 30, `radius` 0,02, `emitDuration` 0,04) : ne les change pas sans me demander.
- `spawn(from, to, hit, strength = 1, { source, duration, join })` : `strength` < 1 amincit le jet (réservoir presque vide, optionnel). **Ne mets pas `join: true`** (il fusionne les 3 jets en un seul jet continu : ce n'est pas le FAMAS).

### 8.2 Traces mouillées sur le décor, **qui sèchent**

- **Une seule** instance `WetMarks` : **1 draw call** pour toutes les traces. Pas de texture, pas de `DecalGeometry`, pas d'allocation par trace. **N'ajoute pas** d'autre système de décal.
- Trace sombre et brillante, avec **coulures vers le bas** sur les murs. Elle reste mouillée 2,5 s puis **sèche** en 3,5 s (elle rétrécit et s'efface). Rien à nettoyer : ring buffer de 384 traces, les traces sèches ne coûtent rien, le mesh est masqué quand tout est sec.
- Un jet qui retombe sur une trace encore mouillée la **rafraîchit** (elle grandit un peu) au lieu d'empiler un quad.
- **Même trace pour tous :** passe la **seed** du jet (`{ normal, seed }`).
- **Décor statique seulement.** Sur un objet qui bouge, pas de trace (juste l'éclaboussure).

### 8.3 Joueurs **mouillés et brillants** pendant un moment

- **Au spawn** de chaque perso (local et distants) : `wetMarks.attach(mesh)` sur le `SkinnedMesh` du corps (nœud `Potato`). Ça peut aussi se faire au premier impact.
- À chaque touche, le jet visible **mouille** le joueur à son arrivée : zone plus sombre, bleutée et **brillante** (reflet), qui coule un peu vers le bas, suit les animations (stockée par sommet) et **sèche toute seule** (4 s mouillé + 6 s de séchage, calculé dans le shader : zéro coût CPU par frame).
- **À la mort et au respawn : `wetMarks.dryUnder(characterRoot)`** sur tous les clients. À la déconnexion : `wetMarks.detach(mesh)`.
- **Si le Paintball Rifle est intégré** : sur le même mesh, fais `splats.attach(mesh)` **avant** `wetMarks.attach(mesh)` (le patch mouillé enchaîne le patch peinture ; l'ordre inverse perdrait la peinture).
- Raycast des persos : vise le `SkinnedMesh` du corps (three r169 applique le skinning au raycast). Si le serveur utilise des hitboxes, fais côté client un **second raycast visuel** sur le mesh touché pour la face et les barycentriques.

---

## 9. L'eau du réservoir (déjà faite, rien à coder)

- Le contrôleur remplace le matériau du nœud `Water` par un shader d'eau (`WaterTank`) : **surface libre toujours horizontale** dans le monde (penche l'arme, l'eau reste à plat), niveau = munitions, **clapotis** quand l'arme accélère (course, rotation, tir, inspection, recharge), petites vaguelettes, ménisque clair contre la paroi.
- Pendant la recharge : **filet d'eau** de `BottleNozzle` à `FillPoint`, le niveau monte de `pourStart` à `pourEnd`.
- Coût : 2 draw calls + le filet pendant le versement, ~0,02 ms CPU par arme et par frame. Marche en FP (scène du viewmodel) comme en TP.
- Réglages : option `tank` du contrôleur (`sloshHz`, `sloshDamping`, `sloshGain`, `maxTilt`, `color`, `surfaceColor`). Après une téléportation ou un respawn : `famas.tank.resetMotion()`.

---

## 10. Checklist de vérification

**Intégration**

- [ ] Fichiers rangés comme ceux du Popcorn Shotgun, arme sélectionnable comme lui, `tsc` OK, aucun asset 404 en `vite build` + `preview`.

**FP**

- [ ] À l'équipement, le clip Equip se joue ; l'arme est tenue **à une main** ; **rien du bras gauche n'est visible** au repos, en course, en tir et pendant l'inspection (il pend le long du corps).
- [ ] Un appui = **une rafale de 3 jets** (3 petits reculs, 3 sons), le compteur descend de 3 et **l'eau baisse** dans le réservoir.
- [ ] À l'écran, la rafale = **3 paquets d'eau bien séparés** (comme 3 cartouches), bleus et translucides avec des reflets, qui partent du canon l'un après l'autre et éclaboussent à l'impact. Ni spray, ni jet continu, ni petits points.
- [ ] Maintenir la gâchette ne tire pas en continu ; 0,45 s entre deux rafales.
- [ ] L'eau **reste horizontale** et **clapote** quand on court, tourne vite ou pendant l'inspection.
- [ ] Recharge : bouchon dévissé en 2 quarts de tour (les deux mains tournent), écarté, bouteille versée depuis la gauche (filet visible, niveau qui monte), refermé et revissé ; 9 jets à 1,98 s. Aucun poignet tordu, aucun bras en crochet.
- [ ] Changer d'arme avant 1,98 s : munitions inchangées.
- [ ] Inspection dans le même style que les autres armes, secousses de l'eau à la fin.

**TP**

- [ ] Arme à une main, droite devant, bras gauche le long du corps qui balance en courant.
- [ ] Rafale TP synchronisée avec les 3 jets ; recharge TP avec la bouteille prise à la ceinture.

**Tir et dégâts**

- [ ] **Hitscan par jet** : chaque jet fait son raycast au moment où il part (0 / 0,075 / 0,15 s).
- [ ] Dégâts **validés avec moi** (proposition 16 corps / 24 tête), pas d'atténuation, portée 28 m.
- [ ] Même seed, même direction sur le serveur et tous les clients.

**Eau**

- [ ] **En FP, on voit chaque jet sortir de son canon** et voler jusqu'à l'impact, avec une éclaboussure.
- [ ] **En TP, on voit les jets partir du canon des autres joueurs.**
- [ ] Les traces mouillées apparaissent, coulent sur les murs et **sèchent en ~6 s**, identiques chez tous les joueurs.
- [ ] Un joueur touché devient **mouillé et brillant**, ça suit ses animations et **sèche en ~10 s** ; tout sec à la mort / au respawn.
- [ ] Coût : +2 draw calls au total pour les jets et toutes les traces (`renderer.info.render.calls`), +2 par FAMAS visible pour l'eau du réservoir.

---

## 11. À la fin

Fais-moi un récapitulatif :

- où tu as rangé chaque fichier ;
- ce que tu as repris du Popcorn Shotgun / du Paintball Rifle et ce que tu as modifié dans le projet (fichiers touchés) ;
- comment tu as branché le réseau (message de rafale, seeds, résultats des 3 jets, mort) ;
- les dégâts que tu as mis (et si tu m'as demandé confirmation) ;
- ce qui reste à régler ou à tester à plusieurs joueurs.
