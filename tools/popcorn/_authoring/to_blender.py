"""Export baked FP clips (fp_clips_v4.pkl) as glTF-local TRS per frame for psb_tools.load_clips."""
import sys, json, pickle, numpy as np
import weapon_def as wd
from rig import decompose
names = sys.argv[2:]; outp = sys.argv[1]
clips = pickle.load(open('fp_clips_v4.pkl', 'rb'))
def trq(M):
    t, r, s = decompose(M); return [list(map(float, t)), list(map(float, r))]
out = {}
for nm in names:
    c = clips[nm]; frames = []
    for f, (pump, lid, trig) in zip(c['frames'], c['weapon']):
        L = wd.node_locals(pump, lid, trig)
        frames.append({'bones': {b: [list(map(float, f[b][0])), list(map(float, f[b][1]))] for b in f},
                       'objects': {n: trq(L[n]) for n in ('Pump', 'TankLid', 'Trigger')}})
    out[nm] = {'fps': c['fps'], 'frames': frames}
json.dump(out, open(outp, 'w'))
print('wrote', outp, {k: len(v['frames']) for k, v in out.items()})
