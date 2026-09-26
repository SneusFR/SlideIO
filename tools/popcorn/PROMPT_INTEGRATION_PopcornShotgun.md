# Prompt d'intégration : Popcorn Shotgun (pack v5)

## Contexte

Tu travailles sur mon jeu three.js (r169, TypeScript, Vite), avec des personnages « Potato ». Une arme sert déjà de référence : le **HexSniper**. Elle utilise :

- `HexSniperProfile.ts` et `WeaponProfile_HexSniper.json` ;
- `ViewmodelSystem`, `FPArmsRig` et `WeaponProfile.ts` ;
- `Potato_FP_CommonArms.glb` et `Potato_TP_Character.glb`.

Ta mission : intégrer une nouvelle arme, le **Popcorn Shotgun**, avec **exactement les mêmes conventions** que le HexSniper.

C'est un fusil à pompe à deux mains qui tire du popcorn, avec **2 coups** par recharge. Sur le dessus, un réservoir en verre montre les munitions : plein (2 coups), à moitié (1 coup), vide (0). En vue FP, les popcorns bougent vraiment dans le réservoir (physique).

- **Recharge :** la main gauche ouvre le couvercle d'une pichenette et saupoudre des grains de maïs. Elle referme le couvercle, les grains éclatent en popcorn, puis on pompe.
- **Inspection :** à une main.

### Répartition du travail

| Déjà fait dans le pack | À faire par toi |
|---|---|
| Modèle 3D, animations FP et TP, profil | Rangement des fichiers |
| Contrôleur de présentation : clips de l'arme et des bras synchronisés, réservoir, physique, événements | Branchement FP et TP |
| Deux modules de référence testés (dispersion + dégâts, visuel des popcorns tirés) | Gameplay : tir, dispersion, dégâts, réseau, sons |

### Règles

- **Pas de modification** de `ViewmodelSystem.ts`, `FPArmsRig.ts` ni `WeaponProfile.ts` : le pack s'y branche tel quel.
- **Pas de réexport des GLB** (Blender, gltf-transform, optimiseurs…). Ne change pas leur échelle ni les noms de nœuds. Les extras du réservoir, les 20 canaux FP et les sockets en dépendent.
- **Aucune nouvelle dépendance :** seulement `three`.

---

## 1. Fichiers : je les dépose dans `assets/`, à toi de les ranger

Je vais mettre tous les fichiers du pack dans le dossier `assets/` du projet, peut-être en vrac. **À toi de les ranger toi-même** aux bons endroits, en suivant l'arborescence déjà utilisée par le HexSniper. Normalement :

- `HexSniperProfile.ts` est dans `src/game/profiles/` ;
- il importe `../../assets/potato/...`, donc les assets sont dans `src/assets/potato/`.

Si ton arborescence est différente, suis la tienne.

| Fichier | Destination | Rôle |
|---|---|---|
| `PopcornShotgun_Weapon.glb` | `src/assets/potato/` | l'arme |
| `PopcornShotgun_FP_Poses.glb` | `src/assets/potato/` | 11 clips FP (animations seules) |
| `PopcornShotgun_TP_Poses.glb` | `src/assets/potato/` | 8 clips TP (animations seules) |
| `WeaponProfile_PopcornShotgun.json` | `src/assets/potato/` | matrices de montage, noms des clips, timelines, données du réservoir |
| `Potato_TP_Character.glb` | `src/assets/potato/`, **remplace l'existant** (même nom) | perso TP, poids de peau corrigés (voir §2.4) |
| `PopcornShotgunProfile.ts` | à côté de `HexSniperProfile.ts` | `WeaponViewProfile` + `POPCORN_TP_AIM_CLIPS` + `POPCORN_SHOTGUN_TIMELINE` |
| `PopcornShotgunController.ts`, `PopcornTank.ts`, `PopcornTankSim.ts` | ex. `src/game/weapons/popcorn/` | contrôleur, réservoir three.js, solveur physique |
| `PopcornSpread.ts` | même dossier | **référence** : dispersion + dégâts (§6, §7) |
| `PopcornProjectiles.ts` | même dossier | **référence** : popcorns tirés, visuels seulement (§8) |
| `INTEGRATION.md` | `docs/` ou à côté du contrôleur | doc technique détaillée |
| `_authoring/`, `renders/`, `diagnostic/` | **hors de `src/`** (ex. `tools/popcorn/`), ou à ne pas committer | pipeline Python et images de contrôle ; rien n'est chargé au runtime |

- Garde les **noms de fichiers exacts** : le JSON les référence.
- `PopcornShotgunProfile.ts` importe les assets comme `HexSniperProfile.ts` : `../../assets/potato/<fichier>?url` pour les 3 GLB, et le JSON en import direct. Il importe aussi le type depuis `./WeaponProfile`. Si tu ranges ailleurs, **corrige ces chemins relatifs**.
- Les fichiers de `weapons/popcorn/` n'importent que `three` et leurs voisins.
- `tsc` doit passer. Les modules ont été vérifiés en `strict`, `noUnusedLocals` et `erasableSyntaxOnly`.

---

## 2. Changements appliqués au modèle 3D (pour comprendre le pack)

### 2.1 L'arme (`PopcornShotgun_Weapon.glb`)

**Modèle**

- Modélisée d'après l'image de référence : low-poly, **couleurs de sommets** (aucune texture), environ 2 000 triangles.
- 2 matériaux :
  - `VertexColor`, opaque ;
  - `Glass`, transparent (alpha 0,26), pour le réservoir. `renderOrder = 2` est posé par le contrôleur.

**Conventions (celles du HexSniper)**

- La racine `PopcornShotgun` est à l'**échelle 0,19** : garde-la.
- Avant = **−X**, haut = **+Y**.
- Les matrices de montage (FP ×0,40, TP ×0,35) sont dans le profil. Applique-les **une seule fois**, sans normalisation en plus.

**Nœuds**

| Nœud | Rôle |
|---|---|
| `Body` | corps de l'arme |
| `Trigger` | gâchette (animée) |
| `Pump` | pompe (animée). Enfants : `OffhandSocket` (main gauche FP) et `OffhandSocketTP` (main gauche TP) |
| `Tank` | réservoir : voir détail ci-dessous |
| `Muzzle` | bouche du canon, avant = −X. Exposé par `controller.muzzle` |
| `GripSocket` | prise main droite |

Contenu du nœud `Tank` :

- `TankFrame` et `TankGlass` ;
- `TankLid`, le couvercle animé, avec les sockets `LidEdgeSocket` et `LidTopSocket` ;
- `PopcornFeed` ;
- les gabarits `Popcorn_Template` (100 tris) et `Kernel_Template` (24 tris), masqués et réutilisés par instancing ;
- `Popcorn_Fill`, un aperçu pour les éditeurs, masqué au runtime.

**Données du réservoir**

Elles sont dans les **extras du nœud `Tank`** (lus via `userData`) : dispositions plein et moitié, ordre de consommation, rayons, gravité. Ne les perds pas.

**Clips de l'arme**

`Idle`, `Fire`, `Fire_Last`, `Reload`, `Inspect`, `Equip`. Ils animent la pompe, le couvercle et la gâchette. Le contrôleur les lance **la même frame** que les clips des bras.

**Itérations sur le modèle**

| Changement | Pourquoi |
|---|---|
| Pompe raccourcie, épaissie, placée juste sous le canon | c'est là que la main gauche du Potato se pose naturellement |
| Prise de la main gauche ajustée sur le vrai mesh de la main | rien ne traverse la pompe ni le canon ; le pouce longe le flanc |
| `OffhandSocket` tourné de −25° autour de l'axe de la pompe | le bras gauche est **droit à l'écran** (avant, il faisait un zigzag : « bras courbé ») |
| Nouveau `OffhandSocketTP`, à l'arrière de la pompe | tenue TP : le bras gauche du Potato est court |

### 2.2 Animations FP (`PopcornShotgun_FP_Poses.glb`)

11 clips pour `Potato_FP_CommonArms`, avec les **mêmes 20 canaux que le HexSniper** : `FP_PopcornShotgun_Hold`, `FP_PopcornShotgun_Run`, `FP_Aim_PopcornShotgun`, `FP_Raise_PopcornShotgun`, `FP_Lower_PopcornShotgun`, `FP_Fire_PopcornShotgun`, `FP_FireLast_PopcornShotgun`, `FP_Reload_PopcornShotgun`, `FP_Inspect_PopcornShotgun`, `FP_Equip_PopcornShotgun`, `FP_Unequip_PopcornShotgun`.

- **Main gauche :** bras droit à l'écran, collée à la pompe sur toutes les frames où elle la tient (écart ≤ 0,03 mm, mesuré dans `ViewmodelSystem`).
- **Fire :** recul + coup de pompe.
- **FireLast :** recul seul, car c'est le dernier coup et il n'y a rien à chambrer. On pompe à la fin de la recharge.
- **Reload :** l'arme descend et pivote vers la main gauche le temps du couvercle et du saupoudrage.
- **Inspect :** à une main. La gauche lâche l'arme à 0,12 s et la reprend à 3,38 s.

### 2.3 Animations TP (`PopcornShotgun_TP_Poses.glb`)

8 clips pour `Potato_TP_Character` : `TP_Hold_PopcornShotgun`, `TP_Run_PopcornShotgun`, `TP_Aim_PopcornShotgun`, `TP_Raise_PopcornShotgun`, `TP_Lower_PopcornShotgun`, `TP_Fire_PopcornShotgun`, `TP_FireLast_PopcornShotgun`, `TP_Reload_PopcornShotgun`.

- **Posture « toujours en visée » :** dans tous les clips, l'arme pointe droit devant, à l'horizontale, sans roulis. Hold et Aim sont presque identiques, et les bras ne sont pas tordus.
- **Buste :** un peu de trois-quarts. `Spine_1` est animé : −12° de lacet, 4,5° d'inclinaison. Cela permet au bras gauche d'atteindre la pompe.
- **Main gauche :** sur `OffhandSocketTP`.
- **`Weapon_R` :** une piste de translation fixe, à sa valeur de repos.
- **Mélange avec la locomotion :** `upperBodyMask` (dans le profil) contient `Spine_1` et `Weapon_R`.

### 2.4 Perso TP : poids de peau corrigés (`Potato_TP_Character.glb`)

- **Problème.** Pour tenir l'arme droite, le bras droit se lève devant le ventre. Avec les poids d'origine, les sommets du flanc suivaient l'os du bras et de l'épaule : un gros pli se formait sur le ventre, surtout à droite. La visée TP du HexSniper avait le même défaut.
- **Correction.** Les poids de **506 sommets** (flancs et aisselles, des deux côtés) ont été recalculés.
  - Seuls `JOINTS_0` et `WEIGHTS_0` du mesh `potato` changent.
  - Géométrie, os, hiérarchie, noms et taille du fichier sont identiques.
  - Les doublons de couture UV sont soudés, donc pas de déchirure.
- **Résultat (profondeur du pli).**

  | Pose | Avant | Après |
  |---|---|---|
  | Tenue du shotgun | 15 mm | 6 mm |
  | Visée TP du HexSniper | 15 mm | 7,5 mm |
  | Hold du HexSniper | 9 mm | 5,5 mm |

- **À faire.** Remplace le fichier (même nom, même chemin) : aucune modification de code. C'est le perso de **toutes** les armes : vérifie rapidement les autres armes en TP.

---

## 3. Brancher la vue FP (joueur local)

```ts
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { PopcornShotgunProfile, POPCORN_SHOTGUN_TIMELINE } from "../profiles/PopcornShotgunProfile";
import { PopcornShotgunController } from "../weapons/popcorn/PopcornShotgunController";

const gltf = await new GLTFLoader().loadAsync(PopcornShotgunProfile.weaponUrl); // à mettre en cache (partagé FP/TP)
const shotgun = new PopcornShotgunController(gltf, {
  firstPerson: true,                 // physique du popcorn activée
  timeline: POPCORN_SHOTGUN_TIMELINE,
  burstParent: viewmodel.scene,      // petite bouffée de popcorn cosmétique au canon (optionnel)
  events: {                          // tous optionnels (voir §4)
    onShot, onDryFire, onPumpBack, onPumpForward,
    onLidOpen, onKernelsIn, onLidClose, onPop, onAmmoRefilled, onReloadEnd,
  },
});
shotgun.attachViewmodel(viewmodel);
await viewmodel.equip(PopcornShotgunProfile, shotgun.object, { playEquipClip: true });
```

Ordre **par frame** :

```ts
viewmodel.update(dt, input);       // même input que le HexSniper (visée, course, vitesse…)
viewmodel.syncCamera(gameCamera);
shotgun.update(dt);                // APRÈS syncCamera : le réservoir lit la pose monde finale. À appeler à chaque frame, même au repos
projectiles.update(dt);            // §8
// rendu du monde, puis viewmodel.render(renderer)
```

API du contrôleur :

| Membre | Rôle |
|---|---|
| `fire(): boolean` | Lance FP_Fire (ou FP_FireLast au dernier coup) et le clip arme, la même frame. Ajoute du recul au viewmodel, retire 36 popcorns du réservoir, déclenche la bouffée au canon. Renvoie `false` (et `onDryFire`) si le réservoir est vide ou si une recharge est en cours. |
| `canFire` | `true` quand un tir est possible : munitions > 0 et point `readyToFire` de la timeline atteint (0,58 s après un tir, 2,06 s dans la recharge). |
| `reload(): boolean` · `canReload` | Lance la recharge (2,2 s). Refusée si le réservoir est déjà plein ou si une recharge est en cours. |
| `cancelReload()` | À appeler au changement d'arme ou à la mort. Avant `ammoRefilled` (1,75 s), la recharge est annulée et les munitions reviennent à leur valeur d'avant. |
| `inspect(): boolean` | Inspection à une main (3,6 s). Refusée pendant un tir ou une recharge. |
| `setAmmo(n)` | Synchro réseau ou respawn : remplissage instantané du réservoir (0, 1 ou 2), sans animation. |
| `ammo` · `shots` (= 2) · `busy` · `reloading` | État. |
| `muzzle` | Nœud `Muzzle` (bouche du canon). |
| `tank` | Réservoir : `tank.popcornMesh` sert de gabarit pour les projectiles (§8). Réglages physiques au §9. |
| `dispose()` | Si tu ne gardes pas l'instance en cache au déséquipement. |

Gameplay minimal :

```ts
if (firePressed && shotgun.canFire && shotgun.fire()) {
  const seed = nextShotSeed();                         // §6 (à envoyer au serveur)
  fireShotgunPellets(gameCamera, seed);                // §6 + §7 : raycasts + dégâts
  spawnPopcornVisuals(seed);                           // §8
}
if (reloadPressed) shotgun.reload();
if (inspectPressed) shotgun.inspect();
onWeaponSwitch(() => shotgun.cancelReload());
// Optionnel : tir à vide → onDryFire (clic) puis recharge auto si tu le souhaites.
```

---

## 4. Événements et timelines (secondes depuis le début du clip)

Les timelines sont dans le JSON, sous `actions`, exposées par `POPCORN_SHOTGUN_TIMELINE`.

| Action | Durée | Événements |
|---|---|---|
| Fire | 0,90 s | tir 0 · `pumpBack` 0,26 · `pumpForward` 0,42 · `readyToFire` 0,58 |
| FireLast | 0,55 s | tir 0 · `readyToFire` 0,30 (pas de pompe) |
| Reload | 2,20 s | `lidOpen` 0,28 · `kernelsIn` 0,44→0,64 · `lidClose` 0,88 · `pops` 0,92→1,75 · `ammoRefilled` 1,75 · `pumpBack` 1,80 · `pumpForward` 1,93 · `readyToFire` 2,06 |
| Inspect | 3,60 s | la main gauche lâche à 0,12 et reprend la pompe à 3,38 |

Callbacks et sons suggérés :

| Callback | Moment | Son suggéré |
|---|---|---|
| `onShot(shotsLeft)` | tir | détonation « pop » grave + HUD (2 pastilles) |
| `onDryFire()` | tir à vide | clic |
| `onPumpBack()` / `onPumpForward()` | pompe | clac-clac |
| `onLidOpen()` | couvercle ouvert | clic plastique |
| `onKernelsIn()` | saupoudrage | pluie de grains |
| `onLidClose()` | couvercle fermé | clic |
| `onPop(index, total)` | un grain éclate | « pop ». **Jusqu'à 72 par recharge** en crescendo : limite les voix (≈ 25 à 35 par seconde) |
| `onAmmoRefilled()` | munitions à 2 | — |
| `onReloadEnd(cancelled)` | fin de recharge | — |

---

## 5. Vue TP (joueurs distants et 3e personne)

```ts
import { createWeaponMount } from "../profiles/WeaponProfile";
import { PopcornShotgunProfile, POPCORN_TP_AIM_CLIPS, POPCORN_SHOTGUN_TIMELINE } from "../profiles/PopcornShotgunProfile";

const remote = new PopcornShotgunController(gltf, {
  firstPerson: false,                // pas de physique : dispositions plein/moitié précalculées
  timeline: POPCORN_SHOTGUN_TIMELINE,
  burstParent: worldScene,           // bouffée au canon visible aussi en TP (optionnel)
});
const mount = createWeaponMount("PopcornShotgunTPMount", PopcornShotgunProfile.tpMount);
character.getObjectByName("Weapon_R")!.add(mount);
mount.add(remote.object);
```

- `PotatoCharacter` joue les clips du profil comme pour le HexSniper :
  - `tpClips.hold` et `tpClips.run` ;
  - les actions `tpClips.actions.fire`, `fireLast` et `reload` ;
  - le trio de visée `POPCORN_TP_AIM_CLIPS` (`aim`, `raise`, `lower`) ;
  - le masque `upperBodyMask` pour le mélange avec les jambes.
- Quand le serveur annonce un tir ou une recharge, appelle **la même frame** :
  - `remote.playRemote("fire" | "reload")` ;
  - l'action TP sur le perso : `reload`, ou pour un tir `fireLast` si `remote.ammo === 0` juste après `playRemote("fire")` (dernier coup), sinon `fire`.
- `remote.update(dt)` à chaque frame. `remote.setAmmo(n)` pour resynchroniser.
- `playRemote` ne refuse jamais une action pour une munition locale désynchronisée : le serveur a raison.

---

## 6. Gameplay : la dispersion (à implémenter, référence dans `PopcornSpread.ts`)

Le pack ne fait **aucun gameplay** : il n'y a pour l'instant ni dispersion ni dégâts. Le comportement voulu est celui d'un vrai fusil à pompe : plus on est près, plus il y a de popcorns qui touchent. On doit quand même pouvoir toucher à moyenne portée.

`PopcornSpread.ts` fournit un point de départ testé :

- **Pattern :** 12 plombs.
  - 1 au centre ;
  - 5 sur un anneau à **1,6°** ;
  - 6 sur un anneau à **3,4°**.

  Le motif tourne au hasard à chaque tir, avec un petit bruit par plomb (écart-type 0,25°). Cône max ≈ 3,5°.
- **Déterministe :** `pelletDirections(forward, up, seed, out)`. La même `seed` donne les mêmes 12 directions sur le serveur et sur tous les clients. Envoie la seed avec l'événement de tir.
- **Raycasts :**
  - depuis la **caméra de jeu** (centre de l'écran), pas depuis le canon ;
  - portée max `MAX_RANGE` = 40 m ;
  - ignore le joueur qui tire.

  Les meshes de l'arme et des popcorns ne sont jamais touchés par les raycasts (`raycast` neutralisé).
- `forward` et `up` sont les axes **monde** de la caméra :

  ```ts
  gameCamera.getWorldDirection(fwd);
  up.set(0, 1, 0).applyQuaternion(gameCamera.quaternion);
  ```

Plombs qui touchent une cible Potato d'environ 0,44 × 0,78 m, visée au centre (moyenne sur 20 000 tirs) :

| Distance | 2 m | 4 m | 5 m | 6 m | 8 m | 10 m | 12 m | 15 m | 20 m | 30 m |
|---|---|---|---|---|---|---|---|---|---|---|
| Plombs sur 12 | 12 | 10,4 | 8,4 | 7,1 | 5,0 | 3,4 | 2,3 | 1,3 | 1,0 | 0,9 |

Adapte avec la vraie taille de tes hitboxes. Pour plus de portée, resserre les anneaux ; pour un tir plus « fusil de chasse », élargis-les.

---

## 7. Dégâts : à toi de les régler, avec 3 règles imposées

Les valeurs exactes sont **ton choix**, mais ces 3 règles doivent être respectées :

1. **De près, c'est un one shot** : un tir au corps à courte portée tue.
2. **Toucher la tête, c'est un one shot.**
3. **De loin, on touche encore, mais beaucoup moins** : quelques plombs, peu de dégâts.

Proposition de départ (`PopcornSpread.ts`) :

- **Un plomb** retire `PV_max × 1/8` × atténuation. Il faut donc 8 plombs à pleine puissance pour tuer.
- **Atténuation `pelletFalloff(d)`** :

  | Distance | Atténuation |
  |---|---|
  | ≤ 8 m | 100 % |
  | 18 m | 50 % |
  | ≥ 28 m | 25 % |

- **`shotDamage(hits, maxHp, currentHp)`** additionne **tous les plombs d'un même tir sur une même cible** et renvoie un seul total. Applique-le **une seule fois** : un seul événement de dégâts, un seul hitmarker, une attribution de kill propre.
- **Tête :** si au moins un plomb touche la zone tête, les dégâts valent au moins les PV restants (`HEADSHOT_ONE_SHOT = true`).
  - Utilise tes hitboxes tête/corps.
  - Si le Potato n'a qu'une seule capsule, ajoute une zone tête.

Résultat avec ces valeurs (cible visée au centre) :

| Distance | Dégâts moyens d'un tir | Tue en 1 tir (corps) |
|---|---|---|
| 2 à 4 m | 130 à 150 % des PV | 100 % |
| 5 m | 105 % | 98 % |
| 6 m | 88 % | 36 % |
| 8 m | 62 % | non : 2 tirs |
| 10 à 12 m | 23 à 39 % | non |
| 15 m | 11 % | non |
| 20 à 30 m | 3 à 6 % (≈ 1 plomb) | non |
| tête, toute distance | ≥ PV restants | **oui** |

Si, en test, un plomb isolé qui touche la tête à très longue distance rend l'arme trop forte, **ne retire pas la règle** : propose-moi plutôt une portée max pour le one shot à la tête.

Côté serveur : c'est lui qui fait foi sur les munitions, la cadence et les dégâts.

- **Cadence :** au moins 0,58 s entre deux tirs.
- **Munitions :** 2 coups.
- **Recharge :**
  - les munitions ne comptent qu'à 1,75 s ;
  - on peut retirer à partir de 2,06 s.

---

## 8. Visuel des popcorns tirés (référence dans `PopcornProjectiles.ts`)

On doit bien voir que ce sont **de vrais popcorns** qui partent, pas des points blancs, sans que ça coûte cher. Ça se fait dans le code du projet, pas dans Blender.

**Principe**

- **Une seule instance pour tout le monde** (joueur local et joueurs distants) : un `InstancedMesh` de 256 popcorns.
- Il réutilise la **géométrie et le matériau du popcorn du réservoir** (`shotgun.tank.popcornMesh` : 100 triangles, couleurs de sommets). Rien n'est cloné, donc **1 draw call**.
- Aucune allocation par frame, rien à faire quand aucun popcorn n'est en vol. Mesure : environ 0,07 ms par frame avec 256 popcorns en vol.
- Le visuel est **purement cosmétique**. Les dégâts viennent des raycasts du §6/§7, et les popcorns atterrissent exactement sur les points d'impact des raycasts.

**Rendu**

- **Taille :** ≈ 4,5 cm (±18 %), environ 3 fois la taille d'un popcorn du réservoir, pour la lisibilité.
- **Vol :** le popcorn tourne sur lui-même, à 55 m/s, avec une légère flèche (nulle au départ et à l'arrivée).
- **À l'impact :** petit rebond le long de la normale de la surface, puis il rétrécit (0,45 s).
- **Plomb qui ne touche rien :** il disparaît à portée max.

**Branchement**

```ts
import { PopcornProjectiles } from "../weapons/popcorn/PopcornProjectiles";
import { pelletDirections, PELLETS, MAX_RANGE } from "../weapons/popcorn/PopcornSpread";

const projectiles = new PopcornProjectiles(shotgun.tank.popcornMesh, worldScene); // une fois pour le monde

// au tir (après tes raycasts, avec les mêmes directions) :
const from = new THREE.Vector3();
// FP : point monde qui tombe pile sur le pixel du canon du viewmodel (méthode déjà présente dans ViewmodelSystem)
viewmodel.socketWorldForGameCamera(shotgun.muzzle, gameCamera, from);
// TP / joueur distant : remote.muzzle.getWorldPosition(from);
// to[i] = hit.point, ou camPos + dir[i] * MAX_RANGE si rien n'est touché
// normal[i] = hit.face!.normal.clone().transformDirection(hit.object.matrixWorld), ou null si rien n'est touché
projectiles.spawn(from, to, normal);

// chaque frame
projectiles.update(dt);
```

- **Pour les joueurs distants,** recalcule les 12 directions avec la seed reçue, fais des raycasts **visuels** (sans dégâts) depuis leur caméra ou tête, et spawne depuis `remote.muzzle`.
- **Alloue** `to` et `normal` une fois et réutilise-les (12 entrées).

---

## 9. Physique du réservoir (déjà faite, rien à coder)

**Fonctionnement**

- 72 popcorns (36 par tir). Solveur de Verlet par positions dans l'espace local du nœud `Tank`, avec contacts entre popcorns et parois avec frottement.
- Pas fixe de 60 Hz, 3 sous-pas max.
- **Mise en veille** quand plus rien ne bouge : aucun calcul ni upload GPU au repos. Environ 0,05 à 0,15 ms par pas pendant les pops.
- Gravité réelle (inclinaison de l'arme) + inertie des mouvements de l'arme (course, pas chassés, saut, recul). C'est pour ça qu'un réservoir à moitié plein bouge quand on se déplace.
- **FP seulement.** En TP, les dispositions sont précalculées et les pops apparaissent avec une animation d'échelle.
- 2 `InstancedMesh` : popcorn et grains. L'arme complète fait 6 draw calls de meshes + 2 instanciés.

**Réglages**

| Réglage | Valeur par défaut |
|---|---|
| `shotgun.tank.inertiaScale` | 0,45 |
| `shotgun.tank.maxInertiaG` | 2,2 |
| `shotgun.tank.sim.friction` | 0,55 |

---

## 10. Checklist de vérification

**FP**

- [ ] À l'équipement, le clip Equip se joue.
- [ ] Le bras gauche est **droit** et la main reste collée à la pompe (hold, course, visée, tir).
- [ ] 2 tirs : le réservoir passe de plein à moitié, puis à vide. Au 2e tir, pas de coup de pompe (FireLast).
- [ ] 3e clic : `onDryFire`.
- [ ] Recharge : couvercle ouvert d'une pichenette, grains saupoudrés, couvercle fermé, pops en crescendo, pompe.
- [ ] `canFire` repasse à `true` à 2,06 s.
- [ ] Changer d'arme avant 1,75 s de recharge : munitions inchangées. Après 1,75 s : réservoir plein.
- [ ] Inspection à une main, sans traversée.
- [ ] En courant ou en sautant, les popcorns bougent dans le réservoir, puis se calment. Au repos, plus aucun coût.

**TP**

- [ ] Arme **droite** en hold, visée, course, tir et recharge ; bras non tordus ; main gauche à l'arrière de la pompe.
- [ ] Plus de gros pli sur le ventre, surtout côté droit.
- [ ] Tir et recharge distants synchronisés : clip du perso et clip de l'arme la même frame.
- [ ] Les **autres armes** en TP sont toujours correctes avec le nouveau `Potato_TP_Character.glb`.

**Gameplay et visuel**

- [ ] 2 à 4 m au corps : one shot.
- [ ] Tête : one shot.
- [ ] 10 à 12 m : 2 à 3 plombs, dégâts partiels.
- [ ] 20 m et plus : environ 1 plomb, dégâts faibles.
- [ ] Les 12 popcorns partent du canon à l'écran et atterrissent sur les impacts des raycasts.
- [ ] On reconnaît bien des popcorns.
- [ ] +1 draw call (`renderer.info.render.calls`).
- [ ] Même seed : mêmes plombs sur le serveur et sur tous les clients.
- [ ] `tsc` passe, aucune erreur console, aucun asset 404 en `vite build` + `preview`.

À la fin, fais-moi un récapitulatif :

- où tu as rangé chaque fichier ;
- ce que tu as modifié dans le projet ;
- les valeurs de dégâts et de dispersion retenues ;
- ce qui reste à régler.
