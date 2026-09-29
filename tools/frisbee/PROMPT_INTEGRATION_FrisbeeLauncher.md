# Prompt pour Cline : intégrer le Lance-Frisbee

## 0. Contexte et mission

Tu travailles sur mon jeu three.js (r169, TypeScript, Vite), avec des personnages « Potato ». Des armes sont déjà intégrées et servent de référence :

- le **HexSniper** : `HexSniperProfile.ts`, `WeaponProfile_HexSniper.json`, `ViewmodelSystem`, `FPArmsRig`, `WeaponProfile.ts` ;
- le **Popcorn Shotgun** : `PopcornShotgunController`, son profil, ses **projectiles**, son branchement réseau, ses sons, son HUD… ;
- le **Paintball Rifle** et le **FAMAS à eau** (s'ils sont déjà intégrés) : même famille de pack que celui-ci.

**Ta mission :** intégrer une nouvelle arme, le **Lance-Frisbee** (`FrisbeeLauncher`), **en t'inspirant du Popcorn Shotgun** pour tout le branchement, et en particulier pour les **projectiles** (le Lance-Frisbee tire de vrais projectiles, pas du hitscan).

- **Avant d'écrire du code, relis comment le Popcorn Shotgun est intégré :**
  - où son profil est enregistré, comment il entre dans l'inventaire / la sélection d'arme ;
  - comment les entrées (tir, recharge, inspection) arrivent au contrôleur ;
  - comment ses projectiles sont créés, simulés, synchronisés entre serveur et clients, et comment une touche est décidée ;
  - quels messages réseau il envoie et reçoit ;
  - comment l'arme est accrochée au perso TP et comment le perso joue ses clips ;
  - où sont joués ses sons et où est mis à jour le HUD des munitions ;
  - comment les dégâts sont appliqués, comment la tête est détectée, et s'il existe déjà un **knockback** (impulsion sur un joueur).
- **Reproduis le même schéma pour le Lance-Frisbee.** Mêmes dossiers, mêmes conventions de nommage, mêmes points d'entrée. **Les différences sont listées au §1.3.** Ne réinvente rien de ce qui existe déjà.

### Règles

- **Pas de modification** de `ViewmodelSystem.ts`, `FPArmsRig.ts` ni `WeaponProfile.ts`.
- **Pas de réexport des GLB** (Blender, gltf-transform, optimiseurs…). Ne change ni leur échelle ni les noms de nœuds : les clips, les sockets et les disques de la cage en dépendent.
- **Aucune nouvelle dépendance :** seulement `three`.
- **`tsc` doit passer.** Les modules du pack ont été vérifiés en `strict`, `noUnusedLocals`, `noUnusedParameters` et `erasableSyntaxOnly`.

---

## 1. L'arme

### 1.1 En une phrase

Une **arbalète cartoon** (turquoise, crème, orange et bleu marine) **tenue à deux mains**, qui lance des **frisbees** avec une corde élastique. Un disque est posé sur le pont, une **cage de 5 disques** est accrochée dessous. Après chaque tir, le personnage **réarme tout seul** : il tire la corde en arrière, prend un disque dans la cage et le pose sur le pont. Les frisbees **volent, rebondissent** sur les murs et font **des dégâts + un petit recul**.

### 1.2 Fiche technique

| | |
|---|---|
| Type | arbalète **à deux mains**, **projectile** (frisbee simulé, pas hitscan) |
| Tir | **un disque par appui**, lancé à **34 m/s** depuis l'œil. Puis **réarmement automatique** (1,58 s) : tir suivant possible à **1,50 s**. |
| Munitions | **1 disque sur le pont + 5 dans la cage = 6**. Le dernier disque tiré, l'arme reste vide. |
| **Dégâts** | **proposition : 45 au corps, ×1,5 à la tête (68), ×0,6 après un rebond sur un mur (27 / 41)**. Pas de dégâts sous 8 m/s ni après 3 rebonds. Voir §7 : **à valider avec moi**. |
| **Recul (knockback)** | **2,5 m/s** horizontal dans le sens du disque **+ 0,8 m/s** vers le haut, sur le joueur touché. Le disque rebondit mollement sur lui (une seule touche par disque). |
| Vol | plane (lift 0,8 tant qu'il est rapide), léger freinage, **rebondit** (3 rebonds max), perd son lift après le 1er rebond, se pose au sol et disparaît. Durée de vie 3,5 s. |
| Dispersion | 0,6° à la hanche, 0,15° en visée |
| Recharge | **changement de cage** : 1,40 s si le pont est chargé (`reload`), 2,48 s s'il est vide (`reloadEmpty` = cage + réarmement). La cage vide est **jetée** : elle tombe et reste un moment au sol, elle ne disparaît jamais à l'écran. |
| Inspection | à deux mains, 3,6 s, même style que les autres armes : flanc gauche, puis le pont vu d'en haut |

Avec 100 PV (valeurs proposées) : 2 disques au corps = 90, pas de kill ; 1 tête + 1 corps = 113, kill. Un rebond sur un mur puis une tête = 41.

### 1.3 Ce qui change par rapport au Popcorn Shotgun

| Popcorn Shotgun | Lance-Frisbee |
|---|---|
| Plusieurs projectiles par tir | **Un seul disque** par tir, lourd et lent à réarmer |
| Recharge classique | **Réarmement automatique après chaque tir** (corde tirée, disque pris dans la cage, posé sur le pont) + **recharge = changer la cage** |
| Projectiles qui s'arrêtent à l'impact | **Le frisbee rebondit** sur le décor (3 fois), ses dégâts baissent après un rebond |
| Dégâts seuls | **Dégâts + petit recul** (impulsion sur le joueur touché) |
| Munitions = un compteur | **Munitions visibles** : le disque du pont + les disques de la cage (qui remontent quand on en prend un) |

---

## 2. Fichiers : je les dépose dans `assets/`, à toi de les ranger

Je vais mettre tous les fichiers du pack dans le dossier `assets/` du projet, peut-être en vrac. **À toi de les ranger** aux bons endroits, **comme ceux du Popcorn Shotgun** (normalement `src/game/profiles/` et `src/assets/potato/`).

| Fichier | Destination | Rôle |
|---|---|---|
| `FrisbeeLauncher_Weapon.glb` | `src/assets/potato/` | l'arme (cage et disques compris) |
| `FrisbeeLauncher_FP_Poses.glb` | `src/assets/potato/` | 14 clips FP (animations seules) |
| `FrisbeeLauncher_TP_Poses.glb` | `src/assets/potato/` | 9 clips TP (animations seules) |
| `WeaponProfile_FrisbeeLauncher.json` | `src/assets/potato/` | montages, clips, timelines, données des disques |
| `FrisbeeLauncherProfile.ts` | à côté de `HexSniperProfile.ts` | `WeaponViewProfile` + `FRISBEE_LAUNCHER_TP_AIM_CLIPS` + `FRISBEE_LAUNCHER_TIMELINE` |
| `FrisbeeLauncherController.ts` | à côté des fichiers du Popcorn Shotgun, ex. `src/game/weapons/frisbee/` | contrôleur de présentation (tir, réarmement, cage, recharge, inspection) |
| `FrisbeeProjectiles.ts` | même dossier | simulation des frisbees (`FrisbeeSim`, partagée serveur / clients) + visuels |
| `FrisbeeLauncherGameplay.ts` | même dossier | gameplay de référence : capacité, dispersion, seed, dégâts proposés |
| `DroppedCages.ts` | même dossier | les cages vides jetées pendant la recharge (copie monde qui tombe, se couche au sol puis s'enfonce ; cosmétique) |
| `INTEGRATION.md` | `docs/` ou à côté du contrôleur | doc technique détaillée |
| `_authoring/`, `renders/`, `preview/` | **hors de `src/`** (ex. `tools/frisbee/`) ou pas du tout | pipeline de création, images, page de test : **ne pas embarquer dans le build** |

- **Perso TP.** Le paquet ne contient **pas** `Potato_TP_Character.glb`. Il faut celui livré avec le Popcorn Shotgun (flancs et aisselles corrigés) : vérifie qu'il est bien en place.
- **Noms.** Garde les noms de fichiers exacts : le JSON les référence.
- **Imports du profil.** `FrisbeeLauncherProfile.ts` importe les assets comme `HexSniperProfile.ts` (`../../assets/potato/<fichier>?url` pour les GLB, le JSON en import direct, le type depuis `./WeaponProfile`). Si tu ranges ailleurs, corrige ces chemins relatifs.

---

## 3. Ce que contient le pack (pour comprendre l'arme)

### 3.1 Le modèle (`FrisbeeLauncher_Weapon.glb`)

- Modélisé **dans Blender** d'après mon image de référence (arbalète turquoise, panneaux crème, bouts orange, corde bleu marine, gros disque orange sur le pont, cage de disques dessous), en plus propre : low-poly, **couleurs de sommets**, ~5 600 triangles, 1 matériau. Même poignée pistolet, même gâchette et même main droite que le Paintball Rifle (mêmes montages) ; poignée avant verticale pour la main gauche.
- Conventions du HexSniper : racine `FrisbeeLauncher` à l'**échelle 0,19** (garde-la), avant = **−X**, haut = **+Y**. Les matrices de montage (FP ×0,40, TP ×0,35) sont dans le profil : applique-les **une seule fois**.

| Nœud | Rôle |
|---|---|
| `Body` | tout le statique : quille, rail, pont, crosse squelette, poignées, guidon |
| `Trigger` | gâchette (pivot +Z) |
| `LimbL` / `LimbR` | branches de l'arc (pivot +Y), qui plient quand la corde est tendue ; `LimbTipL/R` = bout des branches |
| `CordL` / `CordR` | cordes élastiques (mesh unité le long de +X ; échelle X = longueur bout de branche → chariot) |
| `Sled` | le chariot qui pousse le disque ; `SledHandle` (poignée en T que la main gauche tire), `SledGrabSocket(TP)` |
| `DiscDeck` | le disque chargé sur le pont (échelle 0 quand le pont est vide). **Son mesh sert de modèle aux frisbees en vol.** |
| `DiscHand` | le disque dans la main gauche pendant le réarmement |
| `Cage` + `CageDisc0..4` | la cage (ouverte sur le côté gauche) et ses 5 disques ; `CageDisc0` = celui du haut (le prochain). Visibles selon `cageCount` (piloté par le contrôleur). Pendant la recharge : jetée (FP : sort de l'écran avant d'être masquée ; TP : remplacée par la copie monde de `DroppedCages`), la nouvelle sort de la poche de ceinture (échelle 0,3 → 1 en 0,06 s, interpolée). |
| `LaunchSocket` | avant du pont. **C'est de là que part le frisbee visible.** |
| `GripSocket` · `ForegripSocket` | main droite · main gauche |

**Clips de l'arme** : `Idle`, `IdleEmpty`, `Fire` (tir + réarmement), `FireLast`, `Reload`, `ReloadEmpty`, `Reload_TP`, `ReloadEmpty_TP`, `Inspect`, `InspectEmpty`, `Equip`, `EquipEmpty`.

### 3.2 Animations FP (`FrisbeeLauncher_FP_Poses.glb`)

14 clips pour `Potato_FP_CommonArms` :

`FP_FrisbeeLauncher_Hold`, `FP_FrisbeeLauncher_Run`, `FP_Aim_FrisbeeLauncher`, `FP_Raise_FrisbeeLauncher`, `FP_Lower_FrisbeeLauncher`, `FP_Fire_FrisbeeLauncher`, `FP_FireAim_FrisbeeLauncher`, `FP_FireLast_FrisbeeLauncher`, `FP_FireLastAim_FrisbeeLauncher`, `FP_Reload_FrisbeeLauncher`, `FP_ReloadEmpty_FrisbeeLauncher`, `FP_Inspect_FrisbeeLauncher`, `FP_Equip_FrisbeeLauncher`, `FP_Unequip_FrisbeeLauncher`.

- **À deux mains** : main droite sur la poignée pistolet, main gauche sur la poignée avant. Le pont, le disque et la cage sont visibles en bas à droite.
- **Tir (`fire` / `fireAim`, 1,58 s)** : la corde claque, le chariot part vers l'avant (les branches vibrent), le disque est lancé. Puis la main gauche **attrape la poignée du chariot et le tire en arrière** jusqu'au loquet (les cordes se tendent, clic à 0,70 s), **prend le disque du haut de la cage** par le côté gauche (0,95 s), le monte et **le pose sur le pont** (1,29 s), puis revient sur la poignée avant. L'arme pivote pour montrer chaque geste.
- **`fireLast`** (cage vide) : le tir sans réarmement, l'arme reste vide.
- **Recharge `reload` (1,40 s)** : la main gauche tire la cage vide vers le bas et **la jette** (0,45 s) : on la voit tomber et sortir de l'écran par le bas. Tout le bras gauche **glisse vers le bas, hors de la vue** (de 0,53 à 0,87 s on ne voit ni la main ni la manche), la cage pleine apparaît dans sa main hors écran (0,78 s), il la remonte par le bas et l'enclenche (clic à 1,10 s). **Aucun objet ne disparaît ni n'apparaît à l'écran.**
- **`reloadEmpty` (2,48 s)** : la même chose, puis le réarmement.
- Bras résolus sous limites naturelles (poignets et avant-bras dans leur plage, coudes vers le bas, bras gauche qui entre et sort par le bas de l'écran), sans à-coups.
- **Inspection (3,6 s)** à deux mains, même style que les autres armes. Equip / Unequip : le bras gauche monte depuis le bas (bras le long du corps) jusqu'à la poignée avant.

### 3.3 Animations TP (`FrisbeeLauncher_TP_Poses.glb`)

9 clips pour `Potato_TP_Character` : `TP_Hold_FrisbeeLauncher`, `TP_Run_FrisbeeLauncher`, `TP_Aim_FrisbeeLauncher`, `TP_Raise_FrisbeeLauncher`, `TP_Lower_FrisbeeLauncher`, `TP_Fire_FrisbeeLauncher` (tir + réarmement, one-shot), `TP_FireLast_FrisbeeLauncher`, `TP_Reload_FrisbeeLauncher`, `TP_ReloadEmpty_FrisbeeLauncher`.

- Arme **à deux mains**, droite devant, à hauteur de poitrine. Même timeline que la FP : réarmement et changement de cage visibles. La cage vide est lâchée à 0,45 s : **une copie monde prend le relais** (même pose, même vitesse), tombe par terre à côté du joueur, roule, se couche et s'enfonce dans le sol au bout de 6 s. La main va à la poche de ceinture (hanche gauche) et en sort la cage pleine.
- `upperBodyMask` (dans le profil) : bras, mains, doigts, `Spine_1`, `Weapon_R`.

---

## 4. Vue FP (joueur local)

```ts
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { FrisbeeLauncherProfile, FRISBEE_LAUNCHER_TIMELINE } from "../profiles/FrisbeeLauncherProfile";
import { FrisbeeLauncherController } from "../weapons/frisbee/FrisbeeLauncherController";

const gltf = await new GLTFLoader().loadAsync(FrisbeeLauncherProfile.weaponUrl);   // à mettre en cache (FP + TP)
const launcher = new FrisbeeLauncherController(gltf, {
  firstPerson: true,
  timeline: FRISBEE_LAUNCHER_TIMELINE,
  events: { /* §6 */ },
  // recoil: 0.06,             // secousse cosmétique du viewmodel au tir
});
launcher.attachViewmodel(viewmodel);
await viewmodel.equip(FrisbeeLauncherProfile, launcher.object, { playEquipClip: true });
```

Ordre **par frame** :

```ts
viewmodel.update(dt, input);
viewmodel.syncCamera(gameCamera);
launcher.update(dt);         // APRÈS syncCamera
frisbees.update(dt);         // §8 : tous les frisbees en vol
// rendu du monde, puis viewmodel.render(renderer)
```

**API du contrôleur (présentation seulement, aucun gameplay)**

| Membre | Rôle |
|---|---|
| `fire(aiming = false): boolean` | **Lance le disque du pont maintenant** (`onShot(aiming)` pendant l'appel), puis réarme si la cage a un disque (`fire` / `fireAim`), sinon `fireLast`. Renvoie `false` (et `onDryFire`) si le pont est vide. |
| `canFire` | disque sur le pont, et au repos ou après `readyToFire` du réarmement / de la recharge |
| `reload(): boolean` · `canReload` | changement de cage (`reload` ou `reloadEmpty` selon le pont). Refusé si la cage est pleine **et** le pont chargé. |
| `cancelAction()` (alias `cancelReload()`) | changement d'arme ou mort. Recharge : avant `cageIn` la cage d'avant est rendue, après la nouvelle cage reste (le disque déjà pris retourne dans la cage). Réarmement : terminé tout de suite (le disque finit sur le pont). |
| `inspect(): boolean` | inspection (3,6 s), refusée pendant un tir / une recharge |
| `setAmmo(deckLoaded, cageCount)` | synchro réseau ou respawn (instantané) |
| `ammo` · `capacity` (= 6) · `deckLoaded` · `cageCount` · `cageCapacity` (= 5) · `reloading` · `busy` · `currentAction` | état |
| `launchSocket` | nœud `LaunchSocket` (départ visuel du frisbee) |
| `discTemplate` | le mesh du disque, pour `FrisbeeProjectiles` |
| `cageTemplate` | la cage + ses disques à l'identité, pour `DroppedCages` |
| `playRemote(action, state)` | TP : rejouer une action décidée par le serveur (§5) |
| `dispose()` | si tu ne gardes pas l'instance au déséquipement |

---

## 5. Vue TP (joueurs distants)

```ts
const remote = new FrisbeeLauncherController(gltf, {
  firstPerson: false, timeline: FRISBEE_LAUNCHER_TIMELINE,
  events: {
    onShot: () => spawnRemoteDiscVisual(remote),                 // §8 : le frisbee visible part de remote.launchSocket
    onCageDrop: (d) => { if (d.world) droppedCages.spawn(d.world, d.velocity, d.discs); },   // §8.2 : la cage jetée
  },
});
const mount = createWeaponMount("FrisbeeLauncherTPMount", FrisbeeLauncherProfile.tpMount);
character.getObjectByName("Weapon_R")!.add(mount);
mount.add(remote.object);
```

- **Clips du perso.** `PotatoCharacter` joue `tpClips.hold` / `run`, le trio `FRISBEE_LAUNCHER_TP_AIM_CLIPS` et les actions `fire`, `fireLast`, `reload`, `reloadEmpty` (**one-shot, pas des boucles**), avec `upperBodyMask`.
- **Tir reçu du serveur :** `remote.playRemote("fire", { aiming, cage })` où `cage` = disques dans la cage du tireur **au moment du tir**, et l'action TP `fire` (si `cage > 0`) ou `fireLast` sur le perso, **la même frame**.
- **Recharge :** `remote.playRemote("reload", { cage, deckLoaded })` et l'action TP `reload` (pont chargé) ou `reloadEmpty`, la même frame. Le contrôleur prend tout seul les clips arme `Reload_TP` / `ReloadEmpty_TP`.
- `remote.update(dt)` à chaque frame, **après** l'animation du perso **et** son `updateMatrixWorld` (le contrôleur lit la position monde de la cage pour la passer à la copie jetée) ; `remote.setAmmo(deck, cage)` pour resynchroniser.

---

## 6. Événements et sons

| Action | Durée | Événements (s) |
|---|---|---|
| `fire` | 1,58 | `shot` 0 · `cocked` 0,70 · `discTaken` 0,95 · `discSeated` 1,29 · `readyToFire` 1,50 |
| `fireLast` | 0,50 | `shot` 0 · `readyToReload` 0,25 |
| `reload` | 1,40 | `cageOut` 0,40 · `cageDrop` 0,45 · `cageSwap` 0,71 · `cageIn` 1,10 · `readyToFire` 1,30 |
| `reloadEmpty` | 2,48 | `cageOut` 0,40 · `cageDrop` 0,45 · `cageSwap` 0,71 · `cageIn` 1,10 · `cocked` 1,60 · `discTaken` 1,85 · `discSeated` 2,19 · `readyToFire` 2,40 |

**Callbacks** (branche les sons comme pour le Popcorn Shotgun)

| Callback | Son suggéré |
|---|---|
| `onShot(aiming)` | « twang » grave de corde élastique + souffle du disque. **Projectile + réseau + HUD ici.** |
| `onDryFire()` | petit clic de gâchette |
| `onCocked()` | cliquetis du loquet (clic-clac) |
| `onDiscTaken()` | glissement plastique ; HUD : un disque de moins dans la cage |
| `onDiscSeated()` | « clac » plastique ; HUD : pont chargé |
| `onCageOut()` · `onCageIn()` | déclic + glissement · gros clic d'enclenchement ; HUD : cage pleine |
| `onCageDrop({ world, velocity, discs })` | la cage vide est jetée : TP → `droppedCages.spawn(...)` ; FP → `droppedCages.spawnAt(...)` (§8.2). Son : clac plastique quand elle touche le sol (~0,3 s après). |
| `onReloadEnd(cancelled)` | — |
| `frisbees` `onBounce(id, point, normal, speed)` | « tok » plastique, plus fort si rapide |
| `frisbees` `onHit(e)` | son de touche (boing mou) + hitmarker |

---

## 7. Gameplay : **projectile**, rebonds, dégâts et recul

Le pack ne contient **aucun gameplay réseau** : c'est à toi de le coder, en suivant le **Popcorn Shotgun** pour les projectiles, le réseau, l'autorité serveur et la détection de la tête. Les valeurs sont dans `FrisbeeProjectiles.ts` (`FRISBEE_TUNING`) et `FrisbeeLauncherGameplay.ts`.

- **C'est un projectile.** Au tir, le serveur crée un `FrisbeeSim` (dans `FrisbeeProjectiles.ts`, **sans rendu**, utilisable côté serveur) avec `origin` = l'**œil** du tireur, `direction` = `discDirection(forward, up, aiming, seed, out)`. Pas fixe **1/120 s**, déterministe : même monde + même tir = même trajectoire chez tout le monde.
- **Horloge.** Côté serveur, appelle `sim.step()` au rythme du tick serveur (120 pas/s, rattrape les pas en retard). Côté client, `frisbees.update(dt)` garde la dette de temps (pas de temps perdu sur une saccade : il rattrape en quelques frames), donc les disques restent sur la même horloge que le serveur.
- **Collision.** `FrisbeeSim.step(cast, events)` appelle **ta** fonction `cast(from, dir, maxDist, radius, ignore)` : une **sphère de 0,12 m** qui avance (reprends la collision des projectiles du Popcorn Shotgun). Elle renvoie `{ distance, point, normal, target?, headshot? }` : `target` = un joueur (touche), sinon décor (rebond). **N'y mets jamais le tireur** (`ignore`), ni les armes, ni les frisbees.
- **Dégâts (proposition à me faire valider) : 45 corps, 68 tête (×1,5), ×0,6 après au moins un rebond sur le décor.** Pas de dégâts si le disque va à moins de 8 m/s ou après 3 rebonds. **Une seule touche par disque.** Si le projet a une autre échelle de PV, demande-moi avant de changer.
- **Recul (knockback) :** `onHit` donne `e.impulse` (m/s, monde) = 2,5 m/s horizontal dans le sens du disque + 0,8 m/s vers le haut. **Ajoute-le à la vitesse du joueur touché sur le serveur** (même mécanisme qu'un knockback existant s'il y en a un ; sinon une impulsion simple sur la vitesse, amortie par le contrôleur de déplacement). C'est un **petit** recul (~0,5 m) : pas d'étourdissement, pas de perte de contrôle.
- **Autorité.** Le serveur simule, décide des touches, applique dégâts + recul et renvoie les résultats (touche : id, dégâts, tête, impulsion ; fin de vie du disque). Les clients simulent **le même disque** pour l'affichage (même seed, même `FrisbeeSim`) et corrigent si le serveur dit autre chose.
- **Munitions côté serveur :** pont (0/1) + cage (0..5). Tir refusé si le pont est vide ou avant `readyToFire` (1,50 s après le tir précédent). Après un tir, le pont est rechargé à `discSeated` (1,29 s) si la cage avait un disque. Recharge : cage = 5 à `cageSwap` (0,71 s) ; `reloadEmpty` recharge aussi le pont à 2,19 s. Annulation (changement d'arme, mort) : avant `cageIn` rien ne change ; après, la cage est pleine et le pont reste vide si `discSeated` n'est pas passé (le disque pris retourne dans la cage). Un réarmement interrompu (changement d'arme pendant le cycle de tir) est **terminé** : le disque est sur le pont.
- **Feedback immédiat** (hitmarker, son de touche) à la réception du résultat serveur, ou en prédiction locale comme le Popcorn Shotgun.

Boucle locale minimale :

```ts
if (triggerPressedThisFrame) launcher.fire(isAiming);   // → onShot : projectile local + message réseau
if (reloadPressed) launcher.reload();
if (inspectPressed) launcher.inspect();
onWeaponSwitch(() => launcher.cancelAction());
```

---

## 8. Visuel : **le frisbee doit se voir partir du lance-frisbee**, la cage jetée doit tomber

Tout est déjà codé et testé dans `FrisbeeProjectiles.ts` et `DroppedCages.ts`. À toi de le brancher **pour tous les joueurs**.

### 8.1 Frisbees en vol

```ts
import { FrisbeeProjectiles } from "../weapons/frisbee/FrisbeeProjectiles";
import { discDirection } from "../weapons/frisbee/FrisbeeLauncherGameplay";

// une instance pour la partie (tous les joueurs), avec la collision du jeu :
const frisbees = new FrisbeeProjectiles(worldScene, launcher.discTemplate, sweptSphereCast, {
  onHit: (e) => { /* client : hitmarker / son ; le serveur décide des dégâts */ },
  onBounce: (id, point, normal, speed) => playBounceSound(point, speed),
}, { visualRadius: 0.1 });

// tir local (dans onShot) :
const tmp = new THREE.Vector3();
const dir = discDirection(camForward, camUp, aiming, seed, new THREE.Vector3());
frisbees.fire({
  origin: gameCamera.position.clone(), direction: dir, owner: localPlayer, seed, roll: aiming ? 0 : -0.1,
  visualFrom: viewmodel.socketWorldForGameCamera(launcher.launchSocket, gameCamera, tmp).clone(),   // FP : le pont du viewmodel
});
// tir distant : origin = œil du tireur (message serveur), visualFrom = remote.launchSocket.getWorldPosition(new THREE.Vector3())
```

- **La simulation part de l'œil** (comme le serveur), **le disque qu'on voit part du lance-frisbee** et rejoint la trajectoire en ~0,1 s : en FP on le voit quitter le pont, en TP il part de l'arme des autres joueurs.
- Le disque tourne (7 tours/s), penche avec l'arme au départ, oscille un peu, tangue après un rebond ; **traînée** courte et discrète (additive, apparaît après 0,03 s pour ne pas faire de « rayon » devant la caméra) ; **anneau** à chaque impact.
- `visualRadius` 0,1 m (un peu plus grand que le disque réel du modèle TP pour bien se lire de loin) : ne le change pas sans me demander.
- Coût : 2 draw calls par disque en vol, 24 disques max pour toute la partie (`max`). `frisbees.clear()` au changement de manche.

### 8.2 Les cages jetées pendant la recharge (ne doivent jamais disparaître à l'écran)

```ts
import { DroppedCages } from "../weapons/frisbee/DroppedCages";

// une instance pour la partie (les cages de tous les joueurs), avec la hauteur du sol du jeu
const droppedCages = new DroppedCages(worldScene, launcher.cageTemplate, {
  ground: (x, z) => groundHeightAt(x, z),     // raycast vers le bas sur le décor (défaut : y = 0)
});

// TP (joueurs distants) : la copie monde reprend exactement la pose et la vitesse du nœud Cage
onCageDrop: (d) => { if (d.world) droppedCages.spawn(d.world, d.velocity, d.discs); }

// FP (joueur local) : le clip fait déjà sortir la cage de l'écran par le bas ; on pose une copie sous la vue
// (à gauche des pieds) pour que le joueur la retrouve au sol s'il regarde par terre
onCageDrop: (d) => {
  const fwd = camForwardFlat, right = new THREE.Vector3(-fwd.z, 0, fwd.x);
  const p = gameCamera.position.clone().addScaledVector(right, -0.22).addScaledVector(fwd, 0.18); p.y = feetY + 0.42;
  const v = right.clone().multiplyScalar(-0.6).addScaledVector(fwd, 0.4).setY(-1.0);
  droppedCages.spawnAt(p, new THREE.Quaternion().setFromAxisAngle(fwd, 0.5), v, d.discs);
}
droppedCages.update(dt);   // à chaque frame
```

- **Physique simple et cosmétique** : gravité, petit rebond, elle se couche sur le côté (ou reste debout), 6 s au sol puis elle s'enfonce en 1,2 s. Elle garde les disques qui y restaient. Pas de réseau.
- `droppedCages.clear()` au changement de manche. 12 cages max (les plus anciennes partent). 1 draw call par cage (+ ses disques).

---

## 9. HUD

- Munitions = **1 disque sur le pont + 5 dans la cage**. Affiche-les comme le Popcorn Shotgun affiche les siennes (par exemple un gros disque pour le pont + 5 petits pour la cage). Mets à jour sur `onShot`, `onDiscTaken`, `onDiscSeated`, `onCageIn`, `onReloadEnd`.

---

## 10. Checklist de vérification

**Intégration**

- [ ] Fichiers rangés comme ceux du Popcorn Shotgun, arme sélectionnable comme lui, `tsc` OK, aucun asset 404 en `vite build` + `preview`.

**FP**

- [ ] À l'équipement, le clip Equip se joue ; l'arme est tenue **à deux mains** (main gauche sur la poignée avant).
- [ ] Un appui = **un frisbee** qui part du pont ; les cordes claquent, le chariot part en avant, les branches vibrent.
- [ ] Juste après, **réarmement automatique** : la main gauche tire le chariot en arrière (clic), prend un disque sous l'arme dans la cage, le pose sur le pont, revient sur la poignée avant. Tir suivant possible à 1,50 s.
- [ ] Les disques de la cage **remontent d'un cran** quand on en prend un ; le HUD suit.
- [ ] Dernier disque : pas de réarmement, l'arme reste vide ; clic à vide ensuite.
- [ ] Recharge : cage vide tirée vers le bas et **jetée** — on la voit tomber et sortir de l'écran par le bas, **elle ne disparaît jamais sur place** ; le bras gauche sort de la vue par le bas (aucune manche ne traverse l'écran) et remonte avec la cage pleine, qui arrive par le bas ; si le pont était vide, le réarmement suit.
- [ ] En regardant par terre juste après une recharge, la cage vide est au sol à gauche, puis s'enfonce au bout de quelques secondes.
- [ ] Changer d'arme pendant la recharge avant `cageIn` : munitions inchangées ; pendant le réarmement : le disque est sur le pont en revenant.
- [ ] Aucun poignet tordu, aucun bras en crochet, pas d'à-coup de la main gauche.

**TP**

- [ ] Arme à deux mains, droite devant ; tir + réarmement et changement de cage visibles, synchronisés avec le tireur.
- [ ] Recharge TP : la cage vide lâchée **continue sa chute** jusqu'au sol (pas de saut, pas de disparition), roule et se couche ; la cage pleine sort de la poche à la hanche.

**Projectile, dégâts, recul**

- [ ] Le frisbee **vole** (34 m/s, plane), **rebondit** sur les murs et le sol, se pose puis disparaît.
- [ ] Dégâts **validés avec moi** (proposition 45 / 68 tête / ×0,6 après rebond), une seule touche par disque.
- [ ] Le joueur touché est **poussé un peu** (~0,5 m) dans le sens du disque.
- [ ] Même trajectoire sur le serveur et tous les clients (même seed, pas fixe 1/120 s).
- [ ] **En FP, on voit le frisbee quitter le pont** ; **en TP, on le voit partir de l'arme des autres joueurs.**

---

## 11. À la fin

Fais-moi un récapitulatif :

- où tu as rangé chaque fichier ;
- ce que tu as repris du Popcorn Shotgun et ce que tu as modifié dans le projet (fichiers touchés) ;
- comment tu as branché le réseau (message de tir avec la seed et la cage, simulation serveur, résultats des touches, knockback, recharge, mort) ;
- les dégâts et le recul que tu as mis (et si tu m'as demandé confirmation) ;
- ce qui reste à régler ou à tester à plusieurs joueurs.
