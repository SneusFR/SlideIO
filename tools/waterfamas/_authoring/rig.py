import sys, os, pickle, numpy as np
sys.path.insert(0, '/home/claude/wf'); os.chdir('/home/claude/wf')
sys.argv_saved = list(sys.argv)
import author_fp as A, fp_natural as N, weapon_def as wd
from fp_common import arms, weapon_root_world, render
from anim_util import normalized
from raster import look_at
from PIL import Image
import importlib.util
spec = importlib.util.spec_from_file_location("R2", "/home/claude/wf/opt/refine_uns2.py"); R2 = importlib.util.module_from_spec(spec); spec.loader.exec_module(R2)
v = pickle.load(open(sys.argv[1], "rb"))
ims = []
side = look_at(np.array([-0.45, 0.05, -0.2]), np.array([0.1, -0.2, -0.55]))
for h in (-45, 0, 45):
    G, pl = R2.gun_for(v, h)
    pose, xR, eR, sR = N.solve_right(R2.base, G)
    Wn = wd.world_nodes(weapon_root_world(arms.world(pose), A.M_FP))
    pp, x, e, s = N.solve_left(pose, normalized(A.cap_push(v[6] + h)(Wn)))
    for n in A.FINGERS_L: pp[n] = (A.REST[n][0], A.finger_q(n, 1.2), A.REST[n][2])
    im, _, _ = render(pp, A.M_FP, dict(), size=(480, 270), label=f"stroke {h:+d}")
    ims.append(im)
    im2, _, _ = render(pp, A.M_FP, dict(), size=(480, 270), cam=side, fov=50, label=f"side {h:+d}")
    ims.append(im2)
out = Image.new("RGB", (960, 270 * 3))
for i, im in enumerate(ims): out.paste(im, ((i % 2) * 480, (i // 2) * 270))
out.save(sys.argv[2])
