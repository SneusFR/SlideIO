"""Paintball Rifle — procedural low-poly model built INSIDE Blender (bmesh convex hulls + chamfer bevels).

Weapon-local units, glTF axes (forward -X, up +Y, +Z = gun's LEFT side); the Blender root empty
'PaintballRifle' is rotated +90° about X so every child is authored directly in glTF coordinates.
Reference image (1097 x 535 px side view): 1 unit = 170 px, mapped so the pistol grip coincides with the
Popcorn Shotgun grip (same right-hand hold / FP-TP mounts as the HexSniper family).
"""
import bpy, bmesh, math, json, os
from mathutils import Vector, Matrix

PXU = 170.0
OX, OY = 577.1, 239.5


def X(px): return (px - OX) / PXU
def Y(py): return -(py - OY) / PXU


def lin(c):
    out = []
    for v in c:
        v = v / 255.0
        out.append(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4)
    return tuple(out)


PAL = {
    "TEAL": lin((44, 168, 176)), "TEAL_LIGHT": lin((78, 196, 200)), "TEAL_DARK": lin((30, 128, 136)),
    "SLATE": lin((78, 88, 108)), "SLATE_DARK": lin((52, 58, 74)), "BORE": lin((24, 26, 32)),
    "CREAM": lin((236, 228, 212)), "CREAM_DARK": lin((212, 202, 184)),
    "ORANGE": lin((242, 112, 52)), "YELLOW": lin((242, 206, 44)),
    "GLASS": lin((206, 220, 226)), "WHITE": (1.0, 1.0, 1.0),
    "BALL_RED": lin((234, 96, 86)), "BALL_YELLOW": lin((244, 208, 64)), "BALL_TEAL": lin((46, 182, 186)),
}
PAL_KEYS = list(PAL)

# ------------------------------------------------------------------ key dimensions (weapon units)
YA = -0.13                                   # barrel axis
BARREL_R = 0.22
GRIP = (0.874, -0.750, 0.0)                  # same GripSocket as the Popcorn Shotgun (right-hand hold)
GRIP_POLY = [(0.651, -0.338), (0.890, -0.338), (1.167, -1.311), (1.113, -1.402), (0.849, -1.402), (0.791, -1.344)]
TRIGGER_PIVOT = (0.545, -0.372, 0.0)
MUZZLE = (X(84), YA, 0.0)
HOPPER_C = (0.25, 0.78, 0.0)                 # tube centre (Hopper node origin)
TUBE_R = 0.27                                # glass outer (octagon apothem)
TUBE_X0, TUBE_X1 = -0.87, 1.37               # glass extent (weapon x)
BALL_R = 0.104
CH_REST = (X(686), -0.005, 0.268)            # charging handle knob base (left face slot, front end)
CH_TRAVEL = 0.27                             # slides back (+X)
FOREGRIP_X = -0.93                           # vertical foregrip centre line
FOREGRIP_Y0, FOREGRIP_Y1 = -0.56, -1.30


# v2 — the Potato hands are big (HexSniper family): the whole rifle is scaled x1.4 about the pistol-grip point
# (overall ~7.4 units at root 0.19, like the HexSniper's 7.8), everything above is authored at the 1.0 scale.
SCALE = 1.4
ANCHOR = GRIP


def S(p):
    return tuple(ANCHOR[i] + SCALE * (p[i] - ANCHOR[i]) for i in range(3))


# ------------------------------------------------------------------ point generators
def ngon(r, n=8, phase=None):
    phase = math.pi / n if phase is None else phase
    return [(math.cos(phase + k * 2 * math.pi / n) * r, math.sin(phase + k * 2 * math.pi / n) * r) for k in range(n)]


def prism_x(sections, n=8, cy=0.0, cz=0.0, sy=1.0, sz=1.0):
    return [(x, cy + u * sy, cz + v * sz) for x, r in sections for (u, v) in ngon(r, n)]


def prism_z(center, sections, n=8):
    cx, cy = center
    return [(cx + u, cy + v, z) for z, r in sections for (u, v) in ngon(r, n)]


def ext_z(poly, z0, z1):
    return [(x, y, z) for (x, y) in poly for z in (z0, z1)]


def box(x0, x1, y0, y1, z0, z1):
    return [(x, y, z) for x in (x0, x1) for y in (y0, y1) for z in (z0, z1)]


def mirror_z(pts):
    return [(x, y, -z) for (x, y, z) in pts]


def shift(pts, d):
    return [(x - d[0], y - d[1], z - d[2]) for (x, y, z) in pts]


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

    def finish(self, parent, origin=(0.0, 0.0, 0.0), material=None, coll=None, scale_about_anchor=True):
        bmesh.ops.recalc_face_normals(self.bm, faces=list(self.bm.faces))
        if scale_about_anchor:
            for v in self.bm.verts:
                v.co *= SCALE
            origin = S(origin)
        old_me = bpy.data.meshes.get(self.name)
        if old_me is not None:
            old_me.name = self.name + "_old"
        me = bpy.data.meshes.new(self.name)            # fresh datablock -> fresh GPU batches (viewport snapshots)
        self.bm.to_mesh(me); self.bm.free()
        # corner colour attribute from the face palette index
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
            p.use_smooth = False
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
    def vc(name, rough=0.6, alpha=None, obj_color=False):
        m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
        m.use_nodes = True
        nt = m.node_tree; nt.nodes.clear()
        out = nt.nodes.new("ShaderNodeOutputMaterial")
        bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
        attr = nt.nodes.new("ShaderNodeVertexColor"); attr.layer_name = "Col"
        if obj_color:
            oi = nt.nodes.new("ShaderNodeObjectInfo")
            mul = nt.nodes.new("ShaderNodeMix"); mul.data_type = "RGBA"; mul.blend_type = "MULTIPLY"
            mul.inputs[0].default_value = 1.0
            nt.links.new(attr.outputs["Color"], mul.inputs[6]); nt.links.new(oi.outputs["Color"], mul.inputs[7])
            nt.links.new(mul.outputs[2], bsdf.inputs["Base Color"])
        else:
            nt.links.new(attr.outputs["Color"], bsdf.inputs["Base Color"])
        bsdf.inputs["Roughness"].default_value = rough
        bsdf.inputs["Metallic"].default_value = 0.0
        if alpha is not None:
            bsdf.inputs["Alpha"].default_value = alpha
            m.surface_render_method = "BLENDED"
            m.use_backface_culling = False
        nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
        return m
    return {"vc": vc("PB_VertexColor", 0.58), "glass": vc("PB_Glass", 0.08, alpha=0.24),
            "ball": vc("PB_Ball", 0.35, obj_color=True)}


# ------------------------------------------------------------------ the model
def build_body():
    b = Part("Body")
    # --- muzzle cap (teal), bore, orange ring, barrel
    b.hull(prism_x([(X(85), 0.30), (X(93), 0.35), (X(146), 0.35), (X(152), 0.32)], cy=YA), "TEAL", 0.018)
    b.hull(prism_x([(X(83.5), 0.135), (X(92), 0.135)], cy=YA), "BORE", 0.0)
    b.hull(prism_x([(X(150), 0.295), (X(154), 0.318), (X(184), 0.318), (X(188), 0.295)], cy=YA), "ORANGE", 0.008)
    b.hull(prism_x([(X(186), BARREL_R), (X(452), BARREL_R)], cy=YA), "SLATE", 0.012)
    b.hull(box(X(413), X(449), YA + 0.14, Y(207), -0.095, 0.095), "SLATE_DARK", 0.022)
    # --- receiver (cream)
    b.hull(ext_z([(X(445), Y(202)), (X(468), Y(195)), (X(740), Y(189)), (X(767), Y(197)), (X(771), Y(262)),
                  (X(752), Y(282)), (X(560), Y(300)), (X(445), Y(300))], -0.27, 0.27), "CREAM", 0.034)
    b.hull(ext_z([(X(468), Y(292)), (X(575), Y(292)), (X(575), Y(334)), (X(563), Y(347)), (X(480), Y(347)),
                  (X(468), Y(334))], -0.25, 0.25), "CREAM", 0.032)
    # turquoise top covers (step at x=598 px)
    b.hull(ext_z([(X(505), Y(214)), (X(505), Y(200)), (X(514), Y(194)), (X(598), Y(194)), (X(598), Y(214))], -0.205, 0.205), "TEAL", 0.018)
    b.hull(ext_z([(X(596), Y(206)), (X(596), Y(188)), (X(607), Y(181)), (X(733), Y(180)), (X(748), Y(188)), (X(748), Y(206))], -0.205, 0.205), "TEAL", 0.018)
    # orange side panels, charging slot, studs
    for s in (1, -1):
        b.hull(box(X(527), X(620), Y(284), Y(251), s * 0.255, s * 0.292), "ORANGE", 0.012)
        # (v4: the two receiver studs, front and lower rear, were removed on request)
    b.hull(box(X(676), X(737), Y(248), Y(232), 0.255, 0.276), "SLATE_DARK", 0.004)
    # --- hopper pedestal (feed neck, stays on the gun)
    b.hull(ext_z([(X(538), Y(214)), (X(538), Y(177)), (X(546), Y(170.5)), (X(600), Y(170.5)), (X(608), Y(177)), (X(608), Y(214))], -0.165, 0.165), "SLATE", 0.02)
    b.hull(box(X(527), X(619), Y(215), Y(201), -0.21, 0.21), "SLATE_DARK", 0.018)
    # --- trigger guard (dark, chunky like the reference), opening X 0.27..0.62, Y -0.41..-0.66
    tg = 0.095
    b.hull(ext_z([(0.15, -0.34), (0.27, -0.34), (0.27, -0.62), (0.235, -0.66), (0.15, -0.66)], -tg, tg), "SLATE", 0.026)
    b.hull(ext_z([(0.15, -0.64), (0.235, -0.64), (0.31, -0.66), (0.33, -0.785), (0.26, -0.79), (0.15, -0.72)], -tg, tg), "SLATE", 0.026)
    b.hull(ext_z([(0.30, -0.66), (0.70, -0.66), (0.74, -0.70), (0.72, -0.76), (0.66, -0.79), (0.30, -0.79)], -tg, tg), "SLATE", 0.026)
    # --- pistol grip (Popcorn Shotgun outline = same right-hand fit), teal rear panels, cream / teal base
    b.hull(ext_z(GRIP_POLY, -0.17, 0.17), "SLATE", 0.04)
    for s in (1, -1):
        b.hull(ext_z([(0.77, -0.42), (0.895, -0.37), (1.165, -1.29), (0.97, -1.29)], s * 0.09, s * 0.183), "TEAL", 0.016)
    b.hull(ext_z([(0.80, -1.19), (1.145, -1.19), (1.185, -1.33), (0.83, -1.33)], -0.185, 0.185), "CREAM", 0.025)
    b.hull(ext_z([(0.77, -1.305), (1.215, -1.305), (1.225, -1.40), (1.19, -1.44), (0.80, -1.44), (0.765, -1.40)], -0.20, 0.20), "TEAL", 0.03)
    for s in (1, -1):
        b.hull(prism_z((1.09, -1.255), [(s * 0.182, 0.042), (s * 0.215, 0.042)]), "ORANGE", 0.006)
    # --- foregrip mount (teal) + vertical foregrip (slate, ribbed front)
    b.hull(ext_z([(X(382), Y(298)), (X(470), Y(298)), (X(470), Y(328)), (X(460), Y(337)), (X(392), Y(337)), (X(382), Y(328))], -0.20, 0.20), "TEAL", 0.024)
    # (v4: foregrip-mount studs removed)
    fx0, fx1 = FOREGRIP_X - 0.20, FOREGRIP_X + 0.20
    b.hull(ext_z([(fx0, FOREGRIP_Y0), (fx1, FOREGRIP_Y0), (fx1, FOREGRIP_Y1 + 0.08), (fx1 - 0.045, FOREGRIP_Y1),
                  (fx0 + 0.045, FOREGRIP_Y1), (fx0, FOREGRIP_Y1 + 0.08)], -0.18, 0.18), "SLATE", 0.036)
    for k in range(4):
        yc = -0.72 - 0.135 * k
        b.hull(box(fx0 - 0.03, fx0 + 0.02, yc - 0.03, yc + 0.03, -0.145, 0.145), "SLATE_DARK", 0.01)
    # --- stock: teal collar, dark skeleton frame, cream top bar, teal butt pad
    b.hull(prism_x([(X(765), 0.20), (X(770), 0.235), (X(812), 0.235), (X(817), 0.20)], cy=Y(229)), "TEAL", 0.012)
    # (v4: collar stud removed)
    b.hull(ext_z([(X(815), Y(214)), (X(815), Y(196)), (X(930), Y(189)), (X(930), Y(212))], -0.10, 0.10), "SLATE", 0.02)
    # v3: hinge block on the back of the collar — the diagonal strut used to start 0.04 u behind the collar (floating)
    b.hull(box(X(806), X(838), Y(247), Y(212), -0.118, 0.118), "SLATE_DARK", 0.022)
    # (v4: hinge pins removed)
    b.hull(ext_z([(X(818), Y(244)), (X(818), Y(222)), (X(846), Y(225)), (X(913), Y(322)), (X(913), Y(347)), (X(892), Y(347))], -0.09, 0.09), "SLATE", 0.02)
    b.hull(ext_z([(X(893), Y(347)), (X(893), Y(205)), (X(918), Y(205)), (X(918), Y(347))], -0.09, 0.09), "SLATE", 0.02)
    b.hull(ext_z([(X(811), Y(201)), (X(820), Y(190)), (X(930), Y(173)), (X(936), Y(181)), (X(936), Y(198))], -0.13, 0.13), "CREAM", 0.022)
    b.hull(ext_z([(X(913), Y(181)), (X(925), Y(170)), (X(975), Y(170)), (X(986), Y(186)), (X(975), Y(341)), (X(960), Y(351)),
                  (X(926), Y(351)), (X(918), Y(341))], -0.20, 0.20), "TEAL", 0.034)
    return b


def build_trigger():
    t = Part("Trigger")
    t.hull(ext_z([(-0.035, 0.02), (0.035, 0.02), (0.028, -0.13), (-0.048, -0.15)], -0.035, 0.035), "YELLOW", 0.012)
    t.hull(ext_z([(-0.048, -0.12), (0.028, -0.11), (0.03, -0.18), (0.075, -0.235), (0.025, -0.262), (-0.045, -0.19)], -0.035, 0.035), "YELLOW", 0.012)
    return t


def build_charging_handle():
    c = Part("ChargingHandle")
    c.hull(box(-0.045, 0.045, -0.03, 0.03, -0.01, 0.10), "SLATE_DARK", 0.01)
    c.hull(prism_z((0.0, 0.0), [(0.09, 0.055), (0.135, 0.055)]), "ORANGE", 0.012)
    return c


def build_hopper_frame():
    h = Part("HopperFrame")
    cy = HOPPER_C[1]
    L = lambda pts: shift(pts, HOPPER_C)
    h.hull(L(prism_x([(-1.465, 0.31), (-1.43, 0.37), (-1.10, 0.37), (-1.065, 0.335)], cy=cy)), "TEAL", 0.02)
    h.hull(L(prism_x([(-1.50, 0.062), (-1.46, 0.062)], cy=cy + 0.02)), "ORANGE", 0.008)
    h.hull(L(prism_x([(-1.075, 0.37), (-1.055, 0.41), (-0.885, 0.41), (-0.865, 0.37)], cy=cy)), "SLATE", 0.016)
    h.hull(L(prism_x([(0.775, 0.37), (0.795, 0.41), (1.02, 0.41), (1.04, 0.37)], cy=cy)), "SLATE", 0.016)
    h.hull(L(box(-0.885, 0.795, cy + 0.245, cy + 0.335, -0.10, 0.10)), "TEAL", 0.02)
    h.hull(L(box(-0.885, 0.795, cy - 0.335, cy - 0.245, -0.10, 0.10)), "TEAL", 0.02)
    h.hull(L(box(X(527), X(617), Y(170.5), cy - 0.30, -0.205, 0.205)), "TEAL", 0.02)
    return h


def build_hopper_glass():
    g = Part("HopperGlass")
    g.hull(shift(prism_x([(TUBE_X0, TUBE_R), (TUBE_X1 - 0.06, TUBE_R), (TUBE_X1, TUBE_R - 0.06)], cy=HOPPER_C[1]), HOPPER_C), "GLASS", 0.0)
    return g


def build_ball():
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=2, radius=1.0)
    p = Part("Ball_Template"); p.bm.free(); p.bm = bm; p.cid = bm.faces.layers.int.new("cid")
    for f in bm.faces:
        f[p.cid] = PAL_KEYS.index("WHITE")
    return p


BALL_COLORS = ["BALL_RED", "BALL_YELLOW", "BALL_TEAL"]


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
    if rot is not None: ob.rotation_euler = rot
    return ob


def build(balls=None):
    """(Re)build the whole rifle in the active scene. balls: list of (x,y,z,color_index) in Hopper-local units."""
    sc = bpy.context.scene
    coll = ensure_collection("PaintballRifle", sc)
    mats = materials()
    root = empty("PaintballRifle", None, (0, 0, 0), coll, size=0.3, shape="ARROWS", rot=(math.radians(90), 0, 0))
    build_body().finish(root, (0, 0, 0), mats["vc"], coll)
    build_trigger().finish(root, TRIGGER_PIVOT, mats["vc"], coll)
    build_charging_handle().finish(root, CH_REST, mats["vc"], coll)
    hop = empty("Hopper", root, S(HOPPER_C), coll, size=0.15)
    for part, mat in ((build_hopper_frame(), mats["vc"]), (build_hopper_glass(), mats["glass"])):
        ob = part.finish(hop, (0, 0, 0), mat, coll, scale_about_anchor=False)
        me = ob.data
        for v in me.vertices: v.co *= SCALE
    tpl = build_ball().finish(hop, (0, 0, 0), mats["ball"], coll, scale_about_anchor=False)
    tpl.scale = (0.001,) * 3; tpl.hide_render = True; tpl.hide_viewport = True
    empty("Muzzle", root, S(MUZZLE), coll, 0.1)
    empty("GripSocket", root, S(GRIP), coll, 0.1)
    # preview balls (linked duplicates of the template, coloured through the object colour)
    for ob in [o for o in coll.objects if o.name.startswith("Ball_") and o.name != "Ball_Template"]:
        bpy.data.objects.remove(ob, do_unlink=True)
    if balls:
        for k, (x, y, z, ci) in enumerate(balls):
            ob = bpy.data.objects.new(f"Ball_{k:02d}", tpl.data); coll.objects.link(ob)
            ob.parent = hop; ob.matrix_parent_inverse = Matrix.Identity(4)
            ob.location = (x * SCALE, y * SCALE, z * SCALE); ob.scale = (BALL_R * SCALE,) * 3
            ob.color = (*PAL[BALL_COLORS[int(ci) % 3]], 1.0)
    return root


# ------------------------------------------------------------------ export (geometry back to the offline pipeline)
def dump(path):
    """Evaluated triangles of every mesh object of the rifle, in the object's LOCAL frame (glTF axes),
    face-flat normals and linear vertex colours, plus local node transforms (relative to the parent)."""
    dg = bpy.context.evaluated_depsgraph_get()
    out = {"objects": {}}
    coll = bpy.data.collections["PaintballRifle"]
    for ob in coll.objects:
        rec = {"parent": ob.parent.name if ob.parent else None, "location": list(ob.location),
               "rotation_euler": list(ob.rotation_euler), "scale": list(ob.scale), "type": ob.type}
        if ob.type == "MESH" and not (ob.name.startswith("Ball_") and ob.name != "Ball_Template"):
            ev = ob.evaluated_get(dg); me = ev.to_mesh()
            me.calc_loop_triangles()
            col = me.color_attributes.get("Col")
            P, N, C = [], [], []
            for tri in me.loop_triangles:
                n = tri.normal
                for li, vi in zip(tri.loops, tri.vertices):
                    v = me.vertices[vi].co
                    P.append([round(v.x, 6), round(v.y, 6), round(v.z, 6)])
                    N.append([round(n.x, 5), round(n.y, 5), round(n.z, 5)])
                    c = col.data[li].color if col else (1, 1, 1, 1)
                    C.append([round(c[0], 5), round(c[1], 5), round(c[2], 5)])
            rec.update(pos=P, nrm=N, col=C, material=ob.data.materials[0].name if ob.data.materials else None)
            ev.to_mesh_clear()
        if ob.name.startswith("Ball_") and ob.name != "Ball_Template":
            rec["color"] = list(ob.color)
        out["objects"][ob.name] = rec
    out["meta"] = {"scale": SCALE, "anchor": list(ANCHOR), "ball_r": BALL_R * SCALE, "tube_r": TUBE_R * SCALE,
                   "tube_x": [TUBE_X0 * SCALE, TUBE_X1 * SCALE], "hopper_c": list(S(HOPPER_C)), "trigger_pivot": list(S(TRIGGER_PIVOT)),
                   "muzzle": list(S(MUZZLE)), "grip": list(S(GRIP)), "ch_rest": list(S(CH_REST)), "ch_travel": CH_TRAVEL * SCALE,
                   "foregrip": {"x": S((FOREGRIP_X, 0, 0))[0], "y0": S((0, FOREGRIP_Y0, 0))[1], "y1": S((0, FOREGRIP_Y1, 0))[1],
                                "half": [0.20 * SCALE, 0.18 * SCALE]},
                   "ya": S((0, YA, 0))[1], "barrel_r": BARREL_R * SCALE, "px_to_unit": {"pxu": PXU / SCALE}}
    json.dump(out, open(path, "w"))
    return path
