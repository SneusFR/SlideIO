"""v4 — 'straight arm on screen' objective for the left arm + hand roll around the pump axis."""
import numpy as np
from scipy.spatial.transform import Rotation as Rot
from twist import swing_twist

F65 = 1 / np.tan(np.radians(65) / 2)


def scr(p):
    return np.array([F65 * p[0] / -p[2], F65 * p[1] / -p[2]])


def wrap(a):
    return (a + 180.0) % 360.0 - 180.0


def screen_angles(wl, side='L'):
    pts = [wl[f'UpperArm_{side}'][:3, 3], wl[f'LowerArm_{side}'][:3, 3], wl[f'Hand_{side}'][:3, 3], wl[f'Weapon_{side}'][:3, 3]]
    s = [scr(p) for p in pts]
    return [np.degrees(np.arctan2(*(s[i + 1] - s[i])[::-1])) for i in range(3)]


def screen_bends(wl, side='L'):
    a = screen_angles(wl, side)
    return wrap(a[1] - a[0]), wrap(a[2] - a[1])


def _lq(wl, p, c):
    Mp = wl[p][:3, :3] / np.linalg.norm(wl[p][:3, :3], axis=0)
    Mc = wl[c][:3, :3] / np.linalg.norm(wl[c][:3, :3], axis=0)
    return Rot.from_matrix(Mp.T @ Mc).as_quat()


def wrist_stats(wl, side='L'):
    hs, ht = swing_twist(_lq(wl, f'LowerArm_{side}', f'Hand_{side}'))
    ls, lt = swing_twist(_lq(wl, f'UpperArm_{side}', f'LowerArm_{side}'))
    return hs, ht, ls, lt


def straight_residual(wl, w_bend=0.6, hand_twist=-5.0, fore_twist=7.0, w_tw=0.35):
    be, bw = screen_bends(wl)
    hs, ht, ls, lt = wrist_stats(wl)
    return np.array([be * w_bend, bw * w_bend, (ht - hand_twist) * w_tw, (lt - fore_twist) * w_tw * 0.6])
