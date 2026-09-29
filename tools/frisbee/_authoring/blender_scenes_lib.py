"""Frisbee Launcher — FP / TP scenes of FrisbeeLauncher.blend with the baked clips (run by fl_scenes.py in a
BACKGROUND Blender launched from the Blender MCP; the file open in the Blender window is never touched).

Scenes:
  Model — the procedural model (fl_model.build), glTF axes under the rotated root 'FrisbeeLauncher'
  FP    — Potato_FP_CommonArms + the exported weapon GLB mounted like the game (Weapon_R -> Mount -> root), Cam_FP
  TP    — Potato_TP_Character (v5 skin) + the weapon on Weapon_R (Mount)
Clips are keyed on ONE timeline per scene (60 fps) with a marker per clip (same convention as the Paintball / FAMAS
.blend). Weapon parts (trigger, sled, limbs, elastic cords, deck disc, disc in the hand, cage) are keyed per frame from
the same weapon state as the game clips; the cage discs are keyed visible / hidden (scale 1 / 0).
Conventions (psb_tools): Blender world = A · glTF · A⁻¹, bone matrix = g2b(node) · C.
"""
import bpy, json, math, re
from mathutils import Matrix
import psb_tools as P

WEAPON_PARTS = ("Trigger", "Sled", "LimbL", "LimbR", "CordL", "CordR", "DiscDeck", "DiscHand", "Cage")
ROOT = "FrisbeeLauncher"


def _scene(name):
    sc = bpy.data.scenes.get(name) or bpy.data.scenes.new(name)
    sc.render.fps = 60
    return sc


def _layer_coll(vl, coll):
    def walk(lc):
        if lc.collection == coll: return lc
        for c in lc.children:
            r = walk(c)
            if r: return r
        return None
    return walk(vl.layer_collection)


def _import_glb(path, prefix, coll, sc):
    """Import a GLB and move it into `coll` of scene `sc` (works in a background Blender), prefixing every new object
    (no name clash with the Model scene or the other scene). Animations stored in the GLB are dropped (the clips are
    keyed here)."""
    before = set(bpy.data.objects)
    before_names = {o.name for o in before}
    # imported in the current (context) scene — the glTF importer needs the real context (bone-shape helper) —
    # then every new object is moved into `coll` of the target scene
    bpy.ops.import_scene.gltf(filepath=path, bone_heuristic='BLENDER')
    new = [o for o in bpy.data.objects if o not in before]
    for o in new:
        for c in list(o.users_collection): c.objects.unlink(o)
        coll.objects.link(o)
        if o.animation_data:
            for t in list(o.animation_data.nla_tracks): o.animation_data.nla_tracks.remove(t)
            o.animation_data.action = None
        base = o.name
        m = re.match(r"^(.*)\.\d{3}$", base)
        if m and m.group(1) in before_names:
            base = m.group(1)
        o.name = prefix + base
    return new


def build_scene(kind, weapon_glb, rig_glb, mount_rows):
    """kind: 'FP' or 'TP'. Creates the scene, imports rig + weapon, mounts the weapon root on Weapon_R."""
    sc = _scene(kind)
    coll = bpy.data.collections.get(kind + '_FrisbeeLauncher') or bpy.data.collections.new(kind + '_FrisbeeLauncher')
    if coll.name not in sc.collection.children: sc.collection.children.link(coll)
    for o in list(coll.objects): bpy.data.objects.remove(o, do_unlink=True)
    rig = _import_glb(rig_glb, kind + '_', coll, sc)
    _import_glb(weapon_glb, kind + '_', coll, sc)
    arm = next(o for o in rig if o.type == 'ARMATURE')
    arm.name = kind + '_Armature'
    root = bpy.data.objects[kind + '_' + ROOT]
    m = bpy.data.objects.new(kind + '_Mount', None); coll.objects.link(m)
    m.empty_display_type = 'ARROWS'; m.empty_display_size = 0.03
    m.parent = arm; m.parent_type = 'BONE'; m.parent_bone = 'Weapon_R'
    m.matrix_parent_inverse = Matrix.Translation((0, -arm.data.bones['Weapon_R'].length, 0))
    # the imported root keeps the glTF axes converted by the importer (no +90° X on the root, unlike the Model scene):
    # Blender(bone) = g2b(node)·C with C = A, so the game's mount M becomes M·A⁻¹ here
    m.rotation_mode = 'QUATERNION'; m.matrix_basis = P.M4(mount_rows) @ P.Ai
    root.parent = m; root.matrix_parent_inverse = Matrix.Identity(4)
    if kind == 'FP':
        cam = bpy.data.objects.get('Cam_FP')
        if cam is None:
            cd = bpy.data.cameras.new('Cam_FP'); cam = bpy.data.objects.new('Cam_FP', cd)
        for c in list(cam.users_collection): c.objects.unlink(cam)
        coll.objects.link(cam)
        cam.data.sensor_fit = 'VERTICAL'; cam.data.angle_y = math.radians(65.0); cam.data.clip_start = 0.01
        cam.location = (0, 0, 0); cam.rotation_mode = 'XYZ'; cam.rotation_euler = (math.radians(90), 0, 0)
        sc.camera = cam
    if kind == 'TP':
        # the empty cage thrown during the reload: in the game a world-space copy (DroppedCages) takes over from the
        # weapon's Cage node at the release; here a prop sharing the cage mesh, keyed from the same physics (to_blender.py)
        cage = bpy.data.objects[kind + '_Cage']
        d = bpy.data.objects.new(kind + '_CageDrop', cage.data); coll.objects.link(d)
        d.rotation_mode = 'QUATERNION'; d.scale = (0, 0, 0)
    return arm, root


def load_clips(kind, path, layout):
    """JSON {clip: {fps, frames:[{bones:{n:[t,q]}, objects:{part:[t,q,s3]}, cage_discs:[s…]}]}} -> one timeline."""
    import numpy as np
    data = json.load(open(path)); sc = bpy.data.scenes[kind]
    ob = bpy.data.objects[kind + '_Armature']
    a_arm = P._action_for(ob, f'FL_{kind}_Arms')
    vm = bpy.data.objects.get(kind + '_FP_Viewmodel')
    a_vm = P._action_for(vm, 'FL_FP_Viewmodel') if vm else None
    a_obj = {n: P._action_for(bpy.data.objects[kind + '_' + n], f'FL_{kind}_{n}') for n in WEAPON_PARTS}
    drop = bpy.data.objects.get(kind + '_CageDrop')
    a_drop = P._action_for(drop, f'FL_{kind}_CageDrop') if drop else None
    discs = []
    for k in range(16):
        o = bpy.data.objects.get(f'{kind}_CageDisc{k}')
        if o is None: break
        discs.append((o, P._action_for(o, f'FL_{kind}_CageDisc{k}')))
    for clip, start in layout.items():
        if clip not in data: continue
        c = data[clip]; fr = c['frames']; step = sc.render.fps / c['fps']
        frames = np.array([start + i * step for i in range(len(fr))])
        for act in [a_arm, *([a_vm] if a_vm else []), *a_obj.values(), *[a for _, a in discs], *([a_drop] if a_drop else [])]:
            P.clear_range(act, start, frames[-1])
        for n in fr[0]['bones']:
            if n == 'FP_Viewmodel' and vm is not None:
                locs, rots = [], []
                for f in fr:
                    M = P.g2b(P.trs_g(*f['bones'][n])); l, q, s = M.decompose(); locs.append(l[:]); rots.append(q[:])
                vm.rotation_mode = 'QUATERNION'
                P._key_series(a_vm, 'location', 'FP_Viewmodel', frames, locs)
                P._key_series(a_vm, 'rotation_quaternion', 'FP_Viewmodel', frames, P._qfix(rots))
                continue
            if n not in ob.pose.bones: continue
            pb = ob.pose.bones[n]; pb.rotation_mode = 'QUATERNION'
            locs, rots = [], []
            for f in fr:
                B = P.local_g_to_basis(ob, n, P.trs_g(*f['bones'][n])); l, q, s = B.decompose(); locs.append(l[:]); rots.append(q[:])
            P._key_series(a_arm, f'pose.bones["{n}"].location', n, frames, locs)
            P._key_series(a_arm, f'pose.bones["{n}"].rotation_quaternion', n, frames, P._qfix(rots))
        for n, act in a_obj.items():
            o = bpy.data.objects[kind + '_' + n]; o.rotation_mode = 'QUATERNION'
            locs, rots, scs = [], [], []
            for f in fr:
                t, q, s = f['objects'][n]
                hidden = min(abs(v) for v in s) < 1e-3
                M = P.g2b(P.trs_g(t, q, (1.0, 1.0, 1.0) if hidden else s)); l, qq, ss = M.decompose()
                locs.append(l[:]); rots.append(qq[:]); scs.append((0.0, 0.0, 0.0) if hidden else ss[:])
            P._key_series(act, 'location', n, frames, locs); P._key_series(act, 'rotation_quaternion', n, frames, P._qfix(rots))
            P._key_series(act, 'scale', n, frames, scs)
            for fc in act.fcurves:                                   # visibility switches: no in-between shrinking
                if fc.data_path == 'scale' and n in ('DiscDeck', 'DiscHand', 'Cage'):
                    for p in fc.keyframe_points: p.interpolation = 'CONSTANT'
        for k, (o, act) in enumerate(discs):
            vals = [(f['cage_discs'][k],) * 3 if k < len(f['cage_discs']) else (0.0,) * 3 for f in fr]
            P._key_series(act, 'scale', o.name, frames, vals)
            for fc in act.fcurves:
                for p in fc.keyframe_points: p.interpolation = 'CONSTANT'
        if a_drop is not None:
            locs, rots, scs = [], [], []
            first = next((f['drop'] for f in fr if f.get('drop')), None)
            for f in fr:
                dd = f.get('drop') or first
                if dd is None:
                    locs.append((0.0, 0.0, 0.0)); rots.append((1.0, 0.0, 0.0, 0.0)); scs.append((0.0, 0.0, 0.0)); continue
                M = P.g2b(P.trs_g(*dd)); l, q, sv = M.decompose()
                locs.append(l[:]); rots.append(q[:]); scs.append(sv[:] if f.get('drop') else (0.0, 0.0, 0.0))
            P._key_series(a_drop, 'location', 'CageDrop', frames, locs)
            P._key_series(a_drop, 'rotation_quaternion', 'CageDrop', frames, P._qfix(rots))
            P._key_series(a_drop, 'scale', 'CageDrop', frames, scs)
            for fc in a_drop.fcurves:
                if fc.data_path == 'scale':
                    for p in fc.keyframe_points: p.interpolation = 'CONSTANT'
        mk = sc.timeline_markers.get(clip) or sc.timeline_markers.new(clip, frame=int(start)); mk.frame = int(start)
    sc.frame_start = 0
    sc.frame_end = int(max(s + (len(data[c]['frames']) - 1) * sc.render.fps / data[c]['fps'] for c, s in layout.items() if c in data))
    return True


def layout_for(path, gap=12):
    """Clips one after the other on the 60 fps timeline."""
    data = json.load(open(path))
    lay, t = {}, 0
    for name, c in data.items():
        lay[name] = t
        t += int(round((len(c['frames']) - 1) * 60 / c['fps'])) + gap
    return lay
