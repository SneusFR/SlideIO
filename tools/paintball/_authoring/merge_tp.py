"""Merge the partial TP bakes (tp_a / tp_b / tp_c) into tp_clips.pkl."""
import pickle, os
out = {}
for f in ("tp_a.pkl", "tp_b.pkl", "tp_c.pkl", "tp_d.pkl"):          # tp_d: v3 calmer fire (overrides tp_b)
    if os.path.exists(f): out.update(pickle.load(open(f, "rb")))
pickle.dump(out, open("tp_clips.pkl", "wb"))
print(sorted(k for k in out if not k.startswith("_")))
