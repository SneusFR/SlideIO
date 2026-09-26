"""Shared FP authoring context: arms rig, HexSniper reference poses, weapon mount."""
import json, numpy as np
from rig import Rig, trs, decompose, qaxis, qmul
from scene import drawables
from raster import Renderer, look_at
import weapon_def as wd

arms = Rig('Potato_FP_CommonArms.glb')
hexposes = Rig('HexSniper_FP_Poses.glb')
hexprof = json.load(open('WeaponProfile_HexSniper.json'))
M_HEX_FP = np.array(hexprof['mounts']['fp']['matrixColumnMajor']).reshape(4, 4).T
S_ROOT = trs(s=(wd.ROOT_SCALE,) * 3)
HEX_GRIP = np.array([1.47, -0.17, 0.0])

def hold_ref():
    return arms.pose_from_clip(hexposes.clips['FP_HexSniper_Hold'], 0.0)

def mount_from(offset_local=(0, 0, 0), rot_about_grip=None):
    """FP mount = HexSniper mount re-centred on our grip (+ optional tweak rotation about our grip)."""
    M = M_HEX_FP @ trs(wd.ROOT_SCALE * (HEX_GRIP - wd.GRIP + np.asarray(offset_local)))
    if rot_about_grip is not None:
        g = wd.ROOT_SCALE * wd.GRIP
        M = M @ trs(g) @ trs(r=rot_about_grip) @ trs(-g)
    return M

def weapon_root_world(W, M):
    return W['Weapon_R'] @ M @ S_ROOT

def render(pose, M, pump=0.0, lid=0.0, trig=0.0, popcorn=None, kernels=None, size=(640, 360), cam=None,
           label=None, markers_extra=(), fov=65):
    W = arms.world(pose)
    G = weapon_root_world(W, M)
    Wn = wd.world_nodes(G, pump, lid, trig)
    r = Renderer(*size, fov=fov)
    if cam is not None: r.set_camera(cam)
    for d in drawables(arms, W): r.draw(*d)
    wd.draw_weapon(r, Wn, popcorn, kernels)
    mk = [(W['Weapon_L'][:3, 3], (0, 255, 255)), (W['Weapon_R'][:3, 3], (255, 255, 0))]
    if 'Offhand' in Wn: mk.append((Wn['Offhand'][:3, 3], (0, 255, 0)))
    mk += list(markers_extra)
    return r.image(markers=mk, label=label), W, Wn
