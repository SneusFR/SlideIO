"""Frisbee Launcher — add the FP and TP scenes (rigs + weapon + every baked clip) to FrisbeeLauncher.blend, in a
BACKGROUND Blender launched from the Blender MCP (the file open in the Blender window is never touched):
    blender -b FrisbeeLauncher.blend --python fl_scenes.py
Needs next to this script: FrisbeeLauncher_Weapon.glb, Potato_FP_CommonArms.glb, Potato_TP_Character.glb (v5 skin),
WeaponProfile_FrisbeeLauncher.json, blender_fp_clips.json, blender_tp_clips.json (to_blender.py), fl_anim.py; and
psb_tools.py one folder up (PopcornShotgun_Blender). Check renders -> shots/sc_*.png, log -> shots/scenes_log.txt."""
import bpy, sys, os, math, json, time, traceback
from mathutils import Vector

D = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [D, os.path.dirname(D)]
os.makedirs(os.path.join(D, 'shots'), exist_ok=True)
LOG = open(os.path.join(D, 'shots', 'scenes_log.txt'), 'w')


def log(*a):
    LOG.write(' '.join(str(x) for x in a) + '\n'); LOG.flush()


def g2b(p):
    return Vector((p[0], -p[2], p[1]))


try:
    t0 = time.time()
    import importlib, fl_anim as F
    importlib.reload(F)
    prof = json.load(open(os.path.join(D, 'WeaponProfile_FrisbeeLauncher.json')))
    wglb = os.path.join(D, 'FrisbeeLauncher_Weapon.glb')
    F.build_scene('FP', wglb, os.path.join(D, 'Potato_FP_CommonArms.glb'), prof['mounts']['fp']['matrixRows'])
    F.build_scene('TP', wglb, os.path.join(D, 'Potato_TP_Character.glb'), prof['mounts']['tp']['matrixRows'])
    log('scenes built %.1fs' % (time.time() - t0))
    lays = {}
    for kind in ('FP', 'TP'):
        js = os.path.join(D, 'blender_%s_clips.json' % kind.lower())
        lays[kind] = F.layout_for(js)
        F.load_clips(kind, js, lays[kind])
        log(kind, 'clips', len(lays[kind]), '%.1fs' % (time.time() - t0))

    # ---------------------------------------------------------------- check renders (temporary setup, restored after)
    tmp_objs, tmp_worlds = [], []

    def setup(sc):
        r = sc.render
        saved = (r.engine, r.resolution_x, r.resolution_y, r.resolution_percentage, r.filepath, sc.world, sc.camera)
        r.engine = 'BLENDER_EEVEE_NEXT'; r.resolution_x, r.resolution_y, r.resolution_percentage = 640, 360, 100
        sc.eevee.taa_render_samples = 8
        sc.view_settings.view_transform = 'Standard'
        w = bpy.data.worlds.new('FL_CheckWorld'); w.use_nodes = True; tmp_worlds.append(w)
        bg = w.node_tree.nodes.get('Background'); bg.inputs[0].default_value = (0.36, 0.40, 0.43, 1); bg.inputs[1].default_value = 1.4
        sc.world = w
        ld = bpy.data.lights.new('FL_CheckSun', 'SUN'); ld.energy = 3.0
        lo = bpy.data.objects.new('FL_CheckSun', ld); sc.collection.objects.link(lo); tmp_objs.append(lo)
        lo.rotation_euler = (math.radians(35), math.radians(-15), math.radians(-30))
        return saved

    def restore(sc, saved):
        r = sc.render
        r.engine, r.resolution_x, r.resolution_y, r.resolution_percentage, r.filepath, sc.world, sc.camera = saved

    def cam_look(sc, name, eye_g, tgt_g, fov):
        cd = bpy.data.cameras.new(name); c = bpy.data.objects.new(name, cd); sc.collection.objects.link(c)
        eye, tgt = g2b(eye_g), g2b(tgt_g)
        c.location = eye; c.rotation_mode = 'QUATERNION'; c.rotation_quaternion = (tgt - eye).to_track_quat('-Z', 'Y')
        cd.sensor_fit = 'VERTICAL'; cd.angle_y = math.radians(fov); cd.clip_start = 0.01
        tmp_objs.append(c); return c

    def shoot(sc, cam, clip, tt, name):
        lay = lays[sc.name]
        sc.camera = cam
        sc.frame_set(int(round(lay[clip] + tt * 60)))
        sc.render.filepath = os.path.join(D, 'shots', 'sc_' + name + '.png')
        with bpy.context.temp_override(scene=sc, view_layer=sc.view_layers[0]):
            bpy.ops.render.render(write_still=True)
        log('render', name, sc.name, sc.frame_current)

    hide = [o for o in bpy.data.objects if o.name.endswith('Icosphere')]      # glTF importer bone-shape helpers
    hide_state = [(o, o.hide_render) for o in hide]
    for o in hide: o.hide_render = True

    fp = bpy.data.scenes['FP']; sv = setup(fp); cfp = bpy.data.objects['Cam_FP']
    side = cam_look(fp, 'Cam_Check_Side', (-1.5, -0.1, -0.1), (0.02, -0.30, -0.25), 42)
    for clip, tt, nm in [('FP_FrisbeeLauncher_Hold', 0.5, 'fp_hold'), ('FP_Fire_FrisbeeLauncher', 0.02, 'fp_fire_000'),
                         ('FP_Fire_FrisbeeLauncher', 0.62, 'fp_fire_062'), ('FP_Fire_FrisbeeLauncher', 1.05, 'fp_fire_105'),
                         ('FP_Fire_FrisbeeLauncher', 1.30, 'fp_fire_130'), ('FP_Reload_FrisbeeLauncher', 0.45, 'fp_rl_045'),
                         ('FP_Reload_FrisbeeLauncher', 0.55, 'fp_rl_055'), ('FP_Reload_FrisbeeLauncher', 0.62, 'fp_rl_062'),
                         ('FP_Reload_FrisbeeLauncher', 0.76, 'fp_rl_076'), ('FP_Reload_FrisbeeLauncher', 0.95, 'fp_rl_095'),
                         ('FP_Reload_FrisbeeLauncher', 1.02, 'fp_rl_102'), ('FP_Inspect_FrisbeeLauncher', 1.3, 'fp_insp_130'),
                         ('FP_Inspect_FrisbeeLauncher', 2.5, 'fp_insp_250'), ('FP_Aim_FrisbeeLauncher', 0.5, 'fp_aim')]:
        shoot(fp, cfp, clip, tt, nm)
    shoot(fp, side, 'FP_Fire_FrisbeeLauncher', 0.62, 'fpside_fire_062')
    shoot(fp, side, 'FP_Reload_FrisbeeLauncher', 0.45, 'fpside_rl_045')
    restore(fp, sv)

    tp = bpy.data.scenes['TP']; sv = setup(tp)
    c34 = cam_look(tp, 'Cam_Check_TP34', (1.3, 0.75, 1.5), (0.0, 0.42, 0.1), 32)
    cl = cam_look(tp, 'Cam_Check_TPL', (-1.4, 0.7, 1.2), (0.0, 0.42, 0.1), 32)
    for clip, tt, nm in [('TP_Hold_FrisbeeLauncher', 0.5, 'tp_hold'), ('TP_Fire_FrisbeeLauncher', 0.62, 'tp_fire_062'),
                         ('TP_Fire_FrisbeeLauncher', 1.05, 'tp_fire_105'), ('TP_Reload_FrisbeeLauncher', 0.45, 'tp_rl_045'),
                         ('TP_Reload_FrisbeeLauncher', 0.55, 'tp_rl_055'), ('TP_Reload_FrisbeeLauncher', 0.70, 'tp_rl_070'),
                         ('TP_Reload_FrisbeeLauncher', 0.90, 'tp_rl_090'), ('TP_Reload_FrisbeeLauncher', 1.02, 'tp_rl_102'),
                         ('TP_Reload_FrisbeeLauncher', 1.35, 'tp_rl_135')]:
        shoot(tp, c34, clip, tt, nm)
    shoot(tp, cl, 'TP_Fire_FrisbeeLauncher', 1.05, 'tpl_fire_105')
    restore(tp, sv)

    for o in tmp_objs:
        d, typ = o.data, o.type
        bpy.data.objects.remove(o, do_unlink=True)
        if d is not None and d.users == 0:
            (bpy.data.cameras if typ == 'CAMERA' else bpy.data.lights).remove(d)
    for w in tmp_worlds:
        if w.users == 0: bpy.data.worlds.remove(w)
    for o, h in hide_state: o.hide_render = h
    fp.render.engine = 'BLENDER_EEVEE_NEXT'; fp.render.resolution_x, fp.render.resolution_y = 1920, 1080
    fp.camera = cfp
    fp.frame_set(lays['FP']['FP_FrisbeeLauncher_Hold'])
    tp.frame_set(lays['TP']['TP_Hold_FrisbeeLauncher'])
    bpy.ops.wm.save_mainfile()
    log('saved', bpy.data.filepath, '%.1fs' % (time.time() - t0))
    log('DONE')
except Exception:
    log('ERROR'); log(traceback.format_exc())
LOG.close()
