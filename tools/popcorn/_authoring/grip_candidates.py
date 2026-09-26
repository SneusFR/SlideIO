import numpy as np, pickle, sys
from PIL import Image
import grip_fit as gf
import weapon_def as wd
from raster import Renderer, look_at
from rig import trs
S = gf.UNIT
sel = set(gf.VSEL.tolist()); remap = {int(g): k for k, g in enumerate(gf.VSEL)}
FACES = np.array([[remap[a], remap[b], remap[c]] for a, b, c in gf.md['idx'] if a in sel and b in sel and c in sel])
parts = wd.parts()
Pm = trs(-wd.PUMP_ORIGIN * S) @ trs(s=(S, S, S))
CAM = np.array([0.82, 0.35, 0.45]); CAM /= np.linalg.norm(CAM)
def views(H, curls, label, dirs=((CAM, 'FP'), (np.array([0.05, -0.2, -1]), 'droite'), (np.array([0.1, -1, 0.1]), 'dessous'), (np.array([0.02, 0.2, 1]), 'gauche'))):
    v = gf.hand_vertices(H, curls); out = []
    for d, lab in dirs:
        d = d / np.linalg.norm(d)
        r = Renderer(300, 240, fov=40); r.set_camera(look_at(d * 0.22, np.array([0, 0.004, 0])))
        r.draw(v, FACES, np.array([0.55, 0.22, 0.06]))
        for nm in ['Pump', 'Body']:
            P, N, C = parts[nm].arrays()
            M = Pm if nm == 'Body' else Pm @ trs(wd.PUMP_ORIGIN)
            r.draw((M[:3, :3] @ P.T).T + M[:3, 3], np.arange(len(P)).reshape(-1, 3), C)
        out.append(r.image(label=f'{label} {lab}'))
    return out
if __name__ == '__main__':
    rows = []
    cands = []
    for th in [-25, -10, 5, 20]:
        for gap in [-0.008, -0.002, 0.004]:
            for psi in [-20, 0]:
                H = gf.frame_from_params(np.radians(th), np.radians(psi), 0.0, gap)
                cu = gf.close_fingers(H)
                pg, pp = gf.palm_gap(H, cu)
                cands.append((th, gap, psi, cu, pg, pp))
                print(f'th {th:4d} gap {gap:+.3f} psi {psi:4d} palm_gap {pg*1000:6.1f}mm palm_pen {pp*1000:5.1f}mm curls ' + ' '.join(f'{k[:1]}{v:.2f}' for k, v in cu.items()))
    pickle.dump(cands, open('grip_cands.pkl', 'wb'))
