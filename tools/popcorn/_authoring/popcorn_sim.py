"""Reference implementation of the popcorn tank solver (mirrors PopcornTankPhysics.ts).

Position-based Verlet particles in TANK-LOCAL space (weapon units), sphere-sphere + box
constraints with Coulomb-like friction. Used offline to bake the Full / Half rest layouts.
"""
import numpy as np


class PopcornSim:
    def __init__(self, half, n, r_pop=0.125, r_kernel=0.05, seed=1):
        self.half = np.asarray(half, float)
        self.n = n
        self.r_pop = r_pop
        self.r_kernel = r_kernel
        self.rng = np.random.default_rng(seed)
        self.p = np.zeros((n, 3))
        self.pp = np.zeros((n, 3))
        self.r = np.full(n, r_pop)
        self.active = np.zeros(n, bool)
        self.damping = 0.985
        self.friction = 0.55
        self.wall_friction = 0.6
        self.restitution = 0.15
        self.iterations = 4

    def spawn(self, i, pos, r=None, vel=(0, 0, 0), dt=1 / 60):
        self.p[i] = pos
        self.pp[i] = np.asarray(pos) - np.asarray(vel) * dt
        self.r[i] = self.r_pop if r is None else r
        self.active[i] = True

    def step(self, dt, gravity):
        idx = np.nonzero(self.active)[0]
        if len(idx) == 0: return
        p, pp = self.p, self.pp
        v = (p[idx] - pp[idx]) * self.damping
        pp[idx] = p[idx]
        p[idx] = p[idx] + v + np.asarray(gravity) * dt * dt
        for _ in range(self.iterations):
            # particle pairs (sweep along x)
            order = idx[np.argsort(p[idx, 0])]
            for a_i in range(len(order)):
                i = order[a_i]
                for b_i in range(a_i + 1, len(order)):
                    j = order[b_i]
                    rr = self.r[i] + self.r[j]
                    dx = p[j, 0] - p[i, 0]
                    if dx > rr: break
                    d = p[j] - p[i]
                    dist2 = d @ d
                    if dist2 >= rr * rr or dist2 < 1e-12: continue
                    dist = np.sqrt(dist2)
                    nrm = d / dist
                    corr = (rr - dist) * 0.5
                    p[i] -= nrm * corr
                    p[j] += nrm * corr
                    # friction: damp relative tangential motion
                    vi = p[i] - pp[i]; vj = p[j] - pp[j]
                    rel = vj - vi
                    tan = rel - nrm * (rel @ nrm)
                    f = tan * (self.friction * 0.5)
                    pp[i] -= f   # v_i += f
                    pp[j] += f   # v_j -= f
            # box
            for i in idx:
                r = self.r[i]
                for ax in range(3):
                    lo, hi = -self.half[ax] + r, self.half[ax] - r
                    if p[i, ax] < lo or p[i, ax] > hi:
                        target = lo if p[i, ax] < lo else hi
                        vel = p[i] - pp[i]
                        p[i, ax] = target
                        # restitution on the normal axis, friction on tangential axes
                        pp[i, ax] = target + vel[ax] * self.restitution
                        for t in range(3):
                            if t != ax:
                                pp[i, t] += vel[t] * self.wall_friction * 0.5

    def settle(self, gravity, seconds, dt=1 / 60):
        for _ in range(int(seconds / dt)):
            self.step(dt, gravity)

    def kinetic(self):
        idx = np.nonzero(self.active)[0]
        return float(np.abs(self.p[idx] - self.pp[idx]).max()) if len(idx) else 0.0
