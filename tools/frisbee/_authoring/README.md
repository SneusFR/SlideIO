# Pipeline de génération — Lance-Frisbee

Python 3.11 + numpy, scipy, Pillow ; Blender 4.x (lancé via le MCP) pour le modèle et les scènes ; Node + typescript pour `transpile.mjs`.

Placer à côté des scripts : `Potato_FP_CommonArms.glb`, `Potato_TP_Character.glb` (v5, peau corrigée),
`HexSniper_FP_Poses.glb`, `HexSniper_TP_Poses.glb`, `WeaponProfile_HexSniper.json`, `tp_body_aim.npy`, `fore_grip.json`,
`fore_grip_v1.json`, `pb_fist_v2.json`, `fp_left_idle.json`.

1. **Modèle (Blender)** : `blender/fl_model.py` + `blender/fl_build.py` — Blender en arrière-plan (le fichier ouvert dans la
   fenêtre n'est pas touché) : `blender -b --factory-startup --python fl_build.py` → scène `Model`, images `shots/m_*.png`,
   `fl_dump.json`, `FrisbeeLauncher.blend`. Coques convexes bmesh + chanfreins, couleurs de sommets. Constantes en tête de
   `fl_model.py` : pont (`DECK_Y`), chariot (`SLED_COCKED_X` / `SLED_FRONT_X`), branches (`LIMB_PIVOT`, `LIMB_TIP_LOCAL`,
   `FLEX_DEG`), disque (`DISC_R`, `DISC_H`), cage (`CAGE_C`, `SLOT_Y` = 5 disques, `CAGE_BOTTOM`), poignée avant (`FOREGRIP`).
   La poignée pistolet, la gâchette et le pontet sont ceux du Paintball Rifle (mêmes montages, même main droite).
2. **Clips FP** : `python3 author_fp.py [clips]` → `fp_clips.pkl` (sauvegarde après chaque clip ; `OUT=autre.pkl` pour bake en parallèle).
   IK par frame : arme placée dans l'espace caméra (`HOLD` / `AIM`), bras droit sur `Weapon_R`, bras gauche sur la poignée avant
   (poing du Paintball Rifle, `fore_grip.json`). Hors de la poignée, le bras gauche est résolu sous limites naturelles
   (`fp_natural.py` : torsions vues par la peau, coudes vers le bas / l'extérieur, glissement d'épaule ≤ 13 cm, manche sous le
   champ), et ses trajets en l'air sont des mélanges articulaires (`JB`) entre poses de contact (`Baker.key_pose(t, side)` :
   l'élément qui finit à `ta` / celui qui commence à `tb`).
   - Réarmement (`CY`, `cycle_left`) : poing sur la poignée en T du chariot (`SLED_GRAB_LOCAL`), disque pris par le bord
     (`DISC_GRIP`, trajet `DISC_KEYS`), posé sur le pont.
   - Changement de cage (`RL`, `reload_left`) : main sous la cage (`CAGE_GRIP`), trajet `CAGE_KEYS`. À `RL.release` la
     cage vide est lâchée : `cage_fall_cam` (gravité + petite rotation, espace caméra) la fait tomber hors de l'écran, elle
     n'est masquée qu'à `RL.gone` (calculé : boîte de la cage entièrement sous le bord bas / à gauche, 21:9, `offscreen_cam`).
     Le bras vide GLISSE sous la vue (`RL_ARM`, `LEFT_DROP` = le bras de la poignée avant translaté de `ARM_DROP_CAM` par
     l'épaule : l'orientation ne change pas, la manche ne remonte jamais dans l'écran), la nouvelle cage apparaît dans cette
     main hors écran à `RL_ARM.appear` (`cage_display_fp_new`, grandit de 0,3 à 1 en `GROW` s) et remonte avec le bras. `python3 opt/arm_visible.py fp_clips.pkl <clip> t0 t1` :
     triangles du bras gauche dans la vue (maillage skinné, découpé au plan proche), frame par frame.
   - Placements de l'arme aux instants de contact cherchés par `opt/search_keys.py` (Nelder-Mead sur [dx, dy, dz, lacet,
     tangage, roulis] : bras naturel + geste visible à l'écran) → `CY_GUN`, `RL_GUN`. Contrôle : `opt/render_keys.py`.
   - Equip / Unequip : bras gauche le long du corps (`fp_left_idle.json`, celui du FAMAS) ↔ poignée avant.
   - Planches : `python3 opt/sheet_clip.py fp_clips.pkl <clip> out.png t1 t2 …` ; à-coups : `python3 opt/jumps.py fp_clips.pkl <clips>`.
3. **Clips TP** : `python3 author_tp.py key` (pose clé : prise à deux mains droite devant, `tp_key.pkl`), puis
   `OUT=tp_x.pkl python3 author_tp.py <clips>` et fusion dans `tp_clips.pkl`. Solveur « straight stance » du Paintball Rifle
   (creux du ventre, collision corps, lacet / inclinaison du buste). Réarmement / recharge TP : `TP_CY_GUN`, `TP_RL_GUN`,
   `CAGE_KEYS_TP` (poche de ceinture, hanche gauche). Le nœud `Cage` TP est masqué 1/60 s après `RL.release` : au runtime
   une copie monde (`ts/DroppedCages.ts`) reprend sa pose et sa vitesse. Clips d'action TP à 30 i/s, IK résolue une image
   sur 3 (`KEY_STEP`) et interpolée entre deux. Contrôle : `python3 preview_tp.py tp_clips.pkl <clip> out.png t1 t2 …`.
4. **Export** : `python3 export_weapon.py`, `python3 export_poses.py fp|tp`, `python3 make_profile.py`.
5. **Runtime** : les `.ts` de `weapons/frisbee/` ; `node transpile.mjs` les copie en `.js` dans `preview/js/weapons/frisbee/`.
   Page de test : `preview/index.html` (servir le dossier en local) ; tests Playwright : `node pwtest.cjs '<étapes JSON>'`.
6. **Blender (scènes FP / TP)** : `python3 to_blender.py fp_clips.pkl blender_fp_clips.json` (idem TP), puis
   `blender -b FrisbeeLauncher.blend --python fl_scenes.py` : ajoute les scènes `FP` (bras communs + arme montée, `Cam_FP`) et
   `TP` (perso v5 + arme + `TP_CageDrop`, la cage jetée : même physique que `DroppedCages`, simulée par `to_blender.py`),
   clé tous les clips sur une timeline par scène (un marqueur par clip), rend `shots/sc_*.png`, sauvegarde. L'arme importée
   garde les axes glTF convertis : le montage vaut `M · A⁻¹` dans Blender (`fl_anim.build_scene`).
   `fl_anim.py` importe `psb_tools.py` (livré avec le Popcorn Shotgun, dossier parent).

Réglages principaux :
- `author_fp.py` : `HOLD` / `AIM` (cadrage), `SHOT` / `KICK` / `FLEX_SHOT` (tir), `CY` / `CY_GUN` / `DISC_KEYS` (réarmement),
  `RL` / `RL_GUN` / `CAGE_KEYS` (recharge), `INSPECT_GUN`, `EQUIP_GUN`.
- `author_tp.py` : `TP_CY_GUN`, `TP_RL_GUN`, `CAGE_KEYS_TP`.
- `weapon_def.py` : points clés lus dans `fl_dump.json` (le modèle Blender fait foi).
- `ts/FrisbeeProjectiles.ts` : `FRISBEE_TUNING` (vitesse, lift, rebonds, dégâts, recul).
