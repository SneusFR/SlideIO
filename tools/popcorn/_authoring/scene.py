"""Collect drawables from GLB scenes (static + skinned) for the preview rasterizer."""
import numpy as np
from rig import Rig, skin_vertices, trs

def material_color(js, mi):
    if mi is None: return np.array([0.8, 0.8, 0.8]), 1.0, False
    m = js["materials"][mi]
    pbr = m.get("pbrMetallicRoughness", {})
    bc = np.array(pbr.get("baseColorFactor", [1, 1, 1, 1]), float)
    blend = m.get("alphaMode") == "BLEND"
    return bc[:3], bc[3], blend

def drawables(rig: Rig, W, hidden=(), only=None):
    """W: world matrices for rig nodes (name->4x4). Returns list of (verts, faces, colors, alpha)."""
    out = []
    js = rig.js
    for i, n in enumerate(rig.nodes):
        if "mesh" not in n: continue
        name = rig.names[i]
        if name in hidden: continue
        if only is not None and name not in only: continue
        # hidden by visibility of ancestors
        p = i; vis = True
        while p >= 0:
            if rig.names[p] in hidden: vis = False
            ex = rig.nodes[p].get("extras", {})
            if isinstance(ex, dict) and ex.get("runtime_template"): vis = False
            p = rig.parent[p]
        if not vis: continue
        for prim in rig.mesh_data(n["mesh"]):
            base, alpha, blend = material_color(js, prim["material"])
            if "joints" in prim and "skin" in n:
                mats = rig.skin_matrices(W, n["skin"])
                v = skin_vertices(prim["pos"], prim["joints"], prim["weights"], mats)
            else:
                M = W[name]
                v = (M[:3, :3] @ prim["pos"].T).T + M[:3, 3]
            col = prim["color"] * base[None, :] if "color" in prim else base
            out.append((v, prim["idx"], col, alpha if blend else 1.0))
    return out
