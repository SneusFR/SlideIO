"""v4 — joint key-pose solver: BOTH arms + hand spin in one least-squares problem.
The gun hangs off Weapon_R exactly like in game; the left hand must hit a target defined on the gun
(lid / tank / pump), while both arms stay natural (straight on screen, limited twists) and the gun stays framed."""
import sys, numpy as np
from scipy.optimize import least_squares
from scipy.spatial.transform import Rotation as Rot
sys.argv = sys.argv[:1]
import author_fp as A
import weapon_def as wd
from straight import straight_residual, screen_bends, wrist_stats, scr

HOLD_G = A.gun_matrix(A.HOLD['grip'], A.HOLD['yaw'], A.HOLD['pitch'], A.HOLD['roll'])
HOLD_R = HOLD_G[:3, :3] / np.linalg.norm(HOLD_G[:3, :3], axis=0)


def spin_m(phi_deg):
    R = np.eye(4); c, s = np.cos(np.radians(phi_deg)), np.sin(np.radians(phi_deg)); R[1:3, 1:3] = [[c, -s], [s, c]]; return R


def gun_offsets(G):
    """grip displacement (m) and yaw/pitch/roll (deg) of gun matrix G relative to the HOLD placement."""
    R = G[:3, :3] / np.linalg.norm(G[:3, :3], axis=0)
    grip = (G @ np.r_[wd.GRIP, 1])[:3]
    rel = R @ HOLD_R.T
    ypr = Rot.from_matrix(rel).as_euler('YXZ', degrees=True)
    return grip - A.HOLD['grip'], ypr


def _outside(v, lo, hi):
    return max(0.0, lo - v) + max(0.0, v - hi)


def solve_key(hand_fn, lid=0.0, pump=0.0, trig=0.0, phi0=0.0, x0=None, w_straight=0.35,
              box=None, slide_max=0.16, max_nfev=400, verbose=True, center=None, w_center=0.0):
    box = box or dict(yaw=(-5, 25), pitch=(-12, 25), roll=(-65, 5), move=0.09)
    pose = dict(A.REF)
    W = A.arms.world(pose)
    WpR = W[A.ikR.parent_of_root]; WpL = W[A.ikL.parent_of_root]
    nR, nL = A.ikR.nx, A.ikL.nx
    shR0 = A.REF['Shoulder_R'][0]; shL0 = A.REF['Shoulder_L'][0]

    def build(x):
        xR, xL, phi = x[:nR], x[nR:nR + nL], x[-1]
        wR = {}
        ER, locR = A.ikR.fk(pose, WpR, xR, A.REF, wR)
        G = ER @ A.M_FP @ A.S_ROOT
        Wn = wd.world_nodes(G, pump, lid, trig)
        TL = A.normalized(hand_fn(Wn)) @ spin_m(phi)
        wL = {}
        EL, locL = A.ikL.fk(pose, WpL, xL, A.REF, wL)
        wL['Weapon_L'] = EL; wR['Weapon_R'] = ER
        return G, Wn, TL, EL, wL, wR, locR, locL

    def res(x):
        xR, xL, phi = x[:nR], x[nR:nR + nL], x[-1]
        G, Wn, TL, EL, wL, wR, locR, locL = build(x)
        r = [(EL[:3, 3] - TL[:3, 3]) * 1000.0]
        ELr = EL[:3, :3] / np.linalg.norm(EL[:3, :3], axis=0)
        r.append(Rot.from_matrix(TL[:3, :3].T @ ELr).as_rotvec() * 57.3 * 0.6)
        r.append(A.keep_left_limited(wL)); r.append(straight_residual(wL, w_bend=w_straight, w_tw=0.25))
        r.append(A.keep_right_limited(wR))
        r.append(xR[:9] * 57.3 * 0.03)
        sR = np.linalg.norm(locR['Shoulder_R'][0] - shR0); sL = np.linalg.norm(locL['Shoulder_L'][0] - shL0)
        r.append([max(0, sR - 0.05) * 300, max(0, sL - slide_max) * 300, sL * 20])
        mv, ypr = gun_offsets(G)
        r.append([_outside(ypr[0], *box['yaw']) * 2, _outside(ypr[1], *box['pitch']) * 2, _outside(ypr[2], *box['roll']) * 2,
                  max(0, np.linalg.norm(mv) - box['move']) * 500, np.linalg.norm(mv) * 40, abs(ypr[2]) * 0.03])
        tank = scr(Wn['Tank'][:3, 3]) / np.array([16 / 9, 1.0])
        r.append([max(0, np.abs(tank).max() - 0.72) * 60, phi * 0.005])
        if center is not None and w_center > 0:
            r.append((np.asarray(ypr) - np.asarray(center[3:])) * w_center)
            r.append((mv - np.asarray(center[:3])) * 1000 * w_center * 0.1)
        return np.concatenate([np.atleast_1d(np.asarray(a, float)).ravel() for a in r])

    x = np.zeros(nR + nL + 1) if x0 is None else np.array(x0, float)
    if x0 is None: x[-1] = phi0
    sol = least_squares(res, x, method='trf', max_nfev=max_nfev, diff_step=1e-4)
    x = sol.x
    G, Wn, TL, EL, wL, wR, locR, locL = build(x)
    new = dict(pose); new.update(locR); new.update(locL)
    Wf = A.arms.world(new)
    eL = np.linalg.norm(EL[:3, 3] - TL[:3, 3])
    rL = np.degrees(np.linalg.norm(Rot.from_matrix(TL[:3, :3].T @ (EL[:3, :3] / np.linalg.norm(EL[:3, :3], axis=0))).as_rotvec()))
    hs, ht, ls, lt = wrist_stats(Wf, 'L'); be, bw = screen_bends(Wf, 'L'); rhs, rht, rls, rlt = wrist_stats(Wf, 'R')
    mv, ypr = gun_offsets(G)
    sL = np.linalg.norm(locL['Shoulder_L'][0] - shL0)
    tank = scr(Wn['Tank'][:3, 3]) / np.array([16 / 9, 1.0])
    info = dict(eL=eL, rL=rL, hs=hs, ht=ht, ls=ls, lt=lt, be=be, bw=bw, rht=rht, rlt=rlt, move=mv, ypr=ypr,
                slideL=sL, tank=tank, phi=x[-1], cost=sol.cost, G=G)
    if verbose:
        print(f'   contact {eL*1000:.1f}mm {rL:.1f}deg | L wrist sw {hs:.0f} tw {ht:.0f} | fore sw {ls:.0f} tw {lt:.0f} | '
              f'bends {be:.0f}/{bw:.0f} | R wrist tw {rht:.0f} fore tw {rlt:.0f} | gun move {np.round(mv*100,1)}cm '
              f'ypr {np.round(ypr,0)} | slideL {sL*100:.0f}cm | phi {x[-1]:.0f} | tank {np.round(tank,2)} | cost {sol.cost:.1f}', flush=True)
    return new, x, info
