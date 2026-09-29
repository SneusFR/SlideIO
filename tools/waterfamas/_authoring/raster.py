import sys, os, pickle, numpy as np
sys.path.insert(0, '/home/claude/wf'); os.chdir('/home/claude/wf')
import author_fp as A, fp_natural as N, weapon_def as wd
from fp_common import arms, weapon_root_world, render
from anim_util import normalized
from raster import look_at
from PIL import Image
import importlib.util
spec = importlib.util.spec_from_file_location("RP", "/home/claude/wf/opt/refine_pour.py"); RP = importlib.util.module_from_spec(spec); spec.loader.exec_module(RP)
v = pickle.load(open(sys.argv[1], "rb"))
G, pl = RP.gun_for(v)
pose, xR, eR, sR = N.solve_right(RP.base, G)
Ga = weapon_root_world(arms.world(pose), A.M_FP)
Wn = wd.world_nodes(Ga, 0.0, 0.5, 1.0)
Bs, op, n, a0, a1 = RP.bottle_keys(v, Wn)
ims = []
side = look_at(np.array([-0.45, 0.05, -0.2]), np.array([0.1, -0.2, -0.55]))
for k, B in enumerate(Bs):
    pp, x, e, s = N.solve_left(pose, RP.hand_on(B))
    for f, c in A.BOTTLE_CURLS.items(): pp[f] = (A.REST[f][0], A.finger_q(f, c), A.REST[f][2])
    Bl = B.copy(); Bl[:3, :3] *= A.GUN_SCALE; bl = np.linalg.inv(Ga) @ Bl
    ws = dict(cap_turn=0.5, hinge=1.0, bottle=bl, level=0.5)
    im, _, _ = render(pp, A.M_FP, ws, size=(480, 270), label=f"pour{k}")
    ims.append(im)
    im2, _, _ = render(pp, A.M_FP, ws, size=(480, 270), cam=side, fov=50, label=f"side pour{k}")
    ims.append(im2)
out = Image.new("RGB", (960, 540))
for i, im in enumerate(ims): out.paste(im, ((i % 2) * 480, (i // 2) * 270))
out.save(sys.argv[2])
