"""Potato_TP_Character — flank / armpit skin-weight repair (linear least squares).

Skinned positions are linear in the weights, so is the mesh Laplacian. For the torso vertices that the
shoulder / upper-arm bones pull (flanks and belly under the armpits) we solve new weights so that, over a set
of arms-up poses (the new straight TP stance, HexSniper aim / hold, reload / fire extremes), the local shape
(Laplacian) of the flank stays the one of the clean body with the arms at rest — no fold, no dent — while
staying close to the original weights and smooth over the mesh. The arm tube itself is not touched."""
import sys, pickle, numpy as np
from scipy.optimize import lsq_linear
from scipy import sparse
sys.argv = sys.argv[:1]
import author_tp as T
import belly as B
from rig import skin_vertices

ch = T.ch
REST = ch.rest_pose()
JN, J0, W0, POS = B.JN, B.J.copy(), B.WT.copy(), B.POS
NV = len(POS)
IBM = None


def bind_positions():
    return skin_vertices(POS, J0, W0, ch.skin_matrices(ch.world(REST), B._n["skin"]))


VB = bind_positions()
VB_BIND = POS.copy()                       # mesh as modelled (bind space)
BODY_BONES = {"Hips", "Spine", "Spine_1", "Chest", "Neck", "Head", "Back", "Root"}
ARM = {s: [f"Shoulder_{s}", f"UpperArm_{s}", f"LowerArm_{s}", f"Hand_{s}"] for s in "LR"}
# --- weld the seam duplicates (glTF splits vertices at UV seams): they MUST keep identical weights,
# otherwise the skin tears open. Everything below works on one representative per welded position.
from collections import defaultdict
_key = np.round(POS / 1e-5).astype(np.int64)
_, _INVW = np.unique(_key, axis=0, return_inverse=True)
_INVW = _INVW.ravel()
REP = np.zeros(NV, int); _first = {}
for _v in range(NV):
    _g = int(_INVW[_v]); _first.setdefault(_g, _v); REP[_v] = _first[_g]
MEMBERS = defaultdict(list)
for _v in range(NV): MEMBERS[int(REP[_v])].append(_v)
_nbw = [set() for _ in range(NV)]
for _v in range(NV):
    for _n in B.nb[_v]:
        if REP[_n] != REP[_v]: _nbw[REP[_v]].add(int(REP[_n]))
nb = [np.array(sorted(x)) for x in _nbw]


def region():
    """Vertices whose weights we may change + objective weight per vertex (0 near the arm root, 1 on the flank)."""
    Wr = ch.world(REST)
    sel, objw = [], np.zeros(NV)
    for s in "LR":
        ku, ksh = JN.index(f"UpperArm_{s}"), JN.index(f"Shoulder_{s}")
        wu = (W0 * (J0 == ku)).sum(1); wsh = (W0 * (J0 == ksh)).sum(1)
        ua = Wr[f"UpperArm_{s}"][:3, 3]; el = Wr[f"LowerArm_{s}"][:3, 3]; ax = (el - ua) / np.linalg.norm(el - ua)
        rel = VB - ua; sa = rel @ ax; radv = rel - np.outer(sa, ax); rad = np.linalg.norm(radv, axis=1)
        side = np.sign(VB[:, 0]) == np.sign(ua[0])
        dom = np.array([JN[J0[v][np.argmax(W0[v])]] for v in range(NV)])
        body_like = np.isin(dom, list(BODY_BONES)) | ((dom == f"UpperArm_{s}") & (rad > 0.045) & ((radv[:, 0] * np.sign(ua[0])) < 0)) \
            | ((dom == f"Shoulder_{s}") & (VB[:, 1] < ua[1] + 0.02))
        cand = side & body_like & ((wu > 0.005) | ((wsh > 0.005) & (VB[:, 1] < ua[1] + 0.03)))
        cand &= VB[:, 1] < ua[1] + 0.06
        for v in np.nonzero(cand)[0]:
            sel.append(v)
            # objective strength: flank / belly below the armpit counts fully, the rim of the arm root less
            d_arm = rad[v] - 0.045
            objw[v] = max(objw[v], float(np.clip(d_arm / 0.03, 0.15, 1.0)) * (1.0 if VB[v, 1] < ua[1] - 0.01 else 0.6))
    reps = sorted(set(int(REP[v]) for v in sel))
    for v in sel: objw[REP[v]] = max(objw[REP[v]], objw[v])
    return np.array(reps), objw


SEL, OBJW = region()


def _ring(sel, hops=2):
    out = set(int(v) for v in sel)
    front = set(out)
    for _ in range(hops):
        nxt = set()
        for v in front:
            for n in nb[v]:
                if n not in out: nxt.add(int(n))
        out |= nxt; front = nxt
    return out


_arm_names = {f"{b}_{s}" for s in "LR" for b in ("UpperArm", "Shoulder")}
_dom = np.array([JN[J0[v][np.argmax(W0[v])]] for v in range(NV)])
RING = sorted(v for v in _ring(SEL, 2) if v not in set(int(x) for x in SEL) and _dom[v] in _arm_names)
SEL = np.array(sorted(set(int(v) for v in SEL) | set(RING)))
for v in RING: OBJW[v] = 0.6
SELSET = {v: k for k, v in enumerate(SEL)}


def allowed_bones(v):
    """Bones whose weight may change for vertex v: its current influences + Spine_1 if a slot is free."""
    b = [int(j) for j, w in zip(J0[v], W0[v]) if w > 1e-6]
    ks1 = JN.index("Spine_1")
    if ks1 not in b and len(b) < 4: b.append(ks1)
    return b


VARS = []                                  # (vertex, joint index)
for v in SEL:
    for k in allowed_bones(v):
        VARS.append((v, k))
VAR_ID = {vk: i for i, vk in enumerate(VARS)}
NVAR = len(VARS)


def pose_points(P):
    """For a pose: skin matrices; returns function giving M_k @ v_bind."""
    mats = ch.skin_matrices(ch.world(P), B._n["skin"])
    return mats


def skinned_all(mats, W=W0, Jx=J0):
    return skin_vertices(POS, Jx, W, mats)


MAXD = 0.35


def build_system(poses, lam=8.0, mu=5.0, unit=1000.0):
    rows, cols, vals, rhs = [], [], [], []
    r = 0
    ph = np.c_[POS, np.ones(NV)]
    ring = set(int(n) for v in SEL for n in nb[v])
    obj_vertices = sorted(set(int(v) for v in SEL) | ring | set(int(REP[v]) for v in B.TORSO))
    arm_dom = {v for v in range(NV) if JN[J0[v][np.argmax(W0[v])]] not in BODY_BONES}
    for P, pw in poses:
        mats = pose_points(P)
        V0 = skinned_all(mats)                                 # original skin (constants for non-variable vertices)
        # target local shape: the BIND-pose Laplacian rotated by the vertex's own blended rotation (original weights)
        Mb = np.einsum('vk,vkij->vij', W0, mats[J0])[:, :3, :3]
        # per variable: point M_k v
        pts = {}
        for (v, k) in VARS:
            pts[(v, k)] = (mats[k] @ ph[v])[:3]
        # fixed part of each variable vertex (bones not in its variable set)
        fixed = {}
        for v in SEL:
            f = np.zeros(3)
            ab = allowed_bones(v)
            for j, w in zip(J0[v], W0[v]):
                if w > 1e-6 and int(j) not in ab: f += w * (mats[int(j)] @ ph[v])[:3]
            fixed[v] = f
        for v in obj_vertices:
            ns = nb[v]
            if len(ns) == 0: continue
            wgt = (OBJW[v] if v in SELSET else (0.25 if v in arm_dom else 0.8)) * pw * unit
            U, _, Vt = np.linalg.svd(Mb[v]); Rv = U @ Vt
            target = Rv @ (VB_BIND[v] - VB_BIND[ns].mean(0))
            const = np.zeros(3)
            # L(v) = V_v - mean(V_n)
            terms = []                                          # (var id, coef vector 3)
            if v in SELSET:
                const += fixed[v]
                for k in allowed_bones(v): terms.append((VAR_ID[(v, k)], pts[(v, k)]))
            else:
                const += V0[v]
            for n in ns:
                c = -1.0 / len(ns)
                if n in SELSET:
                    const += c * fixed[n]
                    for k in allowed_bones(n): terms.append((VAR_ID[(n, k)], c * pts[(n, k)]))
                else:
                    const += c * V0[n]
            for d in range(3):
                for (i, coef) in terms:
                    rows.append(r); cols.append(i); vals.append(wgt * coef[d])
                rhs.append(wgt * (target[d] - const[d])); r += 1
    # regularisation: close to the original weights
    for (v, k), i in VAR_ID.items():
        w0 = float(W0[v][list(J0[v]).index(k)]) if (k in list(J0[v]) and W0[v][list(J0[v]).index(k)] > 1e-6) else 0.0
        rows.append(r); cols.append(i); vals.append(lam); rhs.append(lam * w0); r += 1
    # smoothness of each bone's weight over the mesh graph (neighbours in the region)
    for v in SEL:
        for k in allowed_bones(v):
            nbs = [n for n in nb[v] if n in SELSET and (n, k) in VAR_ID]
            if not nbs: continue
            rows.append(r); cols.append(VAR_ID[(v, k)]); vals.append(mu)
            for n in nbs:
                rows.append(r); cols.append(VAR_ID[(n, k)]); vals.append(-mu / len(nbs))
            rhs.append(0.0); r += 1
    # partition of unity (the allowed bones keep the same total as before)
    for v in SEL:
        ab = allowed_bones(v)
        tot = sum(float(w) for j, w in zip(J0[v], W0[v]) if w > 1e-6 and int(j) in ab)
        for k in ab:
            rows.append(r); cols.append(VAR_ID[(v, k)]); vals.append(3000.0)
        rhs.append(3000.0 * tot); r += 1
    A = sparse.csr_matrix((vals, (rows, cols)), shape=(r, NVAR))
    return A, np.array(rhs)


def solve(poses, **kw):
    A, b = build_system(poses, **kw)
    x0 = np.zeros(NVAR)
    for (v, k), i in VAR_ID.items():
        if k in list(J0[v]): x0[i] = W0[v][list(J0[v]).index(k)]
    # per-variable bounds: no weight moves by more than MAXD; the arm tube keeps most of its arm weight
    lb = np.zeros(NVAR); ub = np.ones(NVAR)
    armw = {JN.index(f"{b}_{s_}") for s_ in "LR" for b in ("UpperArm", "LowerArm")}
    for (v, k), i in VAR_ID.items():
        w0 = x0[i]
        lb[i] = max(0.0, w0 - MAXD); ub[i] = min(1.0, w0 + MAXD)
        dom = int(J0[v][np.argmax(W0[v])])
        if k in armw and k == dom: lb[i] = max(lb[i], 0.75 * w0)
        ub[i] = max(ub[i], lb[i] + 1e-6)
    sol = lsq_linear(A, b, bounds=(lb, ub), lsmr_tol="auto", max_iter=20000, verbose=0, tol=1e-12)
    J1, W1 = J0.copy(), W0.copy()
    for v in SEL:
        ab = allowed_bones(v)
        new = {k: sol.x[VAR_ID[(v, k)]] for k in ab}
        # write back into the 4 slots (Spine_1 takes a free slot if it was added)
        slots = list(J1[v])
        for k, w in new.items():
            if k in slots and (W0[v][slots.index(k)] > 1e-6 or k != JN.index("Spine_1")):
                W1[v][slots.index(k)] = w
            else:
                free = [i for i in range(4) if W1[v][i] <= 1e-6 and int(J1[v][i]) not in new]
                if not free:
                    free = [i for i in range(4) if W1[v][i] <= 1e-6]
                i = free[0]; J1[v][i] = k; W1[v][i] = w
        s = W1[v].sum(); W1[v] /= s
        for m in MEMBERS[int(v)]:
            J1[m] = J1[v]; W1[m] = W1[v]
    return J1, W1, sol


def dent_with(P, J1, W1, P_ref=None):
    B.SUBJ, B.SUBW = J1[B.INV], W1[B.INV]
    try:
        return B.dent(P, P_ref)
    finally:
        B.SUBJ, B.SUBW = B.J[B.INV], B.WT[B.INV]



def arap_err(P, Jx, Wx, verts):
    """Max local-shape error (mm) of `verts`: posed Laplacian vs bind Laplacian rotated by the vertex's blended rotation."""
    mats = ch.skin_matrices(ch.world(P), B._n["skin"])
    V = skin_vertices(POS, Jx, Wx, mats)
    Mb = np.einsum('vk,vkij->vij', Wx, mats[Jx])[:, :3, :3]
    out = []
    for v in verts:
        ns = nb[v]
        if len(ns) == 0: out.append(0.0); continue
        U, _, Vt = np.linalg.svd(Mb[v]); Rv = U @ Vt
        out.append(np.linalg.norm((V[v] - V[ns].mean(0)) - Rv @ (POS[v] - POS[ns].mean(0))) * 1000)
    return np.array(out)


if __name__ == "__main__":
    import tp_straight as S
    print("region vertices", len(SEL), "variables", NVAR)
    key = pickle.load(open("tp_straight_hold.pkl", "rb"))[0]
    keyd = pickle.load(open("tp_straight_hold_d.pkl", "rb"))[0]
    c4 = pickle.load(open("tp_clips.pkl", "rb"))
    poses = [(dict(REST, **key), 1.0), (dict(REST, **keyd), 1.0),
             (dict(REST, **T.hex_pose("TP_Aim_HexSniper", 0.0)), 0.8), (dict(REST, **T.hex_pose("TP_Hold_HexSniper", 0.0)), 0.8)]
    for nm, idx in [("TP_Reload_PopcornShotgun", [20, 40, 60]), ("TP_Fire_PopcornShotgun", [3, 24]), ("TP_Run_PopcornShotgun", [0, 12])]:
        for i in idx:
            P = dict(REST); P.update(c4[nm]["frames"][i]); poses.append((P, 0.5))
    J1, W1, sol = solve(poses)
    np.save("tp_weights_J.npy", J1); np.save("tp_weights_W.npy", W1)
    print("lsq status", sol.status, "cost", round(float(sol.cost), 4))
    EV = sorted(set(int(v) for v in SEL) | set(int(n) for v in SEL for n in nb[v]))
    EV = np.array(EV); side = np.sign(VB[EV, 0])
    for tag, P in [("straight key", dict(REST, **key)), ("hex aim", dict(REST, **T.hex_pose("TP_Aim_HexSniper", 0.0))),
                   ("hex hold", dict(REST, **T.hex_pose("TP_Hold_HexSniper", 0.0))), ("rest", dict(REST))]:
        e0 = arap_err(P, J0, W0, EV); e1 = arap_err(P, J1, W1, EV)
        print(f"ARAP {tag:12s} before R {e0[side < 0].max():5.1f} L {e0[side > 0].max():5.1f} (mean {e0.mean():4.1f}) -> after R {e1[side < 0].max():5.1f} L {e1[side > 0].max():5.1f} (mean {e1.mean():4.1f})")
    for tag, P in [("straight key", dict(REST, **key)), ("straight key d", dict(REST, **keyd)), ("hex aim", dict(REST, **T.hex_pose("TP_Aim_HexSniper", 0.0))),
                   ("hex hold", dict(REST, **T.hex_pose("TP_Hold_HexSniper", 0.0))), ("hex run 0.3", dict(REST, **T.hex_pose("TP_Run_HexSniper", 0.3)))]:
        d0, vr = B.dent(P); d1, _ = dent_with(P, J1, W1)
        R, L = vr[:, 0] < 0, vr[:, 0] > 0
        print(f"{tag:16s} before R {d0[R].max()*1000:5.1f} L {d0[L].max()*1000:5.1f}  ->  after R {d1[R].max()*1000:5.1f} L {d1[L].max()*1000:5.1f}")
    dw = np.abs(W1 - W0).sum(1)
    print("changed vertices", int((dw > 0.01).sum()), "max weight change", round(float(dw.max()), 3))
