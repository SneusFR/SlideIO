import pickle, numpy as np, sys
from fp_common import arms
from straight import screen_bends, wrist_stats
nm = sys.argv[1] if len(sys.argv) > 1 else 'FP_Reload_PopcornShotgun'; step = int(sys.argv[2]) if len(sys.argv) > 2 else 4
c = pickle.load(open('fp_clips_v4.pkl','rb'))[nm]
base = arms.rest_pose()
for i in range(0, len(c['frames']), step):
    p = dict(base); p.update(c['frames'][i]); wl = arms.world(p)
    e = c['errors'][i]; hs, ht, ls, lt = wrist_stats(wl); be, bw = screen_bends(wl); rs = wrist_stats(wl, 'R')
    print(f't={i/c["fps"]:.2f} L {e[2]*1000:6.1f}mm {e[3]:5.1f}deg | wrist sw {hs:4.0f} tw {ht:4.0f} fore sw {ls:4.0f} tw {lt:4.0f} | bends {be:4.0f}/{bw:4.0f} | R tw {rs[1]:4.0f}/{rs[3]:4.0f} | slide {np.linalg.norm(p["Shoulder_L"][0]-c["frames"][0]["Shoulder_L"][0])*100:4.1f}cm | pump/lid {c["weapon"][i][0]:.2f}/{c["weapon"][i][1]:.0f}')
