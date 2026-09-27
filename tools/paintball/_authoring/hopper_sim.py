"""Reference (numpy) PBD solver for the paintball hopper: spheres in a horizontal cylinder with a shallow V floor
toward the feed hole (Hopper-local units)."""
import numpy as np
R_BALL = 0.104
R_IN = 0.243           # glass inner radius (octagon apothem 0.27 minus wall)
X0, X1 = -1.105, 1.085  # inner x range (front ring face .. rear end)
FEED_X = -0.27          # feed hole (above the pedestal)
V_SLOPE = np.tan(np.radians(7.0))
G = 9.0                 # units / s^2 (≈ weapon units; the sim is purely visual)

def floor_y(x):
    """V floor: lowest at the feed, rising toward both ends (inside the cylinder)."""
    return -R_IN + np.abs(x - FEED_X) * V_SLOPE

def settle(P, iters=4, steps=900, dt=1/120, damp=0.985, seed=0):
    rng = np.random.default_rng(seed)
    Pp = P.copy()
    for s in range(steps):
        V = (P - Pp) * damp
        Pp = P.copy()
        P = P + V + np.array([0, -G, 0]) * dt * dt
        for _ in range(iters):
            # sphere-sphere
            d = P[:, None, :] - P[None, :, :]
            dist = np.linalg.norm(d, axis=2) + np.eye(len(P))
            ov = np.maximum(0, 2 * R_BALL - dist)
            np.fill_diagonal(ov, 0)
            corr = (d / dist[..., None]) * (ov[..., None] * 0.5)
            P = P + corr.sum(1)
            # cylinder wall (radius in YZ)
            r = np.linalg.norm(P[:, 1:], axis=1)
            m = r > R_IN - R_BALL
            P[m, 1:] *= ((R_IN - R_BALL) / r[m])[:, None]
            # V floor
            fy = floor_y(P[:, 0]) + R_BALL
            m = P[:, 1] < fy
            P[m, 1] = fy[m]
            P[:, 0] = np.clip(P[:, 0], X0 + R_BALL, X1 - R_BALL)
    return P

if __name__ == "__main__":
    rng = np.random.default_rng(3)
    N = 32
    P = np.stack([rng.uniform(X0 + 0.15, X1 - 0.15, N), rng.uniform(-0.1, 0.12, N), rng.uniform(-0.1, 0.1, N)], 1)
    P = settle(P)
    d = np.linalg.norm(P[:, None] - P[None], axis=2) + np.eye(N) * 9
    print("min dist / 2r:", d.min() / (2 * R_BALL), " y range", P[:, 1].min().round(3), P[:, 1].max().round(3),
          " top of pile", (P[:, 1].max() + R_BALL).round(3), " ceiling", R_IN)
    cols = np.array([k % 3 for k in rng.permutation(N)])
    np.save("balls_full.npy", np.c_[P, cols])
    print(np.round(np.c_[P, cols], 3).tolist())
