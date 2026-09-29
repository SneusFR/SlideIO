"""Keyframe tracks, easing and frame helpers shared by the FP / TP authoring scripts."""
import numpy as np
from rig import trs, qaxis, quat_to_mat3, mat3_to_quat, slerp


def ease(u, kind):
    u = float(np.clip(u, 0, 1))
    if kind == "lin": return u
    if kind == "io": return u * u * u * (u * (u * 6 - 15) + 10)       # smootherstep
    if kind == "sio": return u * u * (3 - 2 * u)                       # smoothstep
    if kind == "out": return 1 - (1 - u) ** 3
    if kind == "out2": return 1 - (1 - u) ** 2
    if kind == "in": return u ** 3
    if kind == "in2": return u ** 2
    if kind == "step": return 0.0 if u < 1 else 1.0
    if kind == "outback":
        c1 = 1.70158; c3 = c1 + 1
        return 1 + c3 * (u - 1) ** 3 + c1 * (u - 1) ** 2
    raise ValueError(kind)


class Track:
    """keys: [(t, value, ease_into_this_key)], value float or array; held before first / after last."""

    def __init__(self, keys):
        self.keys = [(float(k[0]), np.asarray(k[1], float), k[2] if len(k) > 2 else "io") for k in keys]

    def __call__(self, t):
        ks = self.keys
        if t <= ks[0][0]: return ks[0][1].copy()
        if t >= ks[-1][0]: return ks[-1][1].copy()
        for i in range(len(ks) - 1):
            t0, v0, _ = ks[i]
            t1, v1, e = ks[i + 1]
            if t0 <= t <= t1:
                u = ease((t - t0) / (t1 - t0) if t1 > t0 else 1.0, e)
                return v0 + (v1 - v0) * u
        return ks[-1][1].copy()


def normalized(M):
    M = np.array(M, float)
    M[:3, :3] = M[:3, :3] / np.linalg.norm(M[:3, :3], axis=0)
    return M


def frame_from(x_axis, z_axis, pos):
    """Right-handed frame with given x (palm normal) and z (toward wrist); y = z × x."""
    x = np.asarray(x_axis, float); x /= np.linalg.norm(x)
    z = np.asarray(z_axis, float); z = z - x * (z @ x); z /= np.linalg.norm(z)
    y = np.cross(z, x)
    F = np.eye(4); F[:3, 0] = x; F[:3, 1] = y; F[:3, 2] = z; F[:3, 3] = pos
    return F


def blend_frames(A, B, w):
    """Blend two (normalized) rigid frames: lerp position, slerp rotation."""
    w = float(np.clip(w, 0, 1))
    if w <= 0: return A.copy()
    if w >= 1: return B.copy()
    qa = mat3_to_quat(A[:3, :3]); qb = mat3_to_quat(B[:3, :3])
    q = slerp(qa, qb, w)
    M = np.eye(4); M[:3, :3] = quat_to_mat3(q); M[:3, 3] = A[:3, 3] * (1 - w) + B[:3, 3] * w
    return M


def rotz(deg): return quat_to_mat3(qaxis([0, 0, 1], np.radians(deg)))
def rotx(deg): return quat_to_mat3(qaxis([1, 0, 0], np.radians(deg)))
def roty(deg): return quat_to_mat3(qaxis([0, 1, 0], np.radians(deg)))


def noise1(t, seed=0, freq=9.0):
    """Cheap smooth pseudo-noise in [-1,1] (sum of incommensurate sines)."""
    return (np.sin(t * freq * 1.0 + seed * 1.7) * 0.5 + np.sin(t * freq * 1.618 + seed * 3.1) * 0.3
            + np.sin(t * freq * 2.71 + seed * 0.3) * 0.2)
