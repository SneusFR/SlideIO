"""Water FAMAS — procedural low-poly model built INSIDE Blender (bmesh convex hulls + chamfer bevels).

Weapon-local units, glTF axes (forward -X, up +Y, +Z = gun's LEFT side); the Blender root empty 'WaterFamas'
is rotated +90° about X so every child is authored directly in glTF coordinates.
Reference image (590 x 312 px side view): 1 unit = 88 px. The pistol grip, the trigger and the trigger guard are
the Paintball Rifle ones (same GripSocket / right-hand hold / FP-TP mounts as the Popcorn - Paintball family):
the reference grip is slimmer, but the Potato hand needs that grip.
Tank: a transparent cylinder on the rear top; the water inside is a separate mesh (the runtime liquid shader).
Filling: the red rear cap unscrews (Cap, 1 turn) inside a hinged retainer (CapHinge) that swings open.
"""
import bpy, bmesh, math, json
from mathutils import Vector, Matrix

PXU = 88.0
OX, OY = 367.8, 165.0


def X(px): return (px - OX) / PXU
def Y(py): return -(py - OY) / PXU


def lin(c):
    out = []
    for v in c:
        v = v / 255.0
        out.append(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4)
    return tuple(out)


PAL = {
    "RED": lin((228, 92, 76)), "RED_DARK": lin((196, 70, 60)), "CREAM": lin((238, 228, 208)), "CREAM_DARK": lin((214, 202, 182)),
    "SLATE": lin((66, 80, 100)), "SLATE_DARK": lin((46, 56, 72)), "BLUE": lin((58, 140, 224)), "BLUE_LIGHT": lin((96, 176, 240)),
    "BORE": lin((24, 30, 40)), "GLASS": lin((150, 206, 244)), "WATER": lin((70, 160, 235)), "WHITE": (1.0, 1.0, 1.0),
    "BOTTLE": lin((72, 170, 236)), "BOTTLE_CAP": lin((240, 240, 236)),
}
PAL_KEYS = list(PAL)

# ------------------------------------------------------------------ key points (weapon units, final scale)
GRIP = (0.874, -0.750, 0.0)                       # same GripSocket as the Popcorn Shotgun / Paintball Rifle


def SP(p):
    """Paintball Rifle authoring (x1.4 about the grip) -> final units (grip, trigger, guard are reused as is)."""
    p = tuple(p) + (0.0,) * (3 - len(p))
    return tuple(GRIP[i] + 1.4 * (p[i] - GRIP[i]) for i in range(3))


YA = Y(153)                                        # barrel / nozzle axis
TRIGGER_PIVOT = SP((0.545, -0.372, 0.0))
MUZZLE = (X(8), YA, 0.0)
TANK_C = (X(444), Y(85), 0.0)                      # tank axis centre (Tank node origin)
TANK_R = 0.43                                      # glass outer radius
TANK_X0, TANK_X1 = X(360) - TANK_C[0], X(528) - TANK_C[0]     # glass extent, tank-local
WATER_R = 0.385
WATER_X0, WATER_X1 = TANK_X0 + 0.07, TANK_X1 - 0.05
CAP_X = X(528) - TANK_C[0] + 0.30                  # cap centre, tank-local (on the axis)
CAP_R = 0.36
HINGE = (X(528) - TANK_C[0] + 0.06, 0.0, 0.45)     # cap retainer hinge: gun's LEFT side (+Z) of the rear rim, tank-local, axis Y


# ------------------------------------------------------------------ point generators
def ngon(r, n=8, phase=None):
    phase = math.pi / n if phase is None else phase
    return [(math.cos(phase + k * 2 * math.pi / n) * r, math.sin(phase + k * 2 * math.pi / n) * r) for k in range(n)]


def prism_x(sections, n=8, cy=0.0, cz=0.0):
    return [(x, cy + u, cz + v) for x, r in sections for (u, v) in ngon(r, n)]


def prism_z(center, sections, n=8):
    cx, cy = center
    return [(cx + u, cy + v, z) for z, r in sections for (u, v) in ngon(r, n)]


def ext_z(poly, z0, z1):
    return [(x, y, z) for (x, y) in poly for z in (z0, z1)]


def box(x0, x1, y0, y1, z0, z1):
    return [(x, y, z) for x in (x0, x1) for y in (y0, y1) for z in (z0, z1)]


def P(pts):
    return [(X(a), Y(b)) for a, b in pts]


# ------------------------------------------------------------------ bmesh part builder
class Part:
    def __init__(self, name):
        self.name = name
        self.bm = bmesh.new()
        self.cid = self.bm.faces.layers.int.new("cid")

    def hull(self, pts, color, bevel=0.0, angle=25.0):
        bm = self.bm
        old = set(bm.faces)
        vs = [bm.verts.new(Vector(p)) for p in pts]
        res = bmesh.ops.convex_hull(bm, input=vs, use_existing_faces=False)
        kill = list({g for g in res["geom_interior"] + res["geom_unused"] if isinstance(g, bmesh.types.BMVert)})
        if kill:
            bmesh.ops.delete(bm, geom=kill, context="VERTS")
        new = [f for f in bm.faces if f not in old]
        nv = list({v for f in new for v in f.verts}); ne = list({e for f in new for e in f.edges})
        bmesh.ops.dissolve_limit(bm, angle_limit=math.radians(0.5), verts=nv, edges=ne)
        new = [f for f in bm.faces if f not in old]
        bmesh.ops.recalc_face_normals(bm, faces=new)
        if bevel > 0:
            ne = list({e for f in new for e in f.edges})
            sharp = [e for e in ne if len(e.link_faces) == 2 and e.calc_face_angle(0.0) > math.radians(angle)]
            if sharp:
                bmesh.ops.bevel(bm, geom=sharp, offset=bevel, offset_type="OFFSET", segments=1, profile=0.5,
                                affect="EDGES", clamp_overlap=True)
        new = [f for f in bm.faces if f not in old]
        ci = PAL_KEYS.index(color)
        for f in new:
            f[self.cid] = ci
        return new

    def finish(self, parent, origin=(0.0, 0.0, 0.0), material=None, coll=None, smooth=False):
        bmesh.ops.recalc_face_normals(self.bm, faces=list(self.bm.faces))
        for v in self.bm.verts:
            v.co -= Vector(origin)                     # geometry authored in the parent frame -> node-local
        old_me = bpy.data.meshes.get(self.name)
        if old_me is not None:
            old_me.name = self.name + "_old"
        me = bpy.data.meshes.new(self.name)            # fresh datablock -> fresh GPU batches (viewport snapshots)
        self.bm.to_mesh(me); self.bm.free()
        if "Col" in me.color_attributes:
            me.color_attributes.remove(me.color_attributes["Col"])
        ca = me.color_attributes.new("Col", "FLOAT_COLOR", "CORNER")
        cid = me.attributes["cid"].data
        cols = []
        for poly in me.polygons:
            c = PAL[PAL_KEYS[cid[poly.index].value]]
            for _ in poly.loop_indices:
                cols.extend((c[0], c[1], c[2], 1.0))
        ca.data.foreach_set("color", cols)
        me.color_attributes.active_color = ca
        for p in me.polygons:
            p.use_smooth = smooth
        me.materials.clear()
        if material is not None:
            me.materials.append(material)
        ob = bpy.data.objects.get(self.name)
        if ob is None:
            ob = bpy.data.objects.new(self.name, me)
            (coll or bpy.context.scene.collection).objects.link(ob)
        ob.data = me
        if old_me is not None and old_me.users == 0:
            bpy.data.meshes.remove(old_me)
        me.update()
        ob.parent = parent
        ob.matrix_parent_inverse = Matrix.Identity(4)
        ob.location = origin
        ob.rotation_euler = (0, 0, 0); ob.scale = (1, 1, 1)
        return ob


# ------------------------------------------------------------------ materials
def materials():
    def vc(name, rough=0.6, alpha=None):
        m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
        m.use_nodes = True
        nt = m.node_tree; nt.nodes.clear()
        out = nt.nodes.new("ShaderNodeOutputMaterial")
        bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
        attr = nt.nodes.new("ShaderNodeVertexColor"); attr.layer_name = "Col"
        nt.links.new(attr.outputs["Color"], bsdf.inputs["Base Color"])
        bsdf.inputs["Roughness"].default_value = rough
        bsdf.inputs["Metallic"].default_value = 0.0
        if alpha is not None:
            bsdf.inputs["Alpha"].default_value = alpha
            m.surface_render_method = "BLENDED"
            m.use_backface_culling = False
        nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
        return m
    return {"vc": vc("FM_VertexColor", 0.55), "glass": vc("FM_TankGlass", 0.06, alpha=0.28),
            "water": vc("FM_Water", 0.1, alpha=0.72), "bottle": vc("FM_BottleShell", 0.2, alpha=0.55)}


# ------------------------------------------------------------------ the model
def build_body():
    b = Part("Body")
    # --- nozzle (blue) + bore, cream ring, dark barrel
    b.hull(prism_x([(X(8), 0.105), (X(12), 0.13), (X(27), 0.13), (X(30), 0.115)], cy=YA), "BLUE", 0.012)
    b.hull(prism_x([(X(6.5), 0.05), (X(10), 0.05)], cy=YA), "BORE", 0.0)
    b.hull(prism_x([(X(27), 0.15), (X(31), 0.175), (X(49), 0.175), (X(52), 0.15)], cy=YA), "CREAM", 0.012)
    b.hull(prism_x([(X(50), 0.118), (X(106), 0.118)], cy=YA), "SLATE", 0.01)
    # --- front upper body (red) + front lower body (cream)
    b.hull(ext_z(P([(90, 122), (104, 103), (336, 103), (336, 158), (98, 158), (88, 146)]), -0.27, 0.27), "RED", 0.04)
    b.hull(ext_z(P([(98, 156), (336, 156), (340, 170), (330, 199), (122, 199), (100, 183)]), -0.25, 0.25), "CREAM", 0.036)
    for s in (1, -1):
        for x0 in (146, 162, 178):                                   # 3 red vents
            b.hull(box(X(x0), X(x0 + 9), Y(186), Y(163), s * 0.235, s * 0.262), "RED", 0.008)
        b.hull(ext_z(P([(232, 160), (330, 160), (322, 173), (224, 173)]), s * 0.235, s * 0.262), "SLATE", 0.008)   # slate stripe
    # --- carry handle (red): front post (+ slate front sight), top rail, rear post
    b.hull(ext_z(P([(122, 106), (128, 72), (166, 66), (170, 106)]), -0.13, 0.13), "RED", 0.03)
    b.hull(ext_z(P([(131, 100), (137, 78), (160, 74), (160, 100)]), -0.145, 0.145), "SLATE", 0.012)
    b.hull(ext_z(P([(140, 64), (156, 48), (350, 48), (360, 58), (360, 72), (146, 74)]), -0.12, 0.12), "RED", 0.03)
    b.hull(ext_z(P([(322, 108), (330, 66), (362, 62), (366, 108)]), -0.14, 0.14), "RED", 0.03)
    # --- raised side plate with the round button (red, slightly wider)
    b.hull(ext_z(P([(304, 162), (316, 114), (392, 110), (400, 124), (400, 166)]), -0.3, 0.3), "RED", 0.035)
    for s in (1, -1):
        b.hull(prism_z((X(370), Y(146)), [(s * 0.29, 0.07), (s * 0.325, 0.07)], n=10), "SLATE_DARK", 0.01)
    # --- rear upper body (red) under the tank, rear lower (cream), blue butt plate
    b.hull(ext_z(P([(392, 108), (534, 108), (546, 120), (546, 172), (392, 172)]), -0.27, 0.27), "RED", 0.04)
    b.hull(ext_z(P([(446, 158), (548, 158), (562, 174), (560, 197), (456, 197)]), -0.26, 0.26), "CREAM", 0.036)
    b.hull(ext_z(P([(540, 112), (574, 118), (578, 190), (566, 198), (546, 198)]), -0.3, 0.3), "BLUE", 0.04)
    # --- tank saddle (red cradle under the tank)
    b.hull(ext_z(P([(360, 122), (366, 104), (528, 104), (534, 122)]), -0.2, 0.2), "RED_DARK", 0.02)
    # --- trigger housing (red): the guard, the trigger and the grip hang from it
    b.hull(ext_z(P([(328, 156), (454, 156), (454, 183), (334, 183)]), -0.22, 0.22), "RED", 0.03)
    # --- trigger guard (red) and pistol grip (cream + slate inset): the Paintball Rifle ones
    tg = 0.095 * 1.4
    for poly in ([(0.15, -0.34), (0.27, -0.34), (0.27, -0.62), (0.235, -0.66), (0.15, -0.66)],
                 [(0.15, -0.64), (0.235, -0.64), (0.31, -0.66), (0.33, -0.785), (0.26, -0.79), (0.15, -0.72)],
                 [(0.30, -0.66), (0.70, -0.66), (0.74, -0.70), (0.72, -0.76), (0.66, -0.79), (0.30, -0.79)]):
        b.hull(ext_z([SP(p)[:2] for p in poly], -tg, tg), "RED", 0.034)
    grip_poly = [(0.651, -0.338), (0.890, -0.338), (1.167, -1.311), (1.113, -1.402), (0.849, -1.402), (0.791, -1.344)]
    b.hull(ext_z([SP(p)[:2] for p in grip_poly], -0.17 * 1.4, 0.17 * 1.4), "CREAM", 0.05)
    for s in (1, -1):
        inset = [(0.80, -0.50), (0.90, -0.46), (1.10, -1.18), (0.95, -1.18)]
        b.hull(ext_z([SP(p)[:2] for p in inset], s * 0.2, s * 0.255), "SLATE", 0.02)
    b.hull(ext_z([SP(p)[:2] for p in [(0.77, -1.305), (1.215, -1.305), (1.225, -1.40), (1.19, -1.44), (0.80, -1.44), (0.765, -1.40)]],
                 -0.20 * 1.4, 0.20 * 1.4), "BLUE", 0.04)
    return b


def build_trigger():
    t = Part("Trigger")
    k = 1.4
    t.hull([(x * k + TRIGGER_PIVOT[0], y * k + TRIGGER_PIVOT[1], z * k) for (x, y, z) in
            ext_z([(-0.035, 0.02), (0.035, 0.02), (0.028, -0.13), (-0.048, -0.15)], -0.035, 0.035)], "BLUE", 0.014)
    t.hull([(x * k + TRIGGER_PIVOT[0], y * k + TRIGGER_PIVOT[1], z * k) for (x, y, z) in
            ext_z([(-0.048, -0.12), (0.028, -0.11), (0.03, -0.18), (0.075, -0.235), (0.025, -0.262), (-0.045, -0.19)], -0.035, 0.035)],
           "BLUE", 0.014)
    return t


def build_tank_parts():
    """In TANK-local coordinates (origin on the tank axis, x along the axis)."""
    fr = Part("TankFrame")
    # cream bands (front, rear), front end cap (blue), rear rim (cream collar that takes the cap)
    fr.hull(prism_x([(TANK_X0 - 0.02, 0.43), (TANK_X0 + 0.02, 0.475), (TANK_X0 + 0.40, 0.475), (TANK_X0 + 0.43, 0.44)], n=12), "CREAM", 0.02)
    fr.hull(prism_x([(TANK_X0 - 0.05, 0.36), (TANK_X0 + 0.02, 0.36)], n=12), "BLUE", 0.012)
    fr.hull(prism_x([(TANK_X1 - 0.42, 0.44), (TANK_X1 - 0.39, 0.475), (TANK_X1 - 0.02, 0.475), (TANK_X1, 0.44)], n=12), "CREAM", 0.02)
    fr.hull(prism_x([(TANK_X1 - 0.02, 0.33), (TANK_X1 + 0.06, 0.33)], n=12), "CREAM_DARK", 0.012)
    # hinge knuckle (vertical axis) for the cap retainer, on the gun's left side of the rear rim + its bracket
    fr.hull([(HINGE[0] + math.cos(a) * 0.045, y, HINGE[2] + math.sin(a) * 0.045) for y in (-0.09, 0.09)
             for a in [k * 2 * math.pi / 8 for k in range(8)]], "RED_DARK", 0.006)
    fr.hull(box(TANK_X1 - 0.05, HINGE[0] - 0.02, -0.07, 0.07, 0.3, HINGE[2] + 0.02), "CREAM_DARK", 0.01)
    gl = Part("TankGlass")
    gl.hull(prism_x([(TANK_X0 + 0.02, TANK_R), (TANK_X1 - 0.02, TANK_R)], n=20), "GLASS", 0.0)
    wa = Part("Water")
    wa.hull(prism_x([(WATER_X0, WATER_R), (WATER_X1, WATER_R)], n=24), "WATER", 0.0)
    return fr, gl, wa


def build_cap_parts():
    """CapHinge (retainer ring, origin on the hinge axis) and Cap (screw cap, origin on the tank axis) — local frames."""
    hg = Part("CapHinge")
    hx, hy, hz = HINGE
    # retainer ring around the cap + the lug that wraps the knuckle (hinge-local = tank-local minus HINGE)
    ring = prism_x([(TANK_X1 + 0.07, 0.385), (TANK_X1 + 0.15, 0.385)], n=12)
    hg.hull([(x - hx, y - hy, z - hz) for (x, y, z) in ring], "RED_DARK", 0.012)
    lug = box(HINGE[0] - 0.01, TANK_X1 + 0.15, -0.06, 0.06, 0.33, HINGE[2] + 0.05)
    hg.hull([(x - hx, y - hy, z - hz) for (x, y, z) in lug], "RED_DARK", 0.01)
    cp = Part("Cap")
    # ribbed red screw cap (cap-local: origin at the cap centre on the axis)
    cp.hull(prism_x([(-0.14, 0.33), (-0.12, 0.36), (0.14, 0.36), (0.18, 0.31)], n=16), "RED", 0.018)
    for k in range(8):
        a = k * 2 * math.pi / 8
        cy, cz = math.cos(a) * 0.365, math.sin(a) * 0.365
        cp.hull([(x, cy + math.cos(a) * dy - math.sin(a) * dz, cz + math.sin(a) * dy + math.cos(a) * dz)
                 for x in (-0.11, 0.12) for dy in (-0.01, 0.03) for dz in (-0.035, 0.035)], "RED_DARK", 0.006)
    cp.hull(prism_x([(0.17, 0.2), (0.21, 0.17)], n=12), "RED_DARK", 0.012)
    return hg, cp


def build_bottle():
    """Sports water bottle (reload prop), bottle-local: origin on the axis at the grip band, axis +Y = nozzle.
    ~7 cm wide / 20 cm tall in first person: it reads as a bottle in the Potato's big fist."""
    bo = Part("Bottle")
    ring = lambda n: [k * 2 * math.pi / n for k in range(n)]
    bo.hull([(math.cos(a) * r, y, math.sin(a) * r) for y, r in ((-0.98, 0.36), (-1.02, 0.30), (0.46, 0.42), (0.64, 0.28))
             for a in ring(16)], "BOTTLE", 0.03)
    bo.hull([(math.cos(a) * r, y, math.sin(a) * r) for y, r in ((0.60, 0.27), (0.82, 0.27)) for a in ring(14)], "BOTTLE_CAP", 0.02)
    bo.hull([(math.cos(a) * r, y, math.sin(a) * r) for y, r in ((0.80, 0.11), (1.00, 0.085)) for a in ring(10)], "BOTTLE_CAP", 0.012)
    bo.hull([(math.cos(a) * r, y, math.sin(a) * r) for y, r in ((-0.30, 0.435), (0.12, 0.435)) for a in ring(16)], "SLATE", 0.015)
    return bo


def ensure_collection(name, scene):
    c = bpy.data.collections.get(name)
    if c is None:
        c = bpy.data.collections.new(name)
    if c.name not in scene.collection.children:
        scene.collection.children.link(c)
    return c


def empty(name, parent, loc, coll, size=0.08, shape="PLAIN_AXES", rot=None):
    ob = bpy.data.objects.get(name)
    if ob is None:
        ob = bpy.data.objects.new(name, None); coll.objects.link(ob)
    ob.empty_display_type = shape; ob.empty_display_size = size
    ob.parent = parent; ob.matrix_parent_inverse = Matrix.Identity(4)
    ob.location = loc
    ob.rotation_euler = rot if rot is not None else (0, 0, 0)
    return ob


def build():
    """(Re)build the whole water gun in the active scene."""
    sc = bpy.context.scene
    coll = ensure_collection("WaterFamas", sc)
    mats = materials()
    root = empty("WaterFamas", None, (0, 0, 0), coll, size=0.3, shape="ARROWS", rot=(math.radians(90), 0, 0))
    build_body().finish(root, (0, 0, 0), mats["vc"], coll)
    build_trigger().finish(root, TRIGGER_PIVOT, mats["vc"], coll)
    tank = empty("Tank", root, TANK_C, coll, size=0.2)
    fr, gl, wa = build_tank_parts()
    fr.finish(tank, (0, 0, 0), mats["vc"], coll)
    gl.finish(tank, (0, 0, 0), mats["glass"], coll)
    w = wa.finish(tank, (0, 0, 0), mats["water"], coll)
    hg, cp = build_cap_parts()
    hinge = hg.finish(tank, (0, 0, 0), mats["vc"], coll)
    hinge.location = HINGE
    cap = cp.finish(hinge, (0, 0, 0), mats["vc"], coll)
    cap.location = (CAP_X - HINGE[0], -HINGE[1], -HINGE[2])
    bot = build_bottle().finish(root, (0, 0, 0), mats["vc"], coll)
    bot.location = (1.2, -1.6, 0.9)                                    # parked (hidden in the game: scale 0)
    bot.hide_viewport = True; bot.hide_render = True
    empty("Muzzle", root, MUZZLE, coll, 0.1)
    empty("GripSocket", root, GRIP, coll, 0.1)
    return root


# ------------------------------------------------------------------ export (geometry back to the offline pipeline)
def dump(path):
    """Evaluated triangles of every mesh object, in the object's LOCAL frame (glTF axes), face-flat normals and
    linear vertex colours, plus local node transforms (relative to the parent)."""
    dg = bpy.context.evaluated_depsgraph_get()
    out = {"objects": {}}
    coll = bpy.data.collections["WaterFamas"]
    for ob in coll.objects:
        rec = {"parent": ob.parent.name if ob.parent else None, "location": list(ob.location),
               "rotation_euler": list(ob.rotation_euler), "scale": list(ob.scale), "type": ob.type}
        if ob.type == "MESH":
            ev = ob.evaluated_get(dg); me = ev.to_mesh()
            me.calc_loop_triangles()
            col = me.color_attributes.get("Col")
            Pp, N, C = [], [], []
            for tri in me.loop_triangles:
                n = tri.normal
                for li, vi in zip(tri.loops, tri.vertices):
                    v = me.vertices[vi].co
                    Pp.append([round(v.x, 6), round(v.y, 6), round(v.z, 6)])
                    N.append([round(n.x, 5), round(n.y, 5), round(n.z, 5)])
                    c = col.data[li].color if col else (1, 1, 1, 1)
                    C.append([round(c[0], 5), round(c[1], 5), round(c[2], 5)])
            rec.update(pos=Pp, nrm=N, col=C, material=ob.data.materials[0].name if ob.data.materials else None)
            ev.to_mesh_clear()
        out["objects"][ob.name] = rec
    out["meta"] = {"grip": list(GRIP), "trigger_pivot": list(TRIGGER_PIVOT), "muzzle": list(MUZZLE), "ya": YA,
                   "tank_c": list(TANK_C), "tank_r": TANK_R, "tank_x": [TANK_X0, TANK_X1],
                   "water_r": WATER_R, "water_x": [WATER_X0, WATER_X1], "cap_x": CAP_X, "cap_r": CAP_R,
                   "hinge": list(HINGE), "px_to_unit": {"pxu": PXU, "ox": OX, "oy": OY}}
    json.dump(out, open(path, "w"))
    return path
