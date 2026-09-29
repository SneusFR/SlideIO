"""Belly / flank dent metric for the TP Potato: change of the mesh Laplacian (vertex - mean of its neighbours) on the
torso vertices that the arm bones influence. Smooth moves cost nothing; dents / folds do."""
import numpy as np
from rig import skin_vertices
from tp_rig import ch
_i = ch.idx['Potato']; _n = ch.nodes[_i]; _prim = ch.mesh_data(_n['mesh'])[0]
_sk = ch.js['skins'][_n['skin']]; JN = [ch.names[j] for j in _sk['joints']]
J, WT, POS = _prim['joints'], _prim['weights'], _prim['pos']
ARMB = [b for b in JN if any(k in b for k in ['Shoulder', 'UpperArm', 'LowerArm', 'Hand', 'Index', 'Middle', 'Ring', 'Thumb', 'Weapon'])]
DOM = np.array([JN[J[k][np.argmax(WT[k])]] for k in range(len(J))])
W_ARM = sum((WT * (J == JN.index(b))).sum(1) for b in ARMB)
TORSO = np.nonzero(~np.isin(DOM, ARMB) & (W_ARM > 0.005))[0]
# neighbours from the triangle list
F = _prim['idx']
nb = [set() for _ in range(len(POS))]
for a, b, c in F:
    nb[a].update((b, c)); nb[b].update((a, c)); nb[c].update((a, b))
# vertices involved: torso set + their neighbours
INV = sorted(set(TORSO) | set(j for t in TORSO for j in nb[t]))
IDX = {v: k for k, v in enumerate(INV)}
NB = [np.array([IDX[j] for j in nb[t]]) for t in TORSO]
TK = np.array([IDX[t] for t in TORSO])
SUBJ, SUBW, SUBP = J[INV], WT[INV], POS[INV]
REST = ch.rest_pose()


def skinned_sub(W):
    mats = ch.skin_matrices(W, _n['skin'])
    return skin_vertices(SUBP, SUBJ, SUBW, mats)


from scipy import sparse as _sp
_rows, _cols, _vals = [], [], []
for _k in range(len(TK)):
    _rows.append(_k); _cols.append(TK[_k]); _vals.append(1.0)
    for _nn in NB[_k]:
        _rows.append(_k); _cols.append(_nn); _vals.append(-1.0 / len(NB[_k]))
LMAT = _sp.csr_matrix((_vals, (_rows, _cols)), shape=(len(TK), len(INV)))


def laplacian(V):
    return LMAT @ V


def rest_arms(P):
    Pr = dict(P)
    for s in 'LR':
        for b in [f'Shoulder_{s}', f'UpperArm_{s}', f'LowerArm_{s}', f'Hand_{s}']: Pr[b] = REST[b]
    return Pr


ARM_IDX = [JN.index(b) for b in ARMB]
CHEST = JN.index('Chest')


def skin_mats(P):
    return ch.skin_matrices(ch.world(P), _n['skin'])


def rigid_arm_mats(mats):
    """Reference skinning: every arm bone carried rigidly by the chest (the torso shape without arm pulls)."""
    m2 = mats.copy()
    for k in ARM_IDX: m2[k] = mats[CHEST]
    return m2


def dent(P, P_ref=None):
    """Per-torso-vertex Laplacian change (m): pose P vs the same pose where the arm bones do not pull the torso.
    (P_ref kept for compatibility: ignored.)"""
    mats = skin_mats(P)
    V = skin_vertices(SUBP, SUBJ, SUBW, mats)
    Vr = skin_vertices(SUBP, SUBJ, SUBW, rigid_arm_mats(mats))
    return np.linalg.norm(laplacian(V) - laplacian(Vr), axis=1), Vr[TK]


if __name__ == '__main__':
    import sys, pickle; sys.argv = ['x']
    c4 = pickle.load(open('tp_clips.pkl', 'rb')); c5 = pickle.load(open('tp_clips_v5.pkl', 'rb'))
    def rep(tag, P):
        d, Vr = dent(P); out = []
        for side, m in [('R', Vr[:, 0] < 0), ('L', Vr[:, 0] > 0)]:
            for y0, y1 in [(0.0, 0.40), (0.40, 0.50), (0.50, 0.9)]:
                mm = m & (Vr[:, 1] >= y0) & (Vr[:, 1] < y1)
                out.append(f'{side}{y0:.1f}-{y1:.1f}: {d[mm].max()*1000:4.1f}' if mm.any() else '')
        k = np.argmax(d); print(f'{tag:9s}', ' '.join(out), ' worst at', np.round(Vr[k], 3))
    rep('hexHold', T.hex_pose('TP_Hold_HexSniper', 0)); rep('hexAim', T.hex_pose('TP_Aim_HexSniper', 0))
    P = dict(REST); P.update(c4['TP_Hold_PopcornShotgun']['frames'][0]); rep('v4hold', P)
    P = dict(REST); P.update(c5['TP_Hold_PopcornShotgun']['frames'][0]); rep('v5hold', P)
    print('torso verts', len(TORSO), 'sub', len(INV))
