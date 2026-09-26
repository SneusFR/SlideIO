# Popcorn Shotgun — intégration (v5)

Arme à deux mains, 2 coups : réservoir **plein → à moitié → vide**. Recharge : la main gauche ouvre le couvercle d'une pichenette, saupoudre des grains de maïs, referme le couvercle, les grains éclatent (pops), puis on pompe. Pendant la recharge, **l'arme vient vers la main gauche**. Le paquet suit le même schéma que le HexSniper et se branche sur le `ViewmodelSystem` existant, **sans le modifier**.

## Fichiers

| Fichier | À placer dans | Rôle |
|---|---|---|
| `assets/potato/PopcornShotgun_Weapon.glb` | `src/assets/potato/` | Arme (root 0.19, avant = −X), pompe / gâchette / couvercle animés, sockets, gabarits popcorn et grain |
| `assets/potato/PopcornShotgun_FP_Poses.glb` | `src/assets/potato/` | 11 clips FP sur `Potato_FP_CommonArms` (animations seules, mêmes 20 canaux que le HexSniper) |
| `assets/potato/PopcornShotgun_TP_Poses.glb` | `src/assets/potato/` | 8 clips TP sur `Potato_TP_Character` (animations seules) |
| `assets/potato/Potato_TP_Character.glb` | `src/assets/potato/` (**remplace** le tien) | Perso TP identique, seuls les poids de peau du flanc et des aisselles ont été corrigés (506 sommets) |
| `assets/potato/WeaponProfile_PopcornShotgun.json` | `src/assets/potato/` | Matrices de montage FP/TP, clips, timelines d'événements, données du réservoir |
| `profiles/PopcornShotgunProfile.ts` | à côté de `HexSniperProfile.ts` | `WeaponViewProfile` + `POPCORN_SHOTGUN_TIMELINE` |
| `weapons/popcorn/*.ts` | où tu veux (ex. `src/game/weapons/popcorn/`) | Contrôleur, réservoir three.js, solveur physique pur |
| `weapons/popcorn/PopcornSpread.ts` (v5.1) | même dossier | Référence gameplay : 12 plombs déterministes (seed), atténuation, dégâts (tête = one shot) |
| `weapons/popcorn/PopcornProjectiles.ts` (v5.1) | même dossier | Référence visuelle : popcorns tirés, 1 `InstancedMesh` partagé, 1 draw call |
| `PROMPT_INTEGRATION_PopcornShotgun.md` | — | Prompt d'intégration complet (à donner à l'IA / au dev) |

Les imports d'assets de `PopcornShotgunProfile.ts` reprennent exactement les chemins de `HexSniperProfile.ts` (`../../assets/potato/...?url`). Le contrôleur n'importe que `three` et ses deux fichiers voisins.

## Équiper (vue FP, joueur local)

```ts
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { PopcornShotgunProfile, POPCORN_SHOTGUN_TIMELINE } from "../profiles/PopcornShotgunProfile";
import { PopcornShotgunController } from "../weapons/popcorn/PopcornShotgunController";

const gltf = await new GLTFLoader().loadAsync(PopcornShotgunProfile.weaponUrl); // à mettre en cache
const shotgun = new PopcornShotgunController(gltf, {
  firstPerson: true,                     // physique du popcorn activée
  timeline: POPCORN_SHOTGUN_TIMELINE,
  burstParent: viewmodel.scene,          // bouffée de popcorn cosmétique au canon (optionnel)
  events: { onShot, onPumpBack, onPumpForward, onLidOpen, onKernelsIn, onLidClose, onPop, onAmmoRefilled },
});
shotgun.attachViewmodel(viewmodel);
await viewmodel.equip(PopcornShotgunProfile, shotgun.object, { playEquipClip: true });
```

## Ordre par frame

```ts
viewmodel.update(dt, input);      // input.straight = ADS, running, speed…
viewmodel.syncCamera(gameCamera);
shotgun.update(dt);               // APRÈS syncCamera : le réservoir lit la pose monde finale
// rendu monde, puis viewmodel.render(renderer)
```

## Gameplay

```ts
if (firePressed && shotgun.canFire) {
  shotgun.fire();                 // clip bras + clip arme la même frame, consomme 36 popcorns
  spawnPellets(gameCamera);       // tes projectiles / raycasts, depuis la caméra
}
if (reloadPressed) shotgun.reload();
if (inspectPressed) shotgun.inspect();
onWeaponSwitch(() => shotgun.cancelReload()); // avant `ammoRefilled`, la recharge est annulée
```

- `fire()` joue **FP_Fire** (recul + pompe) quand il reste un coup, sinon **FP_FireLast** (recul seul : rien à chambrer, la pompe est actionnée en fin de recharge).
- `canFire` suit les points `readyToFire` des timelines (0,58 s après un tir, 2,06 s dans la recharge).
- Visée : le trio `aim`/`raise`/`lower` du profil est utilisé tel quel par `ViewmodelSystem` (pose au niveau de la hanche, le centre de l'écran reste dégagé).

### Événements (secondes, depuis le début du clip)

| Action | Événements |
|---|---|
| Fire (0,90 s) | shot 0 · pumpBack 0,26 · pumpForward 0,42 · readyToFire 0,58 |
| FireLast (0,55 s) | shot 0 · readyToFire 0,30 |
| Reload (2,20 s) | lidOpen 0,28 · kernelsIn 0,44→0,64 · lidClose 0,88 · pops 0,92→1,75 · ammoRefilled 1,75 · pumpBack 1,80 · pumpForward 1,93 · readyToFire 2,06 |
| Inspect (3,60 s) | une main : la main gauche lâche à 0,12 et reprend la pompe à 3,38 |

**v4 :** `onButtonPress` / `onLidHop` (v3) sont remplacés par `onLidOpen` / `onLidClose`. `onPop` peut tomber jusqu'à 72 fois par recharge (en crescendo) : limite les voix SFX côté audio (environ 25 à 35 par seconde).

## Vue 3e personne (joueurs distants)

```ts
const remote = new PopcornShotgunController(gltf, { firstPerson: false, timeline: POPCORN_SHOTGUN_TIMELINE });
const mount = createWeaponMount("PopcornShotgunTPMount", PopcornShotgunProfile.tpMount);
character.getObjectByName("Weapon_R")!.add(mount);
mount.add(remote.object);
// PotatoCharacter joue tpClips (hold/run + actions fire/fireLast/reload, trio aim : POPCORN_TP_AIM_CLIPS)
// et, LA MÊME FRAME : remote.playRemote("fire" | "reload"); puis remote.update(dt) chaque frame.
```

**Posture TP (v5) : toujours en visée.** Dans tous les clips (hold, visée, course, tir, montée / descente de visée), l'arme pointe droit devant (axe avant du perso, horizontale, sans roulis). Hold et Aim sont presque identiques. Le buste est légèrement de trois-quarts (Spine_1 : −12° de lacet, 4,5° d'inclinaison) pour que le bras gauche, très court, atteigne la pompe. La main gauche tient l'arrière de la pompe : c'est le nœud `OffhandSocketTP` du GLB de l'arme. Pendant la recharge, l'arme ne sort de l'axe que le temps du couvercle et du saupoudrage.

En TP, pas de physique : les dispositions plein / moitié précalculées sont stockées dans le GLB. Les pops apparaissent directement à leur place avec l'animation d'échelle. `upperBodyMask` est fourni pour le mélange avec la locomotion.

## Physique du popcorn (optimisée)

- 72 popcorns (36 par tir). Solveur Verlet par positions dans l'espace local du nœud `Tank`, contacts sphère/sphère (tri-balayage sur X) + parois avec friction.
- Pas fixe de 60 Hz, 3 sous-pas max, **mise en veille** quand plus rien ne bouge : aucun calcul ni upload GPU au repos. Environ 0,05 à 0,15 ms par pas pendant les pops.
- Gravité réelle (inclinaison de l'arme) + inertie de l'arme (différences finies filtrées de la position monde : course, pas chassés, saut, recul). C'est pour ça qu'un réservoir à moitié plein bouge quand tu te déplaces.
- Coût de rendu : 2 `InstancedMesh` (popcorn, grains), soit 2 draw calls quel que soit le remplissage. L'arme complète fait 6 draw calls de meshes + 2 instanciés.
- Réglages : `shotgun.tank.inertiaScale` (0,45), `shotgun.tank.maxInertiaG` (2,2), `shotgun.tank.sim.friction` (0,55).

## Bras gauche (v4) : pourquoi il ne se courbe plus

- **Le vrai problème était la projection à l'écran.** En v3, bras, avant-bras et main faisaient 44°, 23° puis 69° à l'écran (un zigzag), avec le coude plié face à la caméra. Sur le HexSniper, les trois segments sont presque alignés et le coude plie vers la caméra, donc ne se voit pas.
- **Prise de pompe :** la main ajustée en v3 est tournée de 25° autour de l'axe de la pompe (paume un peu plus côté joueur). Les doigts restent enroulés et rien ne traverse la pompe ni le canon.
- **IK :** chaque frame vise un bras **droit à l'écran** (écarts au coude et au poignet ≈ 0°), la torsion du poignet de −5° et celle de l'avant-bras de 7° (les valeurs du HexSniper). Le manchon qui part hors champ ne doit jamais entrer par le côté de l'écran, et le bras monte toujours depuis le bas.
- **Recharge :** les positions de l'arme pour chaque temps fort (pichenette, saupoudrage, couvercle ouvert / à moitié / fermé) ont été résolues en même temps que les deux bras (`_authoring/keypose.py`) : l'arme descend d'environ 4 à 11 cm et pivote vers la main gauche, et l'épaule glisse au plus de 7 cm hors champ.
- Contrôle dans three.js r169 avec ton `ViewmodelSystem` : la main gauche reste sur la pompe à ≤ 0,03 mm sur toutes les frames où elle la tient (≈ 0,8 mm pendant les fondus de 0,02 s au tir). TP (v5) : ≤ 0,2 mm en hold, visée et recharge ; environ 1 à 1,6 mm en tir, en course et pendant les transitions de visée.
- Même échelle que le HexSniper : root 0.19 × montage 0,40 en FP / 0,35 en TP.
- Aucun `.blend` n'était joint : l'arme a été modélisée d'après l'image (low-poly, couleurs de sommets, 2 000 triangles). Le remplissage d'aperçu `Popcorn_Fill` utilise `EXT_mesh_gpu_instancing`.

## Peau du perso TP (v5)

Tenir l'arme droite oblige le bras droit à se lever devant le ventre. Avec les poids d'origine, les sommets du flanc suivaient l'os du bras (jusqu'à 25 %) et de l'épaule (32 %) : un gros pli se formait sur le ventre, côté droit surtout. La visée TP du HexSniper avait le même défaut. Les poids de 506 sommets (flancs, aisselles, des deux côtés) ont été recalculés :
- **Géométrie inchangée :** les positions, la hiérarchie et les os ne bougent pas. Seuls `JOINTS_0` / `WEIGHTS_0` du mesh `potato` changent.
- **Pas de déchirure :** les doublons de couture UV sont soudés et gardent exactement les mêmes poids.
- **Pli mesuré :** sur la pose arme droite, il passe de 15 à 6 mm à droite. Visée HexSniper : de 15 à 7,5 mm. Hold HexSniper : de 9 à 5,5 mm.
- **Retour arrière :** les poids d'origine sont dans `Documents\PopcornShotgun_Blender\io\tp_weights_backup.json` (et `_authoring/weightfix.py` refait le calcul).

## Scène Blender

`Documents\PopcornShotgun_Blender\PopcornShotgun_Anim.blend` (sur ton PC) contient les bras `Potato_FP_CommonArms`, l'arme montée exactement comme en jeu (os `Weapon_R` → `Mount_FP` → arme) et la caméra `Cam_FP` (65° vertical, celle du jeu). Les 11 clips FP sont posés sur une seule timeline à 60 i/s, avec un marqueur par clip : Hold 0, Aim 150, Run 300, Raise 360, Lower 400, Fire 440, FireLast 500, Reload 540, Inspect 700, Equip 940, Unequip 990.

La scène **TP** contient le perso TP (peau corrigée), l'arme montée sur son `Weapon_R` et les 8 clips TP (Hold 0, Aim 150, Run 300, Raise 360, Lower 400, Fire 440, FireLast 500, Reload 540). Les clés sont celles des GLB (une clé par frame, en FK). Le GLB reste produit par le pipeline Python pour garantir les 20 canaux exacts. `psb_tools.py` sert à recharger les clips et à relire tes retouches.

## Régénérer

Le dossier `_authoring/` contient le pipeline Python (numpy, scipy, Pillow) qui a produit les GLB : modélisation procédurale, IK par frame (`author_fp.py`, `author_tp.py`), résolution des poses clés de la recharge (`keypose.py`, `reload_keys_v4b.json`), posture TP arme droite (`tp_straight.py`, `author_tp5.py`, `tp_grip.json`), correction de peau TP (`belly.py`, `weightfix.py`, `glb_patch_weights.py`), export. Voir `_authoring/README.md`.
