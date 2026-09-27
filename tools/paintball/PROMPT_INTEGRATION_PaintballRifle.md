# Prompt pour Cline : intégrer le Paintball Rifle

## 0. Contexte et mission

Tu travailles sur mon jeu three.js (r169, TypeScript, Vite), avec des personnages « Potato ». Deux armes sont déjà intégrées et servent de référence :

- le **HexSniper** : `HexSniperProfile.ts`, `WeaponProfile_HexSniper.json`, `ViewmodelSystem`, `FPArmsRig`, `WeaponProfile.ts` ;
- le **Popcorn Shotgun** : `PopcornShotgunController`, `PopcornProjectiles`, son profil, son branchement réseau, ses sons, son HUD…

**Ta mission :** intégrer une nouvelle arme, le **Paintball Rifle**, **en t'inspirant du Popcorn Shotgun**.

- **Avant d'écrire du code, relis comment le Popcorn Shotgun est intégré dans le projet :**
  - où son profil est enregistré ;
  - comment il entre dans l'inventaire / la sélection d'arme ;
  - comment les entrées (tir, recharge, inspection) arrivent au contrôleur ;
  - quels messages réseau il envoie et reçoit ;
  - comment l'arme est accrochée au perso TP ;
  - où sont joués ses sons et où est mis à jour le HUD des munitions ;
  - comment les dégâts sont appliqués et comment les zones de tête sont détectées.
- **Reproduis le même schéma pour le Paintball Rifle.** Mêmes dossiers, mêmes conventions de nommage, mêmes points d'entrée.
- **Les différences sont listées au §1.3.** Ne réinvente rien de ce qui existe déjà.

### Règles

- **Pas de modification** de `ViewmodelSystem.ts`, `FPArmsRig.ts` ni `WeaponProfile.ts`.
- **Pas de réexport des GLB** (Blender, gltf-transform, optimiseurs…). Ne change ni leur échelle ni les noms de nœuds : les extras du réservoir, les 20 canaux FP et les sockets en dépendent.
- **Aucune nouvelle dépendance :** seulement `three`.
- **`tsc` doit passer.** Les modules du pack ont été vérifiés en `strict`, `noUnusedLocals` et `erasableSyntaxOnly`.

---

## 1. L'arme

### 1.1 En une phrase

Un **fusil de paintball façon AK**, cartoon, à deux mains et **automatique**. Il crache des billes de peinture de 3 couleurs qui **colorent tout ce qu'elles touchent** : les murs (les taches restent), et les joueurs (la peinture reste sur eux jusqu'à leur mort).

### 1.2 Fiche technique

| | |
|---|---|
| Type | fusil automatique à deux mains, **tir hitscan** |
| Cadence | **600 coups/min**, une bille toutes les 0,1 s tant que la gâchette est tenue |
| Munitions | **réservoir de 32 billes**, mélange de 3 couleurs (rouge, jaune, turquoise) visible dans un réservoir transparent posé sur l'arme |
| **Dégâts** | **12 au corps, ×1,5 à la tête (18)**. Pas d'atténuation avec la distance. |
| Portée | 45 m |
| Dispersion | cône de 0,35° à la 1re bille, +0,25° par bille jusqu'à 2,2° (comme une AK). Se referme à 4°/s au relâchement, resserrée en visée. |
| Recharge | **changement de réservoir**, 2,45 s. Les munitions reviennent au clic (1,52 s), on peut retirer à 2,10 s. |
| Inspection | à une main, 3,6 s. On voit les billes rouler dans le réservoir. |

Si la vie des joueurs est de 100, il faut 9 billes au corps (0,8 s de rafale) ou 6 à la tête (0,5 s).

### 1.3 Ce qui change par rapport au Popcorn Shotgun

| Popcorn Shotgun | Paintball Rifle |
|---|---|
| Tir au coup par coup | **Automatique** : boucle de tir de 0,1 s tant qu'on tient la gâchette, puis `FireEnd` au relâchement (géré par le contrôleur) |
| Projectiles de popcorn | **Hitscan** : un raycast instantané par bille, dégâts immédiats. La bille qu'on voit voler est **purement visuelle**. |
| Recharge par le haut | **Changement de réservoir** : le vide est arraché et tombe, le plein est clipsé, tape, levier d'armement |
| — | **Peinture** : taches persistantes sur le décor, peinture sur les joueurs, perdue à la mort |

---

## 2. Fichiers : je les dépose dans `assets/`, à toi de les ranger

Je vais mettre tous les fichiers du pack dans le dossier `assets/` du projet, peut-être en vrac. **À toi de les ranger** aux bons endroits, **comme ceux du Popcorn Shotgun** (normalement `src/game/profiles/` et `src/assets/potato/`).

| Fichier | Destination | Rôle |
|---|---|---|
| `PaintballRifle_Weapon.glb` | `src/assets/potato/` | l'arme |
| `PaintballRifle_FP_Poses.glb` | `src/assets/potato/` | 11 clips FP (animations seules) |
| `PaintballRifle_TP_Poses.glb` | `src/assets/potato/` | 8 clips TP (animations seules) |
| `WeaponProfile_PaintballRifle.json` | `src/assets/potato/` | montages, clips, timelines, données du réservoir |
| `PaintballRifleProfile.ts` | à côté de `HexSniperProfile.ts` | `WeaponViewProfile` + `PAINTBALL_TP_AIM_CLIPS` + `PAINTBALL_RIFLE_TIMELINE` |
| `PaintballRifleController.ts`, `PaintballHopper.ts`, `PaintballHopperSim.ts` | à côté des fichiers du Popcorn Shotgun, ex. `src/game/weapons/paintball/` | contrôleur de présentation, réservoir, solveur physique des billes |
| `PaintballProjectiles.ts`, `PaintSplats.ts` | même dossier | billes visibles en vol, taches de peinture |
| `PaintballSpread.ts` | même dossier | gameplay de référence : dégâts, dispersion, seed |
| `INTEGRATION.md` | `docs/` ou à côté du contrôleur | doc technique détaillée |
| `_authoring/`, `renders/` | **hors de `src/`** (ex. `tools/paintball/`), ou à ne pas committer | pipeline de génération et images de contrôle. Rien n'est chargé au runtime. |

- **Perso TP.** Le pack ne contient **pas** de `Potato_TP_Character.glb`. Il faut celui livré avec le Popcorn Shotgun (flancs et aisselles corrigés) : vérifie qu'il est bien en place.
- **Noms.** Garde les noms de fichiers exacts : le JSON les référence.
- **Imports du profil.** `PaintballRifleProfile.ts` importe les assets comme `HexSniperProfile.ts` :
  - `../../assets/potato/<fichier>?url` pour les GLB ;
  - le JSON en import direct ;
  - le type depuis `./WeaponProfile`.

  Si tu ranges ailleurs, corrige ces chemins relatifs.

---

## 3. Ce que contient le pack (pour comprendre l'arme)

### 3.1 Le modèle (`PaintballRifle_Weapon.glb`)

**Généralités**

- Modélisé **dans Blender** d'après une image de référence : low-poly, **couleurs de sommets**, environ 3 650 triangles.
- Crosse squelette fixée au collier par un bloc charnière.
- 3 matériaux :
  - `VertexColor` : opaque ;
  - `Glass` : réservoir transparent, alpha 0,24. Le contrôleur pose `renderOrder = 2` ;
  - `Ball` : billes, une couleur par instance.

**Conventions (celles du HexSniper)**

- Racine `PaintballRifle` à l'**échelle 0,19** : garde-la.
- Avant = **−X**, haut = **+Y**.
- Les matrices de montage (FP ×0,40, TP ×0,35) sont dans le profil. Applique-les **une seule fois**.

**Taille.** L'arme est 1,4 fois plus grande que le Popcorn Shotgun, soit environ la taille du HexSniper. Les mains du Potato sont énormes. La poignée pistolet est au même endroit que celle du Popcorn : même main droite, mêmes montages.

**Nœuds**

| Nœud | Rôle |
|---|---|
| `Body` | tout le statique : canon, carcasse, poignées, crosse, support du réservoir |
| `Trigger` | gâchette (pivot +Z) |
| `ChargingHandle` | levier d'armement, côté gauche (glisse vers +X). Sockets `ChargeSocket` / `ChargeSocketTP` |
| `Hopper` | le réservoir amovible : `HopperFrame`, `HopperGlass`, `Ball_Fill` (aperçu éditeur, masqué), `Ball_Template` (bille de rayon 1, masquée, source de la géométrie des billes), `BallFeed`, `HopperGrabSocket` / `HopperGrabSocketTP`. Ses extras (`userData`) contiennent la capacité, la palette, la couleur de chaque bille et 33 dispositions précalculées. |
| `OffhandSocket` / `OffhandSocketTP` | main gauche sur la poignée avant |
| `Muzzle` | bouche du canon. **C'est de là que partent les billes visibles.** |
| `GripSocket` | prise main droite |

**Clips de l'arme.** Chacun anime la gâchette, le levier et le réservoir :

- `Idle` ;
- `Fire` : boucle de 0,1 s, gâchette tenue, levier qui cycle ;
- `Fire_End` ;
- `Reload` (trajet FP du réservoir) et `Reload_TP` (trajet TP) ;
- `Inspect` ;
- `Equip`.

### 3.2 Animations FP (`PaintballRifle_FP_Poses.glb`)

11 clips pour `Potato_FP_CommonArms`, avec les mêmes 20 canaux que le HexSniper :

`FP_PaintballRifle_Hold`, `FP_PaintballRifle_Run`, `FP_Aim_PaintballRifle`, `FP_Raise_PaintballRifle`, `FP_Lower_PaintballRifle`, `FP_Fire_PaintballRifle` (**boucle**), `FP_FireEnd_PaintballRifle`, `FP_Reload_PaintballRifle`, `FP_Inspect_PaintballRifle`, `FP_Equip_PaintballRifle`, `FP_Unequip_PaintballRifle`.

- **Main gauche :** le poing est fermé autour de la poignée avant verticale, et les doigts sont visibles dessus. Le bras n'est pas tordu et monte du bas de l'écran.
- **Tir :** l'arme est légèrement repoussée pendant la rafale, avec un petit recul par bille (environ 15 mm au bout du canon). `FireEnd` (0,3 s) la ramène.
- **Recharge (2,45 s) :**
  - le pouce appuie sur le bouton ;
  - la main arrache le réservoir, le balance et le lâche en bas à gauche ;
  - elle sort de l'écran et revient avec un réservoir plein ;
  - elle le clipse (clic), tape dessus, tire le levier d'armement et revient sur la poignée.

### 3.3 Animations TP (`PaintballRifle_TP_Poses.glb`)

8 clips pour `Potato_TP_Character` :

`TP_Hold_PaintballRifle`, `TP_Run_PaintballRifle`, `TP_Aim_PaintballRifle`, `TP_Raise_PaintballRifle`, `TP_Lower_PaintballRifle`, `TP_Fire_PaintballRifle` (**boucle**), `TP_FireEnd_PaintballRifle`, `TP_Reload_PaintballRifle`.

- Posture « toujours en visée », comme le Popcorn Shotgun v5 : l'arme pointe droit devant, à l'horizontale.
- Buste de trois-quarts : `Spine_1` animé.
- Main gauche sur `OffhandSocketTP`.
- Recharge : le réservoir vide est lâché à gauche, le plein vient de la ceinture.
- `upperBodyMask` (dans le profil) contient `Spine_1` et `Weapon_R`.

---

## 4. Vue FP (joueur local)

Même principe que le Popcorn Shotgun :

```ts
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { PaintballRifleProfile, PAINTBALL_RIFLE_TIMELINE } from "../profiles/PaintballRifleProfile";
import { PaintballRifleController } from "../weapons/paintball/PaintballRifleController";

const gltf = await new GLTFLoader().loadAsync(PaintballRifleProfile.weaponUrl);   // à mettre en cache (FP + TP)
const rifle = new PaintballRifleController(gltf, {
  firstPerson: true,                  // physique des billes du réservoir activée
  timeline: PAINTBALL_RIFLE_TIMELINE,
  dropParent: viewmodel.scene,        // parent du réservoir vide qui tombe pendant la recharge
  events: { /* §6 */ },
  // recoilPerShot: 0.05,             // secousse cosmétique du viewmodel par bille (défaut 0,05)
});
rifle.attachViewmodel(viewmodel);
await viewmodel.equip(PaintballRifleProfile, rifle.object, { playEquipClip: true });
```

Ordre **par frame** :

```ts
viewmodel.update(dt, input);
viewmodel.syncCamera(gameCamera);
rifle.update(dt);            // APRÈS syncCamera, à chaque frame, même au repos
projectiles.update(dt);      // §8
// rendu du monde, puis viewmodel.render(renderer)
```

**API du contrôleur (présentation seulement, aucun gameplay)**

| Membre | Rôle |
|---|---|
| `fire(): boolean` | **Une bille.** Appelle-le toutes les 0,1 s tant que la gâchette est tenue. La 1re bille lance la boucle bras + arme. Chaque bille retire du réservoir la bille la plus proche du trou et appelle `onShot(ammoLeft, color)`. Renvoie `false` (et `onDryFire`) si vide. |
| `canFire` | munitions > 0, pas en pleine recharge, 0,1 s écoulée depuis la bille précédente |
| `firing` | une rafale est en cours |
| `reload(): boolean` · `canReload` | changement de réservoir (2,45 s) |
| `cancelReload()` | changement d'arme ou mort. Avant le clic (1,52 s), les munitions d'avant sont gardées. |
| `inspect(): boolean` | inspection (3,6 s). Refusée pendant un tir ou une recharge. |
| `setAmmo(n)` | synchro réseau ou respawn (0 à 32) |
| `ammo` · `capacity` (= 32) · `reloading` | état |
| `muzzle` | nœud `Muzzle` (départ des billes visibles) |
| `hopper` | réservoir : réglages physiques, `hopper.colorOf(slot, color)` |
| `dispose()` | si tu ne gardes pas l'instance au déséquipement |

Quand plus aucune bille ne part (gâchette relâchée ou réservoir vide), le contrôleur joue tout seul la fin de rafale.

---

## 5. Vue TP (joueurs distants)

Même principe que le Popcorn Shotgun :

```ts
const remote = new PaintballRifleController(gltf, {
  firstPerson: false, timeline: PAINTBALL_RIFLE_TIMELINE,
  dropParent: worldScene,                        // le réservoir lâché tombe dans le monde
  groundY: (x, z) => terrainHeight(x, z),        // optionnel : il rebondit au sol
  events: {
    onBurstStart: () => character.playAction(PaintballRifleProfile.tpClips.actions.fire),     // boucle
    onBurstEnd: () => character.playAction(PaintballRifleProfile.tpClips.actions.fireEnd),
  },
});
const mount = createWeaponMount("PaintballRifleTPMount", PaintballRifleProfile.tpMount);
character.getObjectByName("Weapon_R")!.add(mount);
mount.add(remote.object);
```

- **Clips du perso.** `PotatoCharacter` joue `tpClips.hold` / `run`, le trio `PAINTBALL_TP_AIM_CLIPS` et les actions `fire` (boucle), `fireEnd` et `reload`, avec `upperBodyMask`.
- **À chaque bille reçue du serveur** : `remote.playRemote("fire")`, **et** la bille visible part de `remote.muzzle` (§8).
- **Recharge :** `remote.playRemote("reload")` et l'action TP `reload` sur le perso, **la même frame**. Le contrôleur choisit tout seul le clip arme `Reload_TP`.
- `remote.update(dt)` à chaque frame ; `remote.setAmmo(n)` pour resynchroniser.

---

## 6. Événements et sons

**Recharge (secondes depuis le début, 2,45 s)**

| Événement | t | Effet |
|---|---|---|
| `hopperRelease` | 0,40 | pouce sur le bouton |
| `hopperDrop` | 0,78 | le réservoir vide est lâché (une copie tombe) |
| `hopperIn` | 1,10 | réservoir plein dans la main (hors champ en FP) |
| `hopperSeat` | 1,52 | clic, **munitions = 32** |
| `slap` | 1,64 | tape sur le réservoir |
| `chargeBack` / `chargeRelease` | 1,98 / 2,03 | levier |
| `readyToFire` | 2,10 | on peut retirer |

**Callbacks** (branche les sons comme pour le Popcorn Shotgun)

| Callback | Son suggéré |
|---|---|
| `onShot(ammoLeft, color)` | « pfft » d'air comprimé. Met aussi à jour le HUD. |
| `onDryFire()` | clic |
| `onBurstStart()` / `onBurstEnd()` | TP : clips `fire` / `fireEnd` du perso |
| `onHopperRelease()` · `onHopperDrop()` · `onAmmoRefilled()` · `onSlap()` | clic · chute plastique · clac · tape |
| `onChargeBack()` / `onChargeRelease()` | clic-clac |
| `onReloadEnd(cancelled)` | — |

---

## 7. Gameplay : tir **hitscan** et dégâts

Le pack ne contient **aucun gameplay** : c'est à toi de le coder, en suivant le Popcorn Shotgun ou le HexSniper pour le réseau, l'autorité serveur et la détection de la tête. Les valeurs sont dans `PaintballSpread.ts`.

- **C'est du hitscan.** Une bille = **un raycast instantané** depuis la **caméra de jeu** (centre de l'écran), portée 45 m. Les dégâts sont appliqués **tout de suite**, au moment du tir, pas à l'arrivée de la bille visible.
- **Dégâts : 12 au corps, 18 à la tête (×1,5).** Pas d'atténuation avec la distance. Utilise `paintballDamage(headshot)` et la même détection de tête que les autres armes.
- **Direction et dispersion :**
  - direction avec `ballDirection(forward, up, bloom.spreadDeg, seed, out)` ;
  - `PaintballBloom` : `onShot()` à chaque bille, `update(dt, aiming)` à chaque frame.
- **Seed.** Chaque bille a une seed, envoyée avec l'événement de tir. Le serveur et tous les clients calculent **la même direction** et **la même tache** (§8).
- **Autorité.** Le serveur fait le raycast qui compte (avec la même compensation de latence que les autres armes hitscan du projet, s'il y en a). Il applique les dégâts et renvoie le résultat à tous : rien touché, décor (point + normale), ou joueur (id + zone).
- **Cadence et munitions côté serveur :**
  - au moins 0,1 s entre deux billes ;
  - 32 munitions ;
  - pendant la recharge, les munitions ne reviennent qu'au clic (1,52 s) ; tir possible à 2,10 s.
- **Ignore le tireur** dans le raycast. L'arme, les billes visibles et les taches ne sont jamais touchées : leur `raycast` est neutralisé.
- **Feedback immédiat** (hitmarker, son de touche) au moment du tir, comme les autres armes hitscan. La peinture, elle, arrive avec la bille visible (§8).

Boucle locale minimale :

```ts
if (triggerHeld && rifle.canFire) rifle.fire();   // → onShot(ammoLeft, color) : raycast + réseau + visuels
if (reloadPressed) rifle.reload();
if (inspectPressed) rifle.inspect();
onWeaponSwitch(() => rifle.cancelReload());
```

---

## 8. Visuel : **les billes doivent se voir partir de l'arme**, et la peinture reste

Tout est déjà codé et testé (`PaintballProjectiles.ts`, `PaintSplats.ts`). À toi de le brancher **pour toutes les billes de tous les joueurs**.

### 8.1 Billes visibles (FP et TP)

Chaque bille tirée, **la tienne comme celle des autres**, doit être visible : elle part du canon et vole jusqu'au point d'impact du raycast.

- **FP (joueur local) :** départ du canon **du viewmodel** avec `viewmodel.socketWorldForGameCamera(rifle.muzzle, gameCamera, from)`. La bille sort du canon à l'écran.
- **TP (joueurs distants) :** départ de `remote.muzzle.getWorldPosition(from)`, avec l'impact reçu du serveur ou recalculé avec la seed.
- **Réglages par défaut :**
  - bille de 3,2 cm, étirée dans le sens du vol, avec la couleur de la bille du réservoir (`color` de `onShot`) ;
  - vitesse moyenne 45 m/s, **départ lent puis accélération**. Sans ça, en FP, la bille semble apparaître directement au réticule ;
  - 256 billes en vol max (tous joueurs) : **1 draw call**.
- **Options :** `new PaintballProjectiles(template, scene, splats, { max, speed, radius, stretch, easeIn })`. Garde un diamètre d'au moins 3 cm (`radius` ≥ 0,015) et une vitesse d'au plus 60 m/s, sinon les billes ne se voient plus partir.
- **À l'arrivée**, la bille s'écrase et **déclenche la peinture** : tache sur le décor ou peinture sur le joueur.

### 8.2 Taches **persistantes et optimisées** sur le décor

- **Une seule** instance `PaintSplats` pour la partie (4096 taches) : **1 draw call** pour toutes les taches.
  - Pas de texture, pas de `DecalGeometry`, pas de mesh ni d'allocation par tache.
  - **N'ajoute pas** d'autre système de décal.
- **Les taches restent :** pas de fondu ni de minuterie.
  - Appelle `splats.clearSurfaces()` seulement à la fin d'une manche ou au changement de carte.
  - Au-delà de 4096 taches, la plus ancienne est réutilisée.
- **Pourquoi c'est optimisé :**
  - **Fusion :** une tache qui tombe sur une autre (même mur) la réutilise, avec la nouvelle couleur par-dessus, au lieu d'empiler un quad. Une rafale au même endroit ne fait pas exploser le nombre de taches ni l'overdraw : une soixantaine de billes au même point donnent 8 instances.
  - **Envoi GPU partiel :** chaque tache n'envoie que sa propre instance au GPU.
  - **Recherche O(1)** par grille de hachage.
- **Même tache pour tous :** passe la **seed** du tir (`{ normal, seed }`) pour que la tache ait la même forme, rotation et taille chez tous les joueurs.
- **Décor statique seulement.** Sur un objet qui bouge (porte, plateforme…), ne fais pas de tache.
- **Optionnel :** pour un joueur qui rejoint en cours de manche, le serveur peut renvoyer les derniers impacts (point, normale, couleur, seed) et le client rejoue `splatSurface(...)`.

### 8.3 Peinture sur les joueurs, **perdue à la mort**

- **Au spawn** de chaque perso (local et distants) : `splats.attach(mesh)` sur le `SkinnedMesh` du corps (nœud `Potato`). Ça peut aussi se faire au premier impact.
- **À chaque touche**, la bille visible peint le joueur à son arrivée. La peinture est stockée par sommet et suit ses animations sans coût.
- **À la mort : `splats.clearPaintUnder(characterRoot)`**, sur **tous les clients**, quand l'événement de mort arrive. Le joueur perd toute la peinture qu'il avait sur lui.
  - Refais-le aussi au respawn, par sécurité.
  - À la déconnexion : `splats.detach(mesh)`.
- **Raycast des persos :** vise le `SkinnedMesh` du corps. three r169 applique le skinning au raycast.
  - Si le serveur utilise des hitboxes (capsules), fais côté client un **second raycast visuel** sur le mesh du perso touché, pour obtenir la face et les barycentriques (`hitBarycentric`).

```ts
import { PaintSplats, hitBarycentric } from "../weapons/paintball/PaintSplats";
import { PaintballProjectiles } from "../weapons/paintball/PaintballProjectiles";

const splats = new PaintSplats(worldScene);
const projectiles = new PaintballProjectiles(gltf.scene.getObjectByName("Ball_Template") as THREE.Mesh, worldScene, splats);

// pour CHAQUE bille (locale ou distante), avec le résultat du raycast et la seed du tir :
const from = new THREE.Vector3();
if (isLocal) viewmodel.socketWorldForGameCamera(rifle.muzzle, gameCamera, from);
else remote.muzzle.getWorldPosition(from);
if (!hit) projectiles.spawn(from, maxRangePoint, color, null);
else if ((hit.object as THREE.SkinnedMesh).isSkinnedMesh) {
  const bary = hitBarycentric(hit.object as THREE.Mesh, hit.faceIndex!, hit.point, new THREE.Vector3());
  projectiles.spawn(from, hit.point, color, { mesh: hit.object as THREE.SkinnedMesh, faceIndex: hit.faceIndex!, bary });
} else {
  const normal = hit.face!.normal.clone().transformDirection(hit.object.matrixWorld);
  projectiles.spawn(from, hit.point, color, { normal, seed });
}

// mort d'un joueur (tous les clients) :
splats.clearPaintUnder(deadPlayer.characterRoot);
```

---

## 9. Physique du réservoir (déjà faite, rien à coder)

- 32 billes qui roulent vraiment dans le réservoir, **en FP seulement**. Elles réagissent à la course, au saut, au recul et à la recharge.
- Mise en veille au repos, environ 0,05 ms par pas. En TP, dispositions précalculées.
- Réglages : `rifle.hopper.inertiaScale` (0,5), `rifle.hopper.maxInertiaG` (2,5), `rifle.hopper.sim.friction` (0,35).

---

## 10. Checklist de vérification

**Intégration**

- [ ] Fichiers rangés comme ceux du Popcorn Shotgun, arme sélectionnable comme lui, `tsc` OK, aucun asset 404 en `vite build` + `preview`.

**FP**

- [ ] À l'équipement, le clip Equip se joue.
- [ ] La main gauche **tient** la poignée avant.
- [ ] Rafale : une bille toutes les 0,1 s, le compteur descend, les billes disparaissent une à une du réservoir.
- [ ] Au relâchement, FireEnd ramène l'arme.
- [ ] Recharge complète : réservoir arraché et lâché, nouveau clipsé, tape, levier, 32 au clic.
- [ ] Changer d'arme avant 1,52 s : munitions inchangées.

**TP**

- [ ] Arme droite, rafale en boucle synchronisée, FireEnd à la fin.
- [ ] Recharge TP : réservoir lâché à gauche.

**Tir et dégâts**

- [ ] **Hitscan :** les dégâts tombent au moment du tir, pas à l'arrivée de la bille.
- [ ] **12 au corps, 18 à la tête**, pas d'atténuation, portée 45 m.
- [ ] Même seed, même direction sur le serveur et tous les clients.
- [ ] Au moins 0,1 s entre deux billes côté serveur.

**Billes et peinture**

- [ ] **En FP, on voit chaque bille sortir de son canon** et voler jusqu'à l'impact.
- [ ] **En TP, on voit les billes partir du canon des autres joueurs.**
- [ ] Les taches **restent** sur les murs pendant toute la manche. Elles sont identiques chez tous les joueurs et effacées seulement par `clearSurfaces()` (nouvelle manche).
- [ ] Un joueur touché garde la peinture sur lui, elle suit ses animations, et **il la perd à sa mort** (chez tout le monde).
- [ ] Coût : +2 draw calls au total pour les billes en vol et toutes les taches (`renderer.info.render.calls`). Pas de chute de FPS après plusieurs minutes de tir sur le même mur.

---

## 11. À la fin

Fais-moi un récapitulatif :

- où tu as rangé chaque fichier ;
- ce que tu as repris du Popcorn Shotgun et ce que tu as modifié dans le projet (fichiers touchés) ;
- comment tu as branché le réseau (message de tir, seed, résultat, mort) ;
- ce qui reste à régler ou à tester à plusieurs joueurs.
