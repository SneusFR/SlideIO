import sys, os, pickle
sys.path.insert(0, '/home/claude/fl'); os.chdir('/home/claude/fl')
import numpy as np
import author_fp as A, fp_natural as N
from fp_common import arms, render
from PIL import Image
pk, clip, out = sys.argv[1], sys.argv[2], sys.argv[3]; times = [float(x) for x in sys.argv[4:]]
c = pickle.load(open(pk, 'rb'))[clip]
W0 = int(os.environ.get("W", 480)); H0 = W0 * 9 // 16; cols = int(os.environ.get("COLS", 3))
ims = []
for t in times:
    i = min(len(c['frames']) - 1, int(round(t * c['fps'])))
    P = dict(A.REST); P.update(c['frames'][i]); W = arms.world(P)
    s = N.stats(W)
    e = c['errors'][i]
    im, _, _ = render(P, A.M_FP, c['weapon'][i], size=(W0, H0), markers=False,
                      label=f"t={t:.2f} L{e[2]*1000:.1f}mm/{e[3]:.0f}d tw {s['hand_tw']:.0f}/{s['fore_tw']:.0f} el {s['elbow']:.0f}")
    ims.append(im)
rows = (len(ims) + cols - 1) // cols
S = Image.new('RGB', (W0 * cols, H0 * rows))
for k, im in enumerate(ims): S.paste(im, ((k % cols) * W0, (k // cols) * H0))
S.save(out)
