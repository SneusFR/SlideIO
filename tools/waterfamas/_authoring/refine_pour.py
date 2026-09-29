"""Numerical limb IK (least squares) on the Potato rig, chain-only FK for speed."""
import numpy as np
from scipy.optimize import least_squares
from scipy.spatial.transform import Rotation as Rot
from rig import trs, qmul, qnorm


def rv_to_q(rv):
    return Rot.from_rotvec(rv).as_quat()  # x,y,z,w


class ChainIK:
    """
    chain: ordered bones from the chain root to the effector's parent.
    rot_bones: bones whose rotation is solved (others keep the reference rotation).
    trans_bones: bones whose translation is solved (offscreen shoulder slide, like the HexSniper clips).
    """

    def __init__(self, rig, chain, effector, rot_bones=None, trans_bones=()):
        self.rig = rig
        self.chain = list(chain)
        self.effector = effector
        self.rot_bones = list(rot_bones) if rot_bones is not None else list(chain)
        self.trans_bones = list(trans_bones)
        self.parent_of_root = rig.names[rig.parent[rig.idx[self.chain[0]]]]
        self.nx = 3 * len(self.rot_bones) + 3 * len(self.trans_bones)

    def fk(self, pose, Wp, x, ref, worlds=None):
        M = Wp
        out = {}
        nr = len(self.rot_bones)
        for b in self.chain:
            T, R, S = ref[b]
            q = R
            if b in self.rot_bones:
                k = self.rot_bones.index(b)
                q = qmul(R, rv_to_q(x[3 * k:3 * k + 3]))
            t = T
            if b in self.trans_bones:
                k = self.trans_bones.index(b)
                t = T + x[3 * nr + 3 * k: 3 * nr + 3 * k + 3]
            M = M @ trs(t, q, S)
            out[b] = (np.array(t, float), qnorm(q), S)
            if worlds is not None:
                worlds[b] = M
        T, R, S = pose[self.effector]
        return M @ trs(T, R, S), out

    def solve(self, pose, W, target, ref, w_pos=1.0, w_rot=0.5, reg_rot=0.02, reg_trans=0.01, x0=None,
              x_prev=None, w_smooth=0.0, extra=None):
        """reg_rot: scalar or per-rot-bone list. extra(worlds) -> residual array (soft constraints)."""
        Wp = W[self.parent_of_root]
        tp = target[:3, 3]
        tR = target[:3, :3] / np.linalg.norm(target[:3, :3], axis=0)
        nr = len(self.rot_bones)
        rr = list(reg_rot) if np.ndim(reg_rot) else [reg_rot] * nr
        regs = np.array(sum([[r] * 3 for r in rr], []) + [reg_trans * 1000.0 / 57.3] * (3 * len(self.trans_bones)))

        def res(x):
            wl = {} if extra is not None else None
            E, _ = self.fk(pose, Wp, x, ref, wl)
            r = [(E[:3, 3] - tp) * (1000.0 * w_pos)]
            ER = E[:3, :3] / np.linalg.norm(E[:3, :3], axis=0)
            r.append(Rot.from_matrix(tR.T @ ER).as_rotvec() * (57.3 * w_rot))
            r.append(x * 57.3 * regs)
            if x_prev is not None and w_smooth > 0:
                r.append((x - x_prev) * 57.3 * w_smooth)
            if extra is not None:
                wl[self.effector] = E
                r.append(np.atleast_1d(extra(wl)))
            return np.concatenate(r)

        x = np.zeros(self.nx) if x0 is None else np.array(x0, float)
        sol = least_squares(res, x, method="lm", xtol=1e-10, ftol=1e-10, max_nfev=3000)
        E, locs = self.fk(pose, Wp, sol.x, ref)
        new_pose = dict(pose)
        new_pose.update(locs)
        perr = np.linalg.norm(E[:3, 3] - tp)
        ER = E[:3, :3] / np.linalg.norm(E[:3, :3], axis=0)
        rerr = np.degrees(np.linalg.norm(Rot.from_matrix(tR.T @ ER).as_rotvec()))
        return new_pose, sol.x, perr, rerr
