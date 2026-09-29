import sys, os, json
sys.path.insert(0, '/home/claude/fl'); os.chdir('/home/claude/fl')
import numpy as np
import opt.search_keys as S, author_fp as A
from fp_common import render
from PIL import Image
ks = json.loads(sys.argv[1]); out = sys.argv[2]
ims = []
for k, v in ks.items():
    c, pose, st, info = S.evaluate(np.array(v, float), k, True)
    im, _, _ = render(pose, A.M_FP, st, size=(640, 360), label=f"{k} {info['e']:.1f}mm {info['r']:.1f}d", markers=False)
    ims.append(im)
Sx = Image.new("RGB", (1280, 360 * ((len(ims) + 1) // 2)))
for i, im in enumerate(ims): Sx.paste(im, ((i % 2) * 640, (i // 2) * 360))
Sx.save(out)
