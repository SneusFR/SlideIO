"""Paintball Rifle — Blender scenes with the baked clips (loaded in the user's Blender session through the MCP).

Scenes:
  Model — the procedural model (pb_model.build), glTF axes under the rotated root 'PaintballRifle'
  FP    — Potato_FP_CommonArms + the exported weapon GLB mounted like the game (Weapon_R -> Mount_FP -> root), Cam_FP
  TP    — Potato_TP_Character (v5 skin) + the weapon on Weapon_R (Mount_TP)
Clips are keyed on ONE timeline per scene (60 fps) with a marker per clip (same convention as the Popcorn Shotgun .blend).
Conventions (psb_tools): Blender world = A · glTF · A⁻¹, bone matrix = g2b(node) · C.
"""
import bpy, json, math, os
from mathutils import Matrix, Quaternion, Vector
import psb_tools as P

D = r'C:\Users\Sneus\Documents\PopcornShotgun_Blender\PaintballRifle'
WEAPON_PARTS = ("Trigger", "ChargingHandle", "Hopper")


def _scene(name):
    sc = bpy.data.scenes.get(name) or bpy.data.scenes.new(name)
    sc.render.fps = 60
    return sc


def _import_glb(path, prefix, coll):
    """Import a GLB into `coll`, prefixing every new object / armature (no name clash with the Model scene)."""
    import re
    before = set(bpy.data.objects)
    before_names = {o.name for o in before}
    bpy.ops.import_scene.gltf(filepath=path, bone_heuristic='BLENDER')
    new = [o for o in bpy.data.objects if o not in before]
    for o in new:
        for c in list(o.users_collection): c.objects.unlink(o)
        coll.objects.link(o)
        base = o.name
        m = re.match(r"^(.*)\.\d{3}$", base)
        if m and m.group(1) in before_names:          # renamed by Blender because the Model scene uses that name
            base = m.group(1)
        o.name = prefix + base
    return new


def build_scene(kind, weapon_glb, rig_glb, mount_rows):
    """kind: 'FP' or 'TP'. Creates the scene, imports rig + weapon, mounts the weapon root on Weapon_R."""
    sc = _scene(kind)
    bpy.context.window.scene = sc
    coll = bpy.data.collections.get(kind + '_Paintball') or bpy.data.collections.new(kind + '_Paintball')
    if coll.name not in sc.collection.children: sc.collection.children.link(coll)
    for o in list(coll.objects): bpy.data.objects.remove(o, do_unlink=True)
    rig = _import_glb(rig_glb, kind + '_', coll)
    wpn = _import_glb(weapon_glb, kind + '_', coll)
    arm = next(o for o in rig if o.type == 'ARMATURE')
    arm.name = kind + '_Armature'
    root = bpy.data.objects[kind + '_PaintballRifle']
    m = bpy.data.objects.new(kind + '_Mount', None); coll.objects.link(m)
    m.empty_display_type = 'ARROWS'; m.empty_display_size = 0.03
    m.parent = arm; m.parent_type = 'BONE'; m.parent_bone = 'Weapon_R'
    m.matrix_parent_inverse = Matrix.Translation((0, -arm.data.bones['Weapon_R'].length, 0))
    m.rotation_mode = 'QUATERNION'; m.matrix_basis = P.M4(mount_rows)
    root.parent = m; root.matrix_parent_inverse = Matrix.Identity(4)
    # the GLB preview fill stays; hide the runtime template
    for n in ('Ball_Template',):
        o = bpy.data.objects.get(kind + '_' + n)
        if o: o.hide_viewport = True; o.hide_render = True
    if kind == 'FP':
        cam = bpy.data.objects.get('Cam_FP')
        if cam is None:
            cd = bpy.data.cameras.new('Cam_FP'); cam = bpy.data.objects.new('Cam_FP', cd)
        if cam.name not in coll.objects: coll.objects.link(cam)
        cam.data.sensor_fit = 'VERTICAL'; cam.data.angle_y = math.radians(65.0); cam.data.clip_start = 0.01
        cam.location = (0, 0, 0); cam.rotation_mode = 'XYZ'; cam.rotation_euler = (math.radians(90), 0, 0)
        sc.camera = cam
    return arm, root


def load_clips(kind, path, layout):
    """JSON {clip: {fps, frames:[{bones:{n:[t,q]}, objects:{Trigger|ChargingHandle|Hopper: [t,q,s]}}]}} -> one timeline."""
    import numpy as np
    data = json.load(open(path)); sc = bpy.data.scenes[kind]
    ob = bpy.data.objects[kind + '_Armature']
    a_arm = P._action_for(ob, f'PB_{kind}_Arms')
    vm = bpy.data.objects.get(kind + '_FP_Viewmodel')
    a_vm = P._action_for(vm, 'PB_FP_Viewmodel') if vm else None
    a_obj = {n: P._action_for(bpy.data.objects[kind + '_' + n], f'PB_{kind}_{n}') for n in WEAPON_PARTS}
    for clip, start in layout.items():
        if clip not in data: continue
        c = data[clip]; fr = c['frames']; step = sc.render.fps / c['fps']
        frames = np.array([start + i * step for i in range(len(fr))])
        for act in [a_arm, *( [a_vm] if a_vm else []), *a_obj.values()]: P.clear_range(act, start, frames[-1])
        for n in fr[0]['bones']:
            if n == 'FP_Viewmodel' and vm is not None:
                locs, rots = [], []
                for f in fr:
                    M = P.g2b(P.trs_g(*f['bones'][n])); l, q, s = M.decompose(); locs.append(l[:]); rots.append(q[:])
                vm.rotation_mode = 'QUATERNION'
                P._key_series(a_vm, 'location', 'FP_Viewmodel', frames, locs); P._key_series(a_vm, 'rotation_quaternion', 'FP_Viewmodel', frames, P._qfix(rots))
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
                M = P.g2b(P.trs_g(t, q, (s, s, s))); l, qq, ss = M.decompose(); locs.append(l[:]); rots.append(qq[:]); scs.append(ss[:])
            P._key_series(act, 'location', n, frames, locs); P._key_series(act, 'rotation_quaternion', n, frames, P._qfix(rots))
            P._key_series(act, 'scale', n, frames, scs)
        mk = sc.timeline_markers.get(clip) or sc.timeline_markers.new(clip, frame=int(start)); mk.frame = int(start)
    sc.frame_start = 0
    sc.frame_end = int(max(s + (len(data[c]['frames']) - 1) * sc.render.fps / data[c]['fps'] for c, s in layout.items() if c in data))
    return True
