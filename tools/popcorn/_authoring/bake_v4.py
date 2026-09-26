import sys, pickle, time
names = sys.argv[1:]; sys.argv = sys.argv[:1]
import author_fp as A
try:
    out = pickle.load(open('fp_clips_v4.pkl', 'rb'))
except Exception:
    out = {}
for nm in names:
    t = time.time()
    out[nm] = A.bake(nm)
    print(nm, 'time', round(time.time() - t), flush=True)
    out['_meta'] = dict(mount=A.M_FP, hold=A.HOLD, aim=A.AIM, offhand=A.wd.OFFHAND_LOCAL, channels=A.CHANNELS)
    pickle.dump(out, open('fp_clips_v4.pkl', 'wb'))
