"""Water FAMAS — check renders of the FP scene (EEVEE, 640x360) into shots/v3_*.png, run in a BACKGROUND Blender:
blender -b WaterFamas.blend --python fm_check_fp.py. Leaves the scene settings as they were (only the renders are new);
also puts back the FP render settings changed by the first fm_update_fp.py run (Workbench 640x360 -> EEVEE 1920x1080)."""
import bpy, os, math, time, traceback
from mathutils import Vector

D = r'C:\Users\Sneus\Documents\PopcornShotgun_Blender\WaterFamas'
LOG = open(os.path.join(D, 'shots', 'v3_check_log.txt'), 'w')


def log(*a):
    LOG.write(' '.join(str(x) for x in a) + '\n'); LOG.flush()


def g2b(p):
    return Vector((p[0], -p[2], p[1]))


try:
    import json
    sc = bpy.data.scenes['FP']
    vl = sc.view_layers[0]
    lay, t = {}, 0
    data = json.load(open(os.path.join(D, 'blender_fp_clips.json')))
    for name, c in data.items():
        lay[name] = t; t += int(round((len(c['frames']) - 1) * 60 / c['fps'])) + 12
    at = lambda clip, tt: int(round(lay[clip] + tt * 60))
    cam_fp = bpy.data.objects['Cam_FP']
    # --- temporary render setup
    r = sc.render
    r.engine = 'BLENDER_EEVEE_NEXT'
    r.resolution_x, r.resolution_y, r.resolution_percentage = 640, 360, 100
    sc.eevee.taa_render_samples = 8
    w_tmp = bpy.data.worlds.new('FM_CheckWorld'); w_tmp.use_nodes = True
    bg = w_tmp.node_tree.nodes.get('Background'); bg.inputs[0].default_value = (0.20, 0.21, 0.23, 1); bg.inputs[1].default_value = 1.6
    sc.world = w_tmp
    ico = bpy.data.objects.get('FP_Icosphere'); ico_hr = ico.hide_render if ico else None
    if ico: ico.hide_render = True                    # glTF importer bone-shape helper: not part of the scene
    tmp = []

    def cam_look(name, eye_g, tgt_g, fov):
        cd = bpy.data.cameras.new(name); c = bpy.data.objects.new(name, cd); sc.collection.objects.link(c)
        eye, tgt = g2b(eye_g), g2b(tgt_g)
        c.location = eye; c.rotation_mode = 'QUATERNION'; c.rotation_quaternion = (tgt - eye).to_track_quat('-Z', 'Y')
        cd.sensor_fit = 'VERTICAL'; cd.angle_y = math.radians(fov); cd.clip_start = 0.01
        tmp.append(c); return c

    side = cam_look('Cam_Check_Side', (-1.5, -0.1, -0.1), (0.02, -0.30, -0.22), 42)
    front = cam_look('Cam_Check_Front', (0.1, -0.1, -1.9), (0.02, -0.30, -0.22), 42)
    shots = [('fp_idle_hold', cam_fp, 'FP_WaterFamas_Hold', 0.5), ('fp_idle_run', cam_fp, 'FP_WaterFamas_Run', 0.2),
             ('fp_idle_inspect', cam_fp, 'FP_Inspect_WaterFamas', 1.5), ('fp_idle_fire', cam_fp, 'FP_Fire_WaterFamas', 0.1),
             ('fp_rl_016', cam_fp, 'FP_Reload_WaterFamas', 0.16), ('fp_rl_050', cam_fp, 'FP_Reload_WaterFamas', 0.5),
             ('fp_rl_150', cam_fp, 'FP_Reload_WaterFamas', 1.5), ('fp_rl_220', cam_fp, 'FP_Reload_WaterFamas', 2.2),
             ('fp_rl_300', cam_fp, 'FP_Reload_WaterFamas', 3.0),
             ('out_side_hold', side, 'FP_WaterFamas_Hold', 0.5), ('out_front_hold', front, 'FP_WaterFamas_Hold', 0.5),
             ('out_side_rl_012', side, 'FP_Reload_WaterFamas', 0.12), ('out_side_rl_050', side, 'FP_Reload_WaterFamas', 0.5),
             ('out_side_rl_150', side, 'FP_Reload_WaterFamas', 1.5), ('out_side_rl_220', side, 'FP_Reload_WaterFamas', 2.2)]
    for name, cam, clip, tt in shots:
        sc.camera = cam
        sc.frame_set(at(clip, tt))
        r.filepath = os.path.join(D, 'shots', 'v3_' + name + '.png')
        with bpy.context.temp_override(scene=sc, view_layer=vl):
            bpy.ops.render.render(write_still=True)
        log('render', name, 'scene', sc.name, 'frame', sc.frame_current)
    # --- restore: the scene exactly as authored (EEVEE 1920x1080, no world, Cam_FP), minus nothing
    for c in tmp:
        cd = c.data; bpy.data.objects.remove(c, do_unlink=True); bpy.data.cameras.remove(cd)
    if ico: ico.hide_render = ico_hr
    sc.world = None
    for wn in ('FM_CheckWorld', 'FM_W'):
        w = bpy.data.worlds.get(wn)
        if w and w.users == 0: bpy.data.worlds.remove(w)
    r.engine = 'BLENDER_EEVEE_NEXT'; r.resolution_x, r.resolution_y, r.resolution_percentage = 1920, 1080, 100
    r.filepath = '//'
    sc.camera = cam_fp
    sc.frame_set(at('FP_WaterFamas_Hold', 0.0))
    bpy.ops.wm.save_mainfile()
    log('saved', bpy.data.filepath)
    log('DONE')
except Exception:
    log('ERROR'); log(traceback.format_exc())
LOG.close()
