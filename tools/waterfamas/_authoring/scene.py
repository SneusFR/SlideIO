"""Max visibility (NDC margin inside the 65 deg frustum) of the LEFT arm / sleeve samples over a clip."""
import sys, os, pickle, numpy as np
sys.path.insert(0, '/home/claude/wf'); os.chdir('/home/claude/wf')
import author_fp as A
from fp_common import arms
import fp_idle_left as I
I.NDC_OUT = 1.0
pk = sys.argv[1]; clip = sys.argv[2] if len(sys.argv) > 2 else 'FP_Reload_WaterFamas'
c = pickle.load(open(pk, 'rb'))[clip]
names = ["sleeve end", "sleeve mid", "shoulder", "upper arm", "elbow", "wrist", "tip"]
bad = []
for i, f in enumerate(c['frames']):
    P = dict(A.REST); P.update(f); W = arms.world(P)
    v = [I.visibility(p) for p in I.arm_points(W)]
    if max(v[:2]) > 0: bad.append((round(i / c["fps"], 3), [names[k] for k in range(2) if v[k] > 0], round(max(v[:2]), 2)))
print(clip, "frames with the SLEEVE in view:", len(bad))
for b in bad[:40]: print("  ", b)
