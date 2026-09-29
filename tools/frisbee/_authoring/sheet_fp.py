import sys, pickle, numpy as np
sys.path.insert(0, '/home/claude/fl')
import author_fp as A
from fp_common import arms
pk = pickle.load(open(sys.argv[1], "rb"))
for clip in sys.argv[2:]:
    c = pk[clip]; prev = None; js = []
    for i, f in enumerate(c["frames"]):
        P = dict(A.REST); P.update(f); W = arms.world(P)
        h = W["Hand_L"][:3, 3]
        if prev is not None: js.append((np.linalg.norm(h - prev) * c["fps"], i / c["fps"]))
        prev = h
    js.sort(reverse=True)
    print(clip, "top hand_L speeds m/s:", [(round(v, 2), round(t, 3)) for v, t in js[:5]])
