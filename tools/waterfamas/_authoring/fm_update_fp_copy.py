"""Water FAMAS — update the FP scene of WaterFamas.blend with blender_fp_clips.json, in a BACKGROUND Blender
(the file open in the Blender window is never touched):  blender -b WaterFamas.blend --python fm_update_fp.py
Re-keys every FP clip (fm_anim.load_clips), then runs fm_check_fp.py: check renders shots/v3_*.png + save
(the previous version is kept as .blend1)."""
import bpy, sys, os, traceback

D = r'C:\Users\Sneus\Documents\PopcornShotgun_Blender\WaterFamas'
sys.path[:0] = [D, os.path.dirname(D)]
try:
    import fm_anim as F
    js = os.path.join(D, 'blender_fp_clips.json')
    F.load_clips('FP', js, F.layout_for(js))
    print('FM: FP clips loaded')
except Exception:
    traceback.print_exc(); raise SystemExit(1)
exec(open(os.path.join(D, 'fm_check_fp.py')).read())
