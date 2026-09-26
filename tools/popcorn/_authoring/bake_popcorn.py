"""Bake the FULL (72) and HALF (36) rest layouts of the popcorn tank (tank-local, weapon units)."""
import numpy as np, json
import weapon_def as wd
from popcorn_sim import PopcornSim
from scipy.spatial.transform import Rotation as R
N, PER_SHOT, R_POP, R_KERNEL, G = 72, 36, 0.125, 0.05, 60.0
half = wd.TANK_HALF
rng = np.random.default_rng(7)
s = PopcornSim(half, N, r_pop=R_POP)
for i in range(N):
    pos = (rng.random(3) * 2 - 1) * (half - R_POP); pos[1] = half[1] - R_POP - rng.random() * 0.05
    s.spawn(i, pos)
    s.settle((0, -G, 0), 2 / 60)
s.settle((0, -G, 0), 2.5)
full = s.p.copy()
quats = R.random(N, random_state=11).as_quat()
scales = 0.9 + 0.2 * rng.random(N)
order = np.argsort(full[:, 1])           # lowest first = consumed first
low, high = order[:PER_SHOT], order[PER_SHOT:]
s.active[low] = False
s.settle((0, -G, 0), 2.0)
half_pos = s.p[high].copy()
top_full = (full[:, 1] + R_POP).max(); top_half = (half_pos[:, 1] + R_POP).max()
print('full top %.3f / ceil %.3f  -> %.0f%%' % (top_full, half[1], 100 * (top_full + half[1]) / (2 * half[1])))
print('half top %.3f -> %.0f%%' % (top_half, 100 * (top_half + half[1]) / (2 * half[1])))
np.savez('popcorn_bake.npz', full=full, quats=quats, scales=scales, order=order, half_idx=high, half_pos=half_pos,
         N=N, per_shot=PER_SHOT, r_pop=R_POP, r_kernel=R_KERNEL, g=G, half_extents=half)
