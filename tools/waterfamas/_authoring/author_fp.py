# Pipeline de génération — FAMAS à eau

Python 3.11 + numpy, scipy, Pillow ; Blender 4.x (via le MCP) pour le modèle et les scènes ; Node + typescript pour `transpile.mjs`.

Placer à côté des scripts : `Potato_FP_CommonArms.glb`, `Potato_TP_Character.glb` (v5, peau corrigée),
`HexSniper_FP_Poses.glb`, `HexSniper_TP_Poses.glb`, `WeaponProfile_HexSniper.json`, `tp_body_aim.npy`, `pb_fist_v2.json`.

1. **Modèle (Blender)** : `blender/fm_model.py` — dans Blender : `fm_model.build()` puis `fm_model.dump('fm_dump.json')`.
   Coques convexes bmesh + chanfreins, couleurs de sommets, image de référence reportée en pixels (`PXU`, `OX`, `OY`).
   La poignée, la gâchette et le pontet sont ceux du Paintball Rifle (mêmes montages, même main droite).
2. **Clips FP** : `python3 fp_idle_left.py` (bras gauche au repos → `fp_left_idle.json`), puis `python3 author_fp.py [clips]` →
   `fp_clips.pkl`. IK par frame : arme placée dans l'espace caméra, bras droit sur `Weapon_R`, bras gauche **le long du corps**
   (`LEFT_IDLE` : épaule à côté de l'œil, bras qui pend ; la longue manche du rig FP ne peut pas entrer dans le champ), sauf la recharge :
   - bouchon : `claw_state(t)` = 2 coups de poignet par demi-tour (la main suit le bouchon, lâche, revient, reprend) ;
   - bouteille : poing du Paintball Rifle (`pb_fist_v2.json`) posé sur la bande de la bouteille (`bottle_grab_local`).
   **Recharge FP v2** (`python3 fp_reload2.py`, remplace `FP_Reload_WaterFamas` dans `fp_clips.pkl`) :
   - `fp_natural.py` : limites « ce que voit la peau » (deltas depuis la pose de repos) : torsion poignet ≤ 12°, avant-bras ≤ 25°,
     coudes vers le bas / l'extérieur, glissement d'épaule ≤ 10 cm, bras gauche qui entre par le bas de l'écran ;
   - poses de l'arme cherchées sous ces limites : `opt/refine_uns2.py` (dévissage, avec contre-rotation de l'arme `SPLIT` = 0,5)
     et `opt/refine_pour.py` (versement) → `UNS_V`, `CAP_PHI2`, `POUR_V`, `BOTTLE_*` dans `fp_reload2.py` ;
   - trajets en l'air du bras gauche mélangés dans l'espace articulaire (`JB`) entre poses de contact résolues une fois ;
     depuis / vers le bras pendant : le bras tourne d'abord (épaule encore à côté de l'œil) puis glisse vers le contact, sur un
     trajet d'épaule qui passe sous le champ (`DIP`) : `python3 opt/sleeve_check.py fp_clips.pkl` vérifie que la manche reste hors champ.
3. **Clips TP** : `python3 author_tp.py key` (contrôle de la pose clé), puis `OUT=tp_a.pkl python3 author_tp.py <clips>` et
   `OUT=tp_b.pkl python3 author_tp.py TP_Reload_WaterFamas`, fusion dans `tp_clips.pkl`.
   Arme droite à une main (`KEY`), bras gauche détendu (`LEFT_RELAX`, résolu une fois en position seule), balancé en course.
   Recharge TP : `UNS_TP` / `POUR_TP` (poses de l'arme), `BOTTLE_ROLL` (rotation de la bouteille choisie par `tune_bottle()`),
   transitions du bras gauche mélangées dans l'espace articulaire (`JB`) entre poses de contact résolues une fois.
   `python3 author_tp.py sheet out.png <clip> t1 t2 …` : planche de contrôle sans bake.
4. **Export** : `python3 export_weapon.py`, `python3 export_poses.py fp|tp`, `python3 make_profile.py`.
5. **Runtime** : les `.ts` de `weapons/waterfamas/` ; `node transpile.mjs` les copie en `.js` dans `preview/js/weapons/waterfamas/`.
   Jets : `preview/jettest.html` + `node jettest.cjs '<options JSON>' '<étapes>'` (vues FP / côté / gros plan, pas à pas).
6. **Blender (scènes FP / TP)** : `python3 to_blender.py fp_clips.pkl blender_fp_clips.json` (idem TP), puis dans Blender :
   `fm_anim.build_scene('FP', weapon_glb, rig_glb, profil['mounts']['fp']['matrixRows'])` et
   `fm_anim.load_clips('FP', json, fm_anim.layout_for(json))` (`fm_anim` importe `psb_tools.py`, livré avec le Popcorn Shotgun).
   Mise à jour sans toucher au fichier ouvert : `blender -b WaterFamas.blend --python fm_update_fp.py` (recharge les clips FP,
   rend des images de contrôle Workbench dans `shots/v3_*.png`, sauvegarde ; l'ancienne version reste en `.blend1`).

Réglages principaux :
- `author_fp.py` : `HOLD` / `AIM` (cadrage), `RL` (timeline de la recharge), `RELOAD_GUN` / `UNS` / `POUR` (poses de l'arme),
  `CAP_PHI` (orientation de la griffe), `UNSCREW` / `SCREW` / `claw_state` (vissage), `BOTTLE_KEYS` (trajet de la bouteille),
  `JET_TIMES` / `BURST_PUSH` / `_kick` (rafale), `INSPECT_GUN` (inspection).
- `author_tp.py` : `KEY` (prise TP), `UNS_TP` / `POUR_TP`, `POUR_DIR`, `BULGE`, `BOTTLE_ROLL`.
- `weapon_def.py` : points clés lus dans `fm_dump.json` (le modèle Blender fait foi).
