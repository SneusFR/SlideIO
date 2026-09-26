"""Popcorn Shotgun — Blender-side helpers (loaded in the user's Blender session through the MCP).

Conventions (verified on import with bone_heuristic='BLENDER'):
  Blender world  = A · glTF world · A⁻¹           (A = +90° about X: glTF Y-up -> Blender Z-up)
  bone matrix    = g2b(glTF node world) · C        (C = the same +90° X rotation, constant for every bone)
So a glTF node world matrix is recovered exactly as b2g(bone_world · C⁻¹).
"""
import bpy, json, os, math
from mathutils import Matrix, Quaternion, Vector, Euler

W = r'C:\Users\Sneus\Documents\PopcornShotgun_Blender'
A = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
C = A.copy()
Ai = A.inverted(); Ci = C.inverted()


def g2b(M): return A @ M @ Ai
def b2g(M): return Ai @ M @ A


def M4(rows): return Matrix([list(r) for r in rows])


def trs_g(t, q_xyzw, s=(1, 1, 1)):
    """glTF TRS (quaternion x,y,z,w) -> 4x4 mathutils Matrix (glTF space)."""
    q = Quaternion((q_xyzw[3], q_xyzw[0], q_xyzw[1], q_xyzw[2]))
    return Matrix.LocRotScale(Vector(t), q, Vector(s))


def arm(): return bpy.data.objects['Armature']


# --------------------------------------------------------------------------- pose I/O
def local_g_to_basis(ob, name, Lg):
    """glTF node LOCAL matrix -> pose-bone matrix_basis (Blender)."""
    b = ob.data.bones[name]
    X = (g2b(Lg) @ C) if b.parent is None else (Ci @ g2b(Lg) @ C)
    rest_rel = b.matrix_local if b.parent is None else (b.parent.matrix_local.inverted() @ b.matrix_local)
    return rest_rel.inverted() @ X


def apply_gltf_pose(pose, ob=None, frame=None, keys=False):
    """pose: {node: [t(3), q_xyzw(4)]} glTF local TRS. Bones -> matrix_basis, FP_Viewmodel -> object transform."""
    ob = ob or arm()
    for name, (t, q) in pose.items():
        Lg = trs_g(t, q)
        if name == 'FP_Viewmodel':
            o = bpy.data.objects['FP_Viewmodel']; o.rotation_mode = 'QUATERNION'
            o.matrix_basis = g2b(Lg)
            if keys:
                o.keyframe_insert('location', frame=frame, group='FP_Viewmodel'); o.keyframe_insert('rotation_quaternion', frame=frame, group='FP_Viewmodel')
            continue
        if name not in ob.pose.bones: continue
        pb = ob.pose.bones[name]; pb.rotation_mode = 'QUATERNION'
        pb.matrix_basis = local_g_to_basis(ob, name, Lg)
        if keys:
            pb.keyframe_insert('location', frame=frame, group=name); pb.keyframe_insert('rotation_quaternion', frame=frame, group=name)


def world_g_of_bone(ob, name):
    return b2g(ob.matrix_world @ ob.pose.bones[name].matrix @ Ci)


def sample(frames, bones, objects, path):
    """Write glTF-space WORLD matrices of bones/objects for each frame (JSON) — converted to local TRS offline."""
    sc = bpy.context.scene; ob = arm(); out = {'frames': [], 'fps': sc.render.fps}
    for f in frames:
        sc.frame_set(int(f)) if float(f).is_integer() else sc.frame_set(int(f), subframe=f - int(f))
        rec = {'f': f, 'bones': {}, 'objects': {}}
        for n in bones: rec['bones'][n] = [list(r) for r in world_g_of_bone(ob, n)]
        for n in objects: rec['objects'][n] = [list(r) for r in b2g(bpy.data.objects[n].matrix_world)]
        out['frames'].append(rec)
    json.dump(out, open(path, 'w'))
    return len(out['frames'])


# --------------------------------------------------------------------------- scene
def coll(name, parent=None):
    c = bpy.data.collections.get(name) or bpy.data.collections.new(name)
    par = parent or bpy.context.scene.collection
    if c.name not in [x.name for x in par.children]: par.children.link(c)
    return c


def empty(name, parent=None, size=0.02, shape='PLAIN_AXES', collection='Controls'):
    o = bpy.data.objects.get(name)
    if o is None:
        o = bpy.data.objects.new(name, None); coll(collection).objects.link(o)
    o.empty_display_type = shape; o.empty_display_size = size
    o.rotation_mode = 'QUATERNION'
    if parent is not None:
        o.parent = parent; o.matrix_parent_inverse = Matrix.Identity(4)
    return o


def mount_weapon(basis_rows, bone='Weapon_R'):
    """Mount_FP follows the Weapon_R bone exactly like the game (Weapon_R -> fp mount -> weapon root)."""
    ob = arm()
    m = empty('Mount_FP', collection='PopcornShotgun', size=0.03, shape='ARROWS')
    m.parent = ob; m.parent_type = 'BONE'; m.parent_bone = bone
    m.matrix_parent_inverse = Matrix.Translation((0, -ob.data.bones[bone].length, 0))
    m.rotation_mode = 'QUATERNION'
    m.matrix_basis = M4(basis_rows)
    root = bpy.data.objects['PopcornShotgun']
    root.parent = m; root.matrix_parent_inverse = Matrix.Identity(4)
    return m


def fp_camera():
    cam = bpy.data.objects.get('Cam_FP')
    if cam is None:
        cd = bpy.data.cameras.new('Cam_FP'); cam = bpy.data.objects.new('Cam_FP', cd); coll('Controls').objects.link(cam)
    cam.data.sensor_fit = 'VERTICAL'; cam.data.angle_y = math.radians(65.0)
    cam.data.clip_start = 0.01; cam.data.clip_end = 100
    cam.location = (0, 0, 0); cam.rotation_mode = 'XYZ'; cam.rotation_euler = (math.radians(90), 0, 0)
    sc = bpy.context.scene; sc.camera = cam
    sc.render.resolution_x = 1920; sc.render.resolution_y = 1080
    return cam


def view_through_camera(shading='MATERIAL'):
    for win in bpy.context.window_manager.windows:
        for area in win.screen.areas:
            if area.type == 'VIEW_3D':
                sp = area.spaces.active
                sp.region_3d.view_perspective = 'CAMERA'
                sp.shading.type = shading
                sp.overlay.show_relationship_lines = False
                sp.lens = 50
                sp.clip_start = 0.005
                return True
    return False


def view_from(eye, target, shading='MATERIAL', dist=None):
    """Free viewport view (not the camera) looking from eye to target (Blender coords)."""
    eye = Vector(eye); target = Vector(target)
    for win in bpy.context.window_manager.windows:
        for area in win.screen.areas:
            if area.type == 'VIEW_3D':
                sp = area.spaces.active; r3 = sp.region_3d
                r3.view_perspective = 'PERSP'
                d = eye - target
                r3.view_location = target
                r3.view_distance = dist or d.length
                r3.view_rotation = d.to_track_quat('Z', 'Y')
                sp.shading.type = shading
                sp.clip_start = 0.005
                return True
    return False


# --------------------------------------------------------------------------- offscreen snapshots
def _view3d():
    for a in bpy.context.window_manager.windows[0].screen.areas:
        if a.type == 'VIEW_3D':
            return a, a.spaces.active, next(r for r in a.regions if r.type == 'WINDOW')
    raise RuntimeError('no 3D viewport')


def _persp(fov_y_deg, aspect, near=0.005, far=50.0):
    f = 1.0 / math.tan(math.radians(fov_y_deg) / 2)
    return Matrix(((f / aspect, 0, 0, 0), (0, f, 0, 0), (0, 0, (far + near) / (near - far), 2 * far * near / (near - far)), (0, 0, -1, 0)))


def look_at_b(eye, target, up=(0, 0, 1)):
    """Camera world matrix (Blender) looking from eye to target."""
    eye = Vector(eye); target = Vector(target)
    q = (eye - target).to_track_quat('Z', 'Y')
    return Matrix.LocRotScale(eye, q, Vector((1, 1, 1)))


def _snap_camera(cam_world, fov):
    cam = bpy.data.objects.get('Cam_Snap')
    if cam is None:
        cd = bpy.data.cameras.new('Cam_Snap'); cam = bpy.data.objects.new('Cam_Snap', cd)
    sc = bpy.context.scene
    if cam.name not in sc.collection.objects: sc.collection.objects.link(cam)
    cam.data.sensor_fit = 'VERTICAL'; cam.data.angle_y = math.radians(fov); cam.data.clip_start = 0.005; cam.data.clip_end = 100
    cam.matrix_world = cam_world
    cam.hide_render = True
    return cam


def snap(path, w=1280, h=720, cam_world=None, fov=65.0, shading='MATERIAL', overlays=False, gltf_eye=None, gltf_target=None):
    """Render the viewport offscreen (independent of window focus) through a real camera (the viewport is in
    camera view, so the projection must come from the scene camera). Default: the scene camera as is."""
    import gpu, numpy as np
    sc = bpy.context.scene; area, space, region = _view3d()
    old = (space.shading.type, space.overlay.show_overlays, sc.camera, space.region_3d.view_perspective)
    space.shading.type = shading; space.overlay.show_overlays = overlays
    if gltf_eye is not None:
        e = A @ Vector((*gltf_eye, 1)); t = A @ Vector((*gltf_target, 1))
        cam_world = look_at_b(e.xyz, t.xyz)
    cam = sc.camera
    if cam_world is not None:
        cam = _snap_camera(cam_world, fov); sc.camera = cam
    space.region_3d.view_perspective = 'CAMERA'
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    V = cam.matrix_world.inverted(); P = cam.calc_matrix_camera(dg, x=w, y=h)
    off = gpu.types.GPUOffScreen(w, h)
    try:
        off.draw_view3d(sc, bpy.context.view_layer, space, region, V, P, do_color_management=True)
        buf = off.texture_color.read()
    finally:
        off.free()
        space.shading.type, space.overlay.show_overlays = old[0], old[1]
        sc.camera = old[2]; space.region_3d.view_perspective = old[3]
    buf.dimensions = w * h * 4
    px = np.asarray(buf, dtype=np.float32) / 255.0
    img = bpy.data.images.new('psb_snap', w, h, alpha=True)
    img.pixels.foreach_set(px.ravel()); img.filepath_raw = path; img.file_format = 'PNG'; img.save()
    bpy.data.images.remove(img)
    return path


# --------------------------------------------------------------------------- clip import (baked by the offline solver)
def _fcurves(action, data_path, n, group):
    out = []
    for i in range(n):
        fc = action.fcurves.find(data_path, index=i)
        if fc is None:
            fc = action.fcurves.new(data_path, index=i, action_group=group)
        out.append(fc)
    return out


def _key_series(action, data_path, group, frames, values):
    """values: (N, k) array keyed at frames (N,). LINEAR interpolation (sampled data)."""
    import numpy as np
    values = np.asarray(values, float); k = values.shape[1]
    for i, fc in enumerate(_fcurves(action, data_path, k, group)):
        start = len(fc.keyframe_points)
        fc.keyframe_points.add(len(frames))
        co = np.empty(2 * len(frames)); co[0::2] = frames; co[1::2] = values[:, i]
        pts = fc.keyframe_points
        for j in range(len(frames)):
            p = pts[start + j]; p.co = (co[2 * j], co[2 * j + 1]); p.interpolation = 'LINEAR'
        fc.update()


def _qfix(qs):
    import numpy as np
    qs = np.array(qs, float)
    for i in range(1, len(qs)):
        if np.dot(qs[i], qs[i - 1]) < 0: qs[i] = -qs[i]
    return qs


def _action_for(idblock, name):
    if idblock.animation_data is None: idblock.animation_data_create()
    act = idblock.animation_data.action
    if act is None or act.name != name:
        act = bpy.data.actions.get(name) or bpy.data.actions.new(name)
        idblock.animation_data.action = act
    return act


def clear_range(action, f0, f1):
    for fc in action.fcurves:
        pts = [p for p in fc.keyframe_points if f0 - 0.01 <= p.co[0] <= f1 + 0.01]
        for p in reversed(pts):
            fc.keyframe_points.remove(p, fast=True)
        fc.update()


def load_clips(path, layout):
    """path: JSON {clip: {fps, frames:[{bones:{n:[t,q]}, objects:{n:[t,q]}}]}}; layout: {clip: start_frame}.
    Everything lives on ONE timeline (60 fps) with a marker per clip, one action per animated object."""
    import numpy as np
    data = json.load(open(path)); sc = bpy.context.scene; ob = arm()
    a_arm = _action_for(ob, 'PSB_Arms'); a_vm = _action_for(bpy.data.objects['FP_Viewmodel'], 'PSB_Viewmodel')
    a_obj = {n: _action_for(bpy.data.objects[n], 'PSB_' + n) for n in ('Pump', 'TankLid', 'Trigger')}
    for clip, start in layout.items():
        if clip not in data: continue
        c = data[clip]; fr = c['frames']; step = sc.render.fps / c['fps']
        frames = np.array([start + i * step for i in range(len(fr))])
        end = frames[-1]
        for act in [a_arm, a_vm, *a_obj.values()]: clear_range(act, start, end)
        bones = fr[0]['bones'].keys()
        for n in bones:
            if n == 'FP_Viewmodel':
                locs, rots = [], []
                for f in fr:
                    M = g2b(trs_g(*f['bones'][n])); l, q, s = M.decompose(); locs.append(l[:]); rots.append(q[:])
                _key_series(a_vm, 'location', 'FP_Viewmodel', frames, locs); _key_series(a_vm, 'rotation_quaternion', 'FP_Viewmodel', frames, _qfix(rots))
                continue
            if n not in ob.pose.bones: continue
            pb = ob.pose.bones[n]; pb.rotation_mode = 'QUATERNION'
            locs, rots = [], []
            for f in fr:
                B = local_g_to_basis(ob, n, trs_g(*f['bones'][n])); l, q, s = B.decompose(); locs.append(l[:]); rots.append(q[:])
            _key_series(a_arm, f'pose.bones["{n}"].location', n, frames, locs)
            _key_series(a_arm, f'pose.bones["{n}"].rotation_quaternion', n, frames, _qfix(rots))
        for n, act in a_obj.items():
            o = bpy.data.objects[n]; o.rotation_mode = 'QUATERNION'
            locs, rots = [], []
            for f in fr:
                M = g2b(trs_g(*f['objects'][n])); l, q, s = M.decompose(); locs.append(l[:]); rots.append(q[:])
            _key_series(act, 'location', n, frames, locs); _key_series(act, 'rotation_quaternion', n, frames, _qfix(rots))
        m = sc.timeline_markers.get(clip) or sc.timeline_markers.new(clip, frame=int(start))
        m.frame = int(start)
    sc.frame_start = 0; sc.frame_end = int(max(s + (len(data[c]['frames']) - 1) * sc.render.fps / data[c]['fps'] for c, s in layout.items() if c in data))
    return True


def sheet(paths, out, cols=4, w=480, h=270, labels=None):
    """Contact sheet (numpy) of several PNG snaps -> one PNG (fewer transfers)."""
    import numpy as np
    rows = (len(paths) + cols - 1) // cols
    S = np.zeros((rows * h, cols * w, 4), np.float32); S[..., 3] = 1
    for k, p in enumerate(paths):
        img = bpy.data.images.load(p); img.scale(w, h)
        a = np.empty(w * h * 4, np.float32); img.pixels.foreach_get(a); a = a.reshape(h, w, 4)
        r, c = k // cols, k % cols
        S[(rows - 1 - r) * h:(rows - r) * h, c * w:(c + 1) * w] = a       # Blender images are bottom-up
        bpy.data.images.remove(img)
    im = bpy.data.images.new('psb_sheet', cols * w, rows * h, alpha=True)
    im.pixels.foreach_set(S.ravel()); im.filepath_raw = out; im.file_format = 'PNG'; im.save(); bpy.data.images.remove(im)
    return out


def snap_times(clip_start, times, prefix, fps=60, w=640, h=360, **kw):
    sc = bpy.context.scene; paths = []
    for i, tt in enumerate(times):
        f = clip_start + tt * fps
        sc.frame_set(int(f), subframe=f - int(f))
        p = os.path.join(W, 'shots', f'{prefix}_{i:02d}.png'); snap(p, w, h, **kw); paths.append(p)
    return paths


# --------------------------------------------------------------------------- third-person (TP) scene helpers
def tp_arm(): return bpy.data.objects['TP_Armature']


def mount_weapon_tp(basis_rows):
    ob = tp_arm()
    m = bpy.data.objects.get('Mount_TP')
    if m is None:
        m = bpy.data.objects.new('Mount_TP', None); bpy.data.collections['TP_PopcornShotgun'].objects.link(m)
    m.empty_display_type = 'ARROWS'; m.empty_display_size = 0.03
    m.parent = ob; m.parent_type = 'BONE'; m.parent_bone = 'Weapon_R'
    m.matrix_parent_inverse = Matrix.Translation((0, -ob.data.bones['Weapon_R'].length, 0))
    m.rotation_mode = 'QUATERNION'; m.matrix_basis = M4(basis_rows)
    root = bpy.data.objects['TP_PopcornShotgun']; root.parent = m; root.matrix_parent_inverse = Matrix.Identity(4)
    return m


def load_clips_tp(path, layout):
    """Same as load_clips for the TP character (TP_Armature + TP_ weapon parts)."""
    import numpy as np
    data = json.load(open(path)); sc = bpy.context.scene; ob = tp_arm()
    a_arm = _action_for(ob, 'PSB_TP_Arms')
    a_obj = {n: _action_for(bpy.data.objects['TP_' + n], 'PSB_TP_' + n) for n in ('Pump', 'TankLid', 'Trigger')}
    for clip, start in layout.items():
        if clip not in data: continue
        c = data[clip]; fr = c['frames']; step = sc.render.fps / c['fps']
        frames = np.array([start + i * step for i in range(len(fr))])
        for act in [a_arm, *a_obj.values()]: clear_range(act, start, frames[-1])
        for n in fr[0]['bones']:
            if n not in ob.pose.bones: continue
            pb = ob.pose.bones[n]; pb.rotation_mode = 'QUATERNION'
            locs, rots = [], []
            for f in fr:
                B = local_g_to_basis(ob, n, trs_g(*f['bones'][n])); l, q, s = B.decompose(); locs.append(l[:]); rots.append(q[:])
            _key_series(a_arm, f'pose.bones["{n}"].location', n, frames, locs)
            _key_series(a_arm, f'pose.bones["{n}"].rotation_quaternion', n, frames, _qfix(rots))
        for n, act in a_obj.items():
            o = bpy.data.objects['TP_' + n]; o.rotation_mode = 'QUATERNION'
            locs, rots = [], []
            for f in fr:
                M = g2b(trs_g(*f['objects'][n])); l, q, s = M.decompose(); locs.append(l[:]); rots.append(q[:])
            _key_series(act, 'location', n, frames, locs); _key_series(act, 'rotation_quaternion', n, frames, _qfix(rots))
        m = sc.timeline_markers.get(clip) or sc.timeline_markers.new(clip, frame=int(start)); m.frame = int(start)
    sc.frame_start = 0
    sc.frame_end = int(max(s + (len(data[c]['frames']) - 1) * sc.render.fps / data[c]['fps'] for c, s in layout.items() if c in data))


def dump_world(ob, path, extra_objects=()):
    out = {'bones': {n: [list(r) for r in world_g_of_bone(ob, n)] for n in ob.pose.bones.keys()},
           'objects': {n: [list(r) for r in b2g(bpy.data.objects[n].matrix_world)] for n in extra_objects}}
    json.dump(out, open(path, 'w'))


def snap_tp(path, eye_g, target_g, w=720, h=720, fov=35.0, shading='MATERIAL'):
    return snap(path, w, h, fov=fov, shading=shading, gltf_eye=eye_g, gltf_target=target_g)


# --------------------------------------------------------------------------- TP skin weights (flank / armpit fix)
def restore_weights(obj_name, backup_path):
    ob = bpy.data.objects[obj_name]; data = json.load(open(backup_path))
    for v, groups in data.items():
        vi = int(v)
        for vg in ob.vertex_groups: vg.remove([vi])
        for g, w in groups.items(): ob.vertex_groups[g].add([vi], w, 'REPLACE')
    ob.data.update()


def apply_weights(obj_name, fix_path, backup_path):
    """Apply {vertex: {'new': {bone: w}}}; the original groups of every touched vertex are kept in backup_path."""
    ob = bpy.data.objects[obj_name]; me = ob.data; data = json.load(open(fix_path))['changed']
    names = {vg.index: vg.name for vg in ob.vertex_groups}
    backup = json.load(open(backup_path)) if os.path.exists(backup_path) else {}
    for v in data:
        if v not in backup: backup[v] = {names[g.group]: g.weight for g in me.vertices[int(v)].groups}
    json.dump(backup, open(backup_path, 'w'))
    for v, d in data.items():
        vi = int(v)
        for vg in ob.vertex_groups: vg.remove([vi])
        for g, w in d['new'].items():
            (ob.vertex_groups.get(g) or ob.vertex_groups.new(name=g)).add([vi], w, 'REPLACE')
    me.update()
    return len(data)
