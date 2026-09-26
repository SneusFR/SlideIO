# Pipeline de génération (Python 3.11 + numpy, scipy, Pillow ; tsx pour `bake_ts.ts`)

Placer à côté des scripts : `Potato_FP_CommonArms.glb`, `Potato_TP_Character.glb`,
`HexSniper_FP_Poses.glb`, `HexSniper_TP_Poses.glb`, `HexSniper_Weapon.glb`, `WeaponProfile_HexSniper.json`
(la pose Hold du HexSniper sert de référence : même bras droit, même orientation de main gauche).

Ordre :
0. (optionnel) `python3 run_fit3.py` — ajuste la prise de pompe sur le mesh de la main → `pump_grip.json`.
1. `python3 bake_popcorn.py` — dispositions plein / moitié (72 / 36 popcorns).
2. `python3 export_weapon.py` — modèle procédural (`weapon_parts.py`) → `PopcornShotgun_Weapon.glb`.
3. `tsx bake_ts.ts` — re-stabilise les dispositions avec le solveur runtime (ajuster en tête de fichier le chemin de `PopcornTankSim` et du GLB), puis relancer l’étape 2.
4. (optionnel) `python3 keypose.py`-based search (voir `reload_keys_v4b.json`) — positions de l'arme pour les temps forts de la recharge,
   résolues avec les deux bras.
5. `python3 author_fp.py` (ou `python3 bake_v4.py <clips…>`) puis `python3 export_poses.py fp` — clips FP (IK par frame, voir `CLIPS`).
6. `python3 author_tp.py` puis `python3 export_poses.py tp` — clips TP.
7. `python3 make_profile.py` — `WeaponProfile_PopcornShotgun.json`.
8. (Blender) `python3 to_blender.py out.json <clips…>` puis, dans Blender : `psb_tools.load_clips(out.json, layout)`.

Réglages principaux :
- `author_fp.py` : `HOLD` / `AIM` (cadrage caméra), `MOUNT_OFFSET` (arme dans la main droite), `LIMITS`
  (limites poignet / avant-bras), timelines `KICK`, `PUMP_FIRE`, `RL`, `RELOAD_*`, `INSPECT_*`.
- `pump_grip.json` : repère `OffhandSocket` + flexion des doigts de la prise de pompe (sortie de `grip_fit.py`) ;
  v4 : `GRIP_ROLL` (−25°) le tourne autour de l'axe de la pompe dans `author_fp.py`.
- `straight.py` : objectif « bras droit à l'écran » (écarts coude / poignet projetés, torsions cibles −5° / 7°) ;
  `sleeve_offscreen` et `upper_arm_rises` dans `author_fp.py` gardent le manchon hors champ et le bras montant du bas.
- `python3 twist.py` : rapport flexion / torsion du poignet par clip.
- `weapon_parts.py` : géométrie (1 unité = 242,6 px de l'image de référence), `PUMP_*`, `BARREL_R`.
- `preview_fp.py <clip> <n>` / `preview_tp.py <clip> <n>` : planches de contrôle (rendu logiciel).

v5 (TP, arme droite + peau) :
- `python3 weightfix.py` — recalcule les poids flanc / aisselle de `Potato_TP_Character` (moindres carrés linéaires : forme locale du flanc conservée sur des poses bras levés, doublons de couture soudés) → `tp_weights_J.npy` / `tp_weights_W.npy`.
- `python3 glb_patch_weights.py` — écrit `Potato_TP_Character_v5.glb` (seuls JOINTS_0 / WEIGHTS_0 changent, octet pour octet ailleurs).
- `python3 tp_straight.py` (via `/tmp` scripts ou directement) — pose clé TP arme droite : position de l'arme, buste, deux bras, pli du ventre (`belly.py`) → `tp_straight_hold_w.pkl`, `tp_grip.json`.
- `python3 author_tp5.py [clips]` (variable `OUT` pour le fichier de sortie) — clips TP v5, puis `python3 export_poses.py tp`.
