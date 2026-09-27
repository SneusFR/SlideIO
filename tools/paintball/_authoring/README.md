# Pipeline de génération — Paintball Rifle

Python 3.11 + numpy, scipy, Pillow ; `tsx` pour `ts/bake_hopper.ts` ; Blender 4.3 (via le MCP) pour le modèle.

Placer à côté des scripts : `Potato_FP_CommonArms.glb`, `Potato_TP_Character.glb` (v5, peau corrigée),
`HexSniper_FP_Poses.glb`, `HexSniper_TP_Poses.glb`, `WeaponProfile_HexSniper.json`, `tp_body_aim.npy`.

1. **Modèle (Blender)** : `blender/pb_model.py` (dans Blender : `pb_model.build(json.load(open('balls_full.json')))` puis
   `pb_model.dump('pb_dump.json')`). Coques convexes bmesh + chanfreins, couleurs de sommets, échelle ×1,4 autour de la poignée.
2. **Réservoir** : `python3 hopper_sim.py` (disposition d'aperçu) puis `tsx ts/bake_hopper.ts` → `hopper_bake.json`
   (disposition pleine + 33 dispositions, une par nombre de billes, avec le solveur du runtime).
3. **Prise de la poignée avant** :
   - v1 : `python3 fore_fit2.py` → à renommer en `fore_grip_v1.json`. Poing sur le côté de la poignée ; sert au TP et aux prises réservoir / levier.
   - v2 (FP) : `python3 fore_fit4.py` → `fore_grip.json`. Poing fermé autour de la poignée, noté sur ce que voit la caméra FP (rayons vers la caméra), sans toucher les pièces visibles.
   - Contrôle : `python3 check_grip.py vues.png` (erreur IK, flexion/torsion du poignet et de l'avant-bras) et `fist_views.py`.
   - La variable `FORE_GRIP` permet de tester un autre fichier.
4. **Clips FP** : `python3 author_fp.py [clips]` → `fp_clips.pkl` (IK par frame, bras droit à l'écran, limites articulaires).
5. **Clips TP** : `python3 tp_key_search.py` → `tp_key.pkl` (posture arme droite : position, buste, prise, pli du ventre),
   puis `python3 author_tp.py [clips]` (variable `OUT` pour le fichier, ex. `OUT=tp_c.pkl python3 author_tp.py TP_Reload_PaintballRifle`).
   La recharge TP prend ~45 min (IK par frame) : lance-la à part. Ensuite `python3 tp_hopper_follow.py tp_c.pkl` (le réservoir porté
   suit la main résolue : le bras gauche TP est court et rate la cible de 5 à 10 mm) et `python3 merge_tp.py` → `tp_clips.pkl`.
6. **Export** : `python3 export_weapon.py`, `python3 export_poses.py fp|tp`, `python3 make_profile.py`.
7. **Blender** : `python3 to_blender.py fp_clips.pkl|tp_clips.pkl out.json`, puis dans Blender `pb_anim.build_scene(...)` / `pb_anim.load_clips(...)`
   (`pb_anim` importe `psb_tools.py`, livré avec le Popcorn Shotgun). Montage : `P.M4(M) @ P.Ai` avec `M` = `M_FP` ou `M_TP`.

Réglages principaux :
- `author_fp.py` : `HOLD` / `AIM` (cadrage), `RL` (timeline de la recharge), `HOPPER_KEYS` (trajet du réservoir),
  `RELOAD_GUN` (inclinaison de l'arme), `FIRE_PERIOD` / `_KICK1` / `SUSTAIN` (tir automatique).
- `author_tp.py` : `HOPPER_KEYS_TP` (trajet TP : lâché à gauche, reprise à la ceinture), `TP_RELOAD_GUN`.
- `weapon_def.py` : points clés lus dans `pb_dump.json` (le modèle Blender fait foi).
- `preview_fp.py`, `closeup.py`, `sheet_fp.py`, `preview_tp.py` : rendus logiciels de contrôle.
