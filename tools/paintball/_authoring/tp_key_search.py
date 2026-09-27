import pickle, numpy as np, author_tp as T
best = None
for p0 in [(0.0, 0.46, 0.17), (0.03, 0.45, 0.15), (-0.03, 0.47, 0.16)]:
    for sp0, g0 in [((-12.0, 6.0), (20.0, 0.05)), ((-12.0, 8.0), (40.0, 0.1))]:
        pose, info = T.solve_straight(p0, spine0=sp0, max_nfev=500, free_grip=True, grip0=g0)
        sc = info["cost"]
        if best is None or sc < best[1]["cost"]: best = (pose, info)
pickle.dump(best, open("tp_key.pkl", "wb"))
print("BEST", np.round(best[1]["p"], 3), best[1]["spine"], best[1]["grip"], best[1]["cost"], best[1]["eL"], best[1]["rL"])
