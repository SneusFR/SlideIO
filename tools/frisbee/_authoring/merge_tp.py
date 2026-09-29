"""Merge the partial TP bakes into tp_clips.pkl."""
import pickle, sys, os
os.chdir("/home/claude/fl")
out = pickle.load(open("tp_clips.pkl", "rb"))
for f in sys.argv[1:] or ["tp_b.pkl", "tp_fire.pkl", "tp_c.pkl"]:
    if not os.path.exists(f): print("missing", f); continue
    d = pickle.load(open(f, "rb"))
    for k, v in d.items():
        if k != "_meta": out[k] = v
pickle.dump(out, open("tp_clips.pkl", "wb"))
print(sorted(k for k in out if k != "_meta"))
