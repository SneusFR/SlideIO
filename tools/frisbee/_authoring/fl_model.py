"""Frisbee Launcher — procedural low-poly model built INSIDE Blender (bmesh convex hulls + chamfer bevels).

A crossbow that shoots flying discs. Weapon-local units, glTF axes (forward -X, up +Y, +Z = gun's LEFT side); the
Blender root empty 'FrisbeeLauncher' is rotated +90° about X so every child is authored directly in glTF coordinates.
Two-handed: the pistol grip, trigger and guard are the Paintball Rifle ones (same GripSocket / right-hand hold / mounts
as the Popcorn - Paintball - FAMAS family); the vertical foregrip has the Paintball Rifle foregrip section (same fitted
left fist), moved just in front of the trigger guard.

Mechanism (every moving part is its own node):
  - LimbL / LimbR: the bow limbs, pivoting about +Y at the riser (flex when cocked). Cord anchors: LimbTipL / LimbTipR.
  - Sled: the carriage that rides in the channel under the deck. The elastic cords are knotted to it (nock), its fin
    sticks up through the deck slit and pushes the disc, a T-handle on top of the fin is the cocking handle.
  - CordL / CordR: elastic cords, unit length along +X (translation = limb tip, rotation toward the nock, scale.x =
    length) — recomputed from the limb and sled poses.
  - DiscDeck: the loaded frisbee on the deck. DiscHand: the one carried by the left hand during the re-cocking.
  - Cage: the disc magazine under the gun (5 discs, CageDisc0 = top), open on the LEFT side to pull a disc out.
Default state of the file = loaded + cocked.
"""
import bpy, bmesh, math, json, os
from mathutils import Vector, Matrix


def lin(c):
    out = []
    for v in c:
        v = v / 255.0
        out.append(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4)
    return tuple(out)


PAL = {
    "TEAL": lin((38, 168, 178)), "TEAL_DARK": lin((26, 132, 144)), "TEAL_LIGHT": lin((92, 196, 202)),
    "CREAM": lin((240, 230, 208)), "CREAM_DARK": lin((216, 202, 180)),
    "ORANGE": lin((244, 112, 58)), "ORANGE_DARK": lin((214, 84, 40)), "YELLOW": lin((250, 196, 62)),
    "NAVY": lin((40, 68, 112)), "NAVY_DARK": lin((26, 44, 76)), "BORE": lin((22, 28, 40)),
    "CORD": lin((34, 60, 128)), "WHITE": (1.0, 1.0, 1.0),
}
PAL_KEYS = list(PAL)

# ------------------------------------------------------------------ key points (weapon units)
GRIP = (0.874, -0.750, 0.0)                         # same GripSocket as the Popcorn / Paintball / FAMAS family


def SP(p):
    """Paintball Rifle authoring (x1.4 about the grip) -> final units (grip, trigger, guard reused as is)."""
    p = tuple(p) + (0.0,) * (3 - len(p))
    return tuple(GRIP[i] + 1.4 * (p[i] - GRIP[i]) for i in range(3))


TRIGGER_PIVOT = SP((0.545, -0.372, 0.0))
DECK_Y = 0.24                                        # top of the deck plate (the disc sits on it)
CORD_Y = 0.09                                        # cord plane (inside the channel under the deck)
DISC_R, DISC_H = 1.1, 0.24                           # frisbee radius / thickness
SLED_COCKED_X, SLED_FRONT_X = -1.25, -3.45           # nock x when cocked (at the latch) / after the shot (front stop)
DISC_LOADED = (SLED_COCKED_X - 0.14 - DISC_R, DECK_Y + DISC_H / 2, 0.0)
LIMB_PIVOT = (-3.85, CORD_Y, 0.60)                   # left limb pivot (right = mirrored z)
LIMB_TIP_LOCAL = (0.50, 0.0, 2.15)                   # cord anchor, limb-local (relaxed)
FLEX_DEG = 7.0                                       # limb flex when cocked (tips swing back)
NOCK_Z = 0.22                                        # cords knotted to the sled sides
FOREGRIP = dict(x=-0.66, y0=-0.20, y1=-1.236, half=(0.28, 0.252))   # Paintball Rifle foregrip section
CAGE_C = (DISC_LOADED[0], -0.22, 0.0)                # cage origin (top centre, under the keel)
CAGE_POST_R = 1.19
SLOT_Y = [-0.18 - 0.27 * k for k in range(5)]        # cage-local disc centres (0 = top): 5 discs
CAGE_BOTTOM = -1.47
LAUNCH = (-3.75, DISC_LOADED[1], 0.0)                # projectile start (the disc leaves the deck here), forward -X


# ------------------------------------------------------------------ point generators
def ngon(r, n=8, phase=None):
    phase = math.pi / n if phase is None else phase
    return [(math.cos(phase + k * 2 * math.pi / n) * r, math.sin(phase + k * 2 * math.pi / n) * r) for k in range(n)]


def prism_x(sections, n=8, cy=0.0, cz=0.0):
    return [(x, cy + u, cz + v) for x, r in sections for (u, v) in ngon(r, n)]


def prism_y(sections, n=8, cx=0.0, cz=0.0, phase=None):
    """Sections (y, r) around a vertical axis at (cx, cz)."""
    return [(cx + u, y, cz + v) for y, r in sections for (u, v) in ngon(r, n, phase)]


def ext_z(poly, z0, z1):
    return [(x, y, z) for (x, y) in poly for z in (z0, z1)]


def box(x0, x1, y0, y1, z0, z1):
    return [(x, y, z) for x in (x0, x1) for y in (y0, y1) for z in (z0, z1)]


def mirror_z(pts):
    return [(x, y, -z) for (x, y, z) in pts]


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

    def hull2(self, pts, color, bevel=0.0):
        """Hull + its mirror across z = 0 (left/right symmetric details)."""
        self.hull(pts, color, bevel); self.hull(mirror_z(pts), color, bevel)

    def finish(self, parent, origin=(0.0, 0.0, 0.0), material=None, coll=None, smooth=False):
        bmesh.ops.recalc_face_normals(self.bm, faces=list(self.bm.faces))
        for v in self.bm.verts:
            v.co -= Vector(origin)
        old_me = bpy.data.meshes.get(self.name)
        if old_me is not None:
            old_me.name = self.name + "_old"
        me = bpy.data.meshes.new(self.name)
        self.bm.to_mesh(me); self.bm.free()
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
        if material is not None:
            me.materials.append(material)
        ob = bpy.data.objects.get(self.name)
        if ob is None:
            ob = bpy.data.objects.new(self.name, me)
            (coll or bpy.context.scene.collection).objects.link(ob)
        ob.data = me
        if old_me is not None and old_me.users == 0:
            bpy.data.meshes.remove(old_me)
        ob.parent = parent
        ob.matrix_parent_inverse = Matrix.Identity(4)
        ob.location = origin
        ob.rotation_mode = "QUATERNION"; ob.rotation_quaternion = (1, 0, 0, 0); ob.scale = (1, 1, 1)
        return ob


def materials():
    m = bpy.data.materials.get("FL_VertexColor") or bpy.data.materials.new("FL_VertexColor")
    m.use_nodes = True
    nt = m.node_tree; nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    attr = nt.nodes.new("ShaderNodeVertexColor"); attr.layer_name = "Col"
    nt.links.new(attr.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.5
    bsdf.inputs["Metallic"].default_value = 0.0
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    return {"vc": m}


# ------------------------------------------------------------------ body
def build_body():
    b = Part("Body")
    dx0, dx1 = DISC_LOADED[0] - DISC_R - 0.02, SLED_COCKED_X + 0.1          # deck extent (front edge .. latch)
    # --- keel under the channel (teal) + channel interior (dark: the cords and the sled vanish in it)
    b.hull(box(-4.0, SLED_COCKED_X + 0.2, -0.24, 0.0, -0.36, 0.36), "TEAL", 0.04)
    b.hull(box(-3.9, SLED_COCKED_X + 0.15, -0.01, DECK_Y - 0.055, -0.33, 0.33), "NAVY_DARK", 0.0)
    # --- deck plate (teal dark, wide round-nosed tray) + centre slit for the sled fin + low cream side rails
    deck = [(x, z) for (x, z) in ngon(1.0, 20)]
    tray = [(DISC_LOADED[0] + 1.18 * u, DECK_Y - 0.06, 1.18 * v) for (u, v) in deck if u < 0.25] + \
           [(DISC_LOADED[0] + 1.18 * u, DECK_Y, 1.18 * v) for (u, v) in deck if u < 0.25] + \
           box(dx1 - 0.02, dx1, DECK_Y - 0.06, DECK_Y, -1.12, 1.12)
    b.hull(tray, "TEAL_DARK", 0.03)
    b.hull(box(dx0 + 0.25, dx1 - 0.02, DECK_Y - 0.004, DECK_Y + 0.004, -0.055, 0.055), "BORE", 0.0)
    for s in (1, -1):
        # low cream rails along both sides of the tray (short convex pieces along the arc)
        angs = [math.radians(d) for d in range(35, 151, 23)]
        for a0, a1 in zip(angs[:-1], angs[1:]):
            pts = []
            for a in (a0, a1):
                for rr in (1.19, 1.27):
                    for y in (DECK_Y - 0.03, DECK_Y + 0.09):
                        pts.append((DISC_LOADED[0] - rr * math.cos(a), y, s * rr * math.sin(a)))
            b.hull(pts, "CREAM", 0.012)
    # --- rear block (latch housing) + cream side panels + orange latch tab + rear sight
    b.hull([(SLED_COCKED_X + 0.1, -0.24, z) for z in (-0.38, 0.38)] + [(SLED_COCKED_X + 0.1, 0.26, z) for z in (-0.34, 0.34)] +
           [(1.45, -0.24, z) for z in (-0.38, 0.38)] + [(1.45, 0.42, z) for z in (-0.3, 0.3)] +
           [(1.2, 0.5, z) for z in (-0.3, 0.3)] + [(SLED_COCKED_X + 0.55, 0.50, z) for z in (-0.3, 0.3)], "TEAL", 0.05)
    for s in (1, -1):
        b.hull(ext_z([(SLED_COCKED_X + 0.35, -0.08), (SLED_COCKED_X + 0.35, 0.34), (1.05, 0.34), (1.25, 0.12), (1.25, -0.08)],
                     s * 0.37, s * 0.41), "CREAM", 0.02)
        b.hull(ext_z([(SLED_COCKED_X + 0.55, 0.02), (SLED_COCKED_X + 0.55, 0.22), (0.55, 0.22), (0.55, 0.02)], s * 0.405, s * 0.425),
               "TEAL_LIGHT", 0.008)
    b.hull(box(SLED_COCKED_X + 0.62, SLED_COCKED_X + 0.9, 0.49, 0.57, -0.16, 0.16), "ORANGE", 0.02)        # latch tab
    b.hull(box(0.82, 1.18, 0.46, 0.60, -0.22, 0.22), "ORANGE", 0.025)                                    # rear sight base
    b.hull2(box(0.9, 1.1, 0.58, 0.74, 0.07, 0.19), "ORANGE", 0.015)                                     # sight ears
    # --- riser (front block): the limbs pivot in it, the disc flies over it; orange front bumper
    b.hull([(x, y, z) for x in (-4.3, -3.55) for y in (-0.32, DECK_Y - 0.06) for z in (-0.72, 0.72)] +
           [(-3.45, -0.24, z) for z in (-0.4, 0.4)] + [(-3.45, DECK_Y - 0.06, z) for z in (-0.5, 0.5)], "TEAL", 0.05)
    b.hull(box(-4.44, -4.26, -0.26, DECK_Y - 0.1, -0.56, 0.56), "ORANGE", 0.04)
    b.hull2(box(-4.2, -3.6, -0.18, DECK_Y - 0.1, 0.72, 0.76), "CREAM", 0.012)
    for s in (1, -1):                                                        # pivot caps (navy discs on top)
        b.hull(prism_y([(DECK_Y - 0.07, 0.17), (DECK_Y - 0.02, 0.14)], n=10, cx=LIMB_PIVOT[0], cz=s * LIMB_PIVOT[2]), "NAVY", 0.01)
    # --- cage rail under the keel (the cage slides onto it)
    b.hull(box(CAGE_C[0] - 0.8, CAGE_C[0] + 0.8, -0.30, -0.22, -0.30, 0.30), "NAVY_DARK", 0.02)
    # --- trigger guard + pistol grip (Paintball Rifle ones): cream grip with navy insets, navy cap
    tg = 0.095 * 1.4
    for poly in ([(0.15, -0.30), (0.27, -0.30), (0.27, -0.62), (0.235, -0.66), (0.15, -0.66)],
                 [(0.15, -0.64), (0.235, -0.64), (0.31, -0.66), (0.33, -0.785), (0.26, -0.79), (0.15, -0.72)],
                 [(0.30, -0.66), (0.70, -0.66), (0.74, -0.70), (0.72, -0.76), (0.66, -0.79), (0.30, -0.79)]):
        b.hull(ext_z([SP(p)[:2] for p in poly], -tg, tg), "TEAL", 0.034)
    grip_poly = [(0.651, -0.30), (0.890, -0.30), (1.167, -1.311), (1.113, -1.402), (0.849, -1.402), (0.791, -1.344)]
    b.hull(ext_z([SP(p)[:2] for p in grip_poly], -0.17 * 1.4, 0.17 * 1.4), "CREAM", 0.05)
    for s in (1, -1):
        inset = [(0.80, -0.50), (0.90, -0.46), (1.10, -1.18), (0.95, -1.18)]
        b.hull(ext_z([SP(p)[:2] for p in inset], s * 0.2, s * 0.255), "NAVY", 0.02)
    b.hull(ext_z([SP(p)[:2] for p in [(0.77, -1.305), (1.215, -1.305), (1.225, -1.40), (1.19, -1.44), (0.80, -1.44), (0.765, -1.40)]],
                 -0.20 * 1.4, 0.20 * 1.4), "NAVY", 0.04)
    # --- vertical foregrip (Paintball Rifle section): navy post, cream front strip, teal foot
    fx, (hx, hz) = FOREGRIP["x"], FOREGRIP["half"]
    b.hull(box(fx - hx - 0.05, fx + hx + 0.05, FOREGRIP["y0"] - 0.02, 0.0, -hz - 0.04, hz + 0.04), "TEAL", 0.03)   # mount
    b.hull([(fx + u * hx, y, v * hz) for y in (FOREGRIP["y0"], FOREGRIP["y1"]) for (u, v) in
            [(-1, -0.7), (-0.7, -1), (0.7, -1), (1, -0.7), (1, 0.7), (0.7, 1), (-0.7, 1), (-1, 0.7)]], "NAVY", 0.03)
    b.hull(box(fx - hx - 0.02, fx - hx + 0.06, FOREGRIP["y0"] - 0.1, FOREGRIP["y1"] + 0.1, -0.15, 0.15), "CREAM", 0.015)
    b.hull([(fx + u * (hx + 0.08), y, v * (hz + 0.08)) for y in (FOREGRIP["y1"] + 0.02, FOREGRIP["y1"] - 0.1) for (u, v) in
            [(-1, -0.7), (-0.7, -1), (0.7, -1), (1, -0.7), (1, 0.7), (0.7, 1), (-0.7, 1), (-1, 0.7)]], "TEAL", 0.03)
    # --- skeletal stock: upper bar, lower bar, cream web, navy butt + orange pad
    b.hull(ext_z([(1.30, 0.40), (3.15, 0.26), (3.15, 0.02), (1.30, 0.02)], -0.24, 0.24), "TEAL", 0.05)
    b.hull(ext_z([(1.20, -0.16), (1.40, -0.16), (3.15, -0.62), (3.15, -0.86), (1.20, -0.42)], -0.22, 0.22), "TEAL", 0.05)
    b.hull(ext_z([(1.45, 0.05), (3.05, -0.02), (3.05, -0.62), (1.55, -0.18)], -0.10, 0.10), "CREAM", 0.02)
    b.hull(ext_z([(3.10, 0.34), (3.36, 0.34), (3.36, -1.00), (3.10, -1.00)], -0.30, 0.30), "NAVY", 0.05)
    b.hull(ext_z([(3.34, 0.28), (3.46, 0.26), (3.46, -0.94), (3.34, -0.96)], -0.26, 0.26), "ORANGE", 0.04)
    return b


def build_trigger():
    t = Part("Trigger")
    k = 1.4
    t.hull([(x * k + TRIGGER_PIVOT[0], y * k + TRIGGER_PIVOT[1], z * k) for (x, y, z) in
            ext_z([(-0.035, 0.02), (0.035, 0.02), (0.028, -0.13), (-0.048, -0.15)], -0.035, 0.035)], "ORANGE", 0.014)
    t.hull([(x * k + TRIGGER_PIVOT[0], y * k + TRIGGER_PIVOT[1], z * k) for (x, y, z) in
            ext_z([(-0.048, -0.12), (0.028, -0.11), (0.03, -0.18), (0.075, -0.235), (0.025, -0.262), (-0.045, -0.19)], -0.035, 0.035)],
           "ORANGE", 0.014)
    return t


def build_limb(side):
    """Limb in LIMB-local coordinates (origin on the pivot), left limb along +z (side=+1), right mirrored."""
    s = side
    L = Part("LimbL" if s > 0 else "LimbR")
    tx, _, tz = LIMB_TIP_LOCAL

    def sec(z, dx, hx, y0, y1):
        return [(dx + u, y, s * z) for u in (-hx, hx) for y in (y0, y1)]
    # root knuckle (navy, round) around the pivot, then 3 tapered teal segments swept back, orange tip cap
    L.hull([(math.cos(a) * 0.2, y, s * math.sin(a) * 0.2) for a in [k * 2 * math.pi / 10 for k in range(10)] for y in (-0.15, 0.14)],
           "NAVY", 0.02)
    segs = [(0.0, 0.0, 0.22, -0.13, 0.15), (0.55, 0.05, 0.21, -0.12, 0.14), (1.25, 0.18, 0.18, -0.10, 0.12),
            (1.85, 0.34, 0.15, -0.085, 0.10), (2.12, tx - 0.02, 0.13, -0.075, 0.09)]
    for a, bb in zip(segs[:-1], segs[1:]):
        L.hull(sec(*a) + sec(*bb), "TEAL", 0.035)
    # cream inlay on the top face of the middle segments
    for a, bb in zip(segs[1:3], segs[2:4]):
        L.hull([(dx + u, y, s * z) for (z, dx, hx, y0, y1) in (a, bb) for u in (-hx * 0.6, hx * 0.6) for y in (y1 - 0.01, y1 + 0.025)],
               "CREAM", 0.01)
    # orange tip cap with the cord notch (navy)
    L.hull([(tx + u, y, s * z) for u in (-0.17, 0.17) for y in (-0.13, 0.15) for z in (2.05, 2.30)], "ORANGE", 0.04)
    L.hull([(tx + u, y, s * z) for u in (-0.06, 0.06) for y in (-0.04, 0.04) for z in (2.02, 2.14)], "NAVY_DARK", 0.0)
    return L


def build_sled():
    """Sled in SLED-local coordinates (origin = the nock, where both cords are knotted)."""
    S = Part("Sled")
    S.hull(box(-0.18, 0.16, -0.08, 0.10, -0.30, 0.30), "ORANGE", 0.03)                  # carriage in the channel
    S.hull(box(-0.16, 0.08, 0.08, DISC_LOADED[1] + 0.10 - CORD_Y, -0.05, 0.05), "ORANGE_DARK", 0.015)   # fin (pushes the disc)
    S.hull2(box(-0.07, 0.07, -0.05, 0.05, NOCK_Z - 0.05, NOCK_Z + 0.05), "NAVY_DARK", 0.01)          # cord knots
    top = DISC_LOADED[1] + 0.10 - CORD_Y
    S.hull(prism_x([(-0.02, 0.09), (0.06, 0.09)], n=8, cy=top - 0.03), "ORANGE_DARK", 0.01)          # neck fin -> handle
    S.hull([(0.10 + math.cos(a) * 0.14, top + 0.02 + math.sin(a) * 0.13, z) for z in (-0.32, 0.32)
            for a in [k * 2 * math.pi / 10 for k in range(10)]], "ORANGE", 0.02)                      # T-handle (cocking)
    S.hull2([(0.10 + math.cos(a) * 0.15, top + 0.02 + math.sin(a) * 0.14, z) for z in (0.12, 0.30)
             for a in [k * 2 * math.pi / 10 for k in range(10)]], "NAVY", 0.01)                     # rubber grips
    return S


def build_disc(name):
    """Frisbee, disc-local (origin at the centre, +Y up): rounded rim, domed top, ring + cream label."""
    D = Part(name)
    R, H = DISC_R, DISC_H
    ring = lambda n, r, y, ph=0.0: [(math.cos(ph + k * 2 * math.pi / n) * r, y, math.sin(ph + k * 2 * math.pi / n) * r) for k in range(n)]
    D.hull(ring(24, R - 0.07, -H / 2) + ring(24, R, -H / 2 + 0.05) + ring(24, R, H / 2 - 0.07) + ring(24, R - 0.07, H / 2 - 0.02) +
           ring(24, 0.62, H / 2 + 0.01), "ORANGE", 0.0)
    D.hull(ring(24, R - 0.08, -H / 2 - 0.002) + ring(24, R - 0.18, -H / 2 - 0.004), "ORANGE_DARK", 0.0)     # underside shade
    for k in range(16):                                                                     # raised ring
        a0, a1 = k * 2 * math.pi / 16, (k + 1) * 2 * math.pi / 16
        pts = [(math.cos(a) * r, y, math.sin(a) * r) for a in (a0, a1) for r in (0.60, 0.70) for y in (H / 2 - 0.03, H / 2 + 0.025)]
        D.hull(pts, "YELLOW", 0.0)
    D.hull(ring(16, 0.30, H / 2 + 0.005) + ring(16, 0.26, H / 2 + 0.03), "CREAM", 0.0)                     # label
    return D


def build_cage():
    """Cage in CAGE-local coordinates (origin = top centre): top plate, 4 posts (front, rear, 2 on the right),
    right wall, bottom plate + orange spring button. The LEFT side is open."""
    C = Part("Cage")
    r = CAGE_POST_R
    C.hull(prism_y([(0.0, r + 0.02), (-0.07, r + 0.02)], n=20), "NAVY", 0.02)
    C.hull(prism_y([(CAGE_BOTTOM + 0.07, r + 0.02), (CAGE_BOTTOM, r - 0.05)], n=20), "NAVY", 0.02)
    C.hull(prism_y([(CAGE_BOTTOM - 0.001, 0.28), (CAGE_BOTTOM - 0.07, 0.24)], n=12), "ORANGE", 0.015)
    for deg in (0, 180, 235, 305):
        a = math.radians(deg)
        cx, cz = -math.cos(a) * r, math.sin(a) * r
        C.hull(box(cx - 0.07, cx + 0.07, CAGE_BOTTOM + 0.03, -0.03, cz - 0.07, cz + 0.07), "NAVY_DARK", 0.02)
    for d0 in range(205, 336, 26):
        pts = []
        for a in (math.radians(d0), math.radians(min(d0 + 26, 336))):
            for rr in (r - 0.02, r + 0.04):
                for y in (-0.05, CAGE_BOTTOM + 0.05):
                    pts.append((-math.cos(a) * rr, y, math.sin(a) * rr))
        C.hull(pts, "NAVY", 0.01)
    # small teal grab tab under the front of the bottom plate (the hand pulls the cage by it)
    C.hull(box(-r - 0.1, -r + 0.35, CAGE_BOTTOM - 0.16, CAGE_BOTTOM - 0.02, -0.35, 0.35), "TEAL", 0.04)
    return C


def build_cord(name):
    """Unit elastic cord along +X (the node scales it to the tip-nock distance)."""
    c = Part(name)
    c.hull([(x, math.cos(a) * 0.04, math.sin(a) * 0.04) for x in (0.0, 1.0) for a in [k * 2 * math.pi / 6 for k in range(6)]],
           "CORD", 0.0)
    return c


# ------------------------------------------------------------------ helpers
def ensure_collection(name, scene):
    c = bpy.data.collections.get(name) or bpy.data.collections.new(name)
    if c.name not in scene.collection.children:
        scene.collection.children.link(c)
    return c


def empty(name, parent, loc, coll, size=0.08, shape="PLAIN_AXES"):
    ob = bpy.data.objects.get(name)
    if ob is None:
        ob = bpy.data.objects.new(name, None); coll.objects.link(ob)
    ob.empty_display_type = shape; ob.empty_display_size = size
    ob.parent = parent; ob.matrix_parent_inverse = Matrix.Identity(4)
    ob.location = loc
    return ob


def rot_y(deg):
    return Matrix.Rotation(math.radians(deg), 4, "Y")


def limb_tip(side, flex):
    """Cord anchor in ROOT space for a limb flexed by `flex` (0 relaxed .. 1 cocked)."""
    s = side
    px, py, pz = LIMB_PIVOT
    tx, ty, tz = LIMB_TIP_LOCAL
    a = math.radians(FLEX_DEG * flex) * s          # left limb: +y rotation swings the tip toward +x (back)
    x = tx * math.cos(a) + s * tz * math.sin(a)
    z = -tx * math.sin(a) + s * tz * math.cos(a)
    return Vector((px + x, py + ty, s * pz + z))


def set_state(objs, sled_x=SLED_COCKED_X, flex=1.0):
    """Pose the mechanism: sled position, limb flex, cords (translation / rotation / scale.x)."""
    objs["Sled"].location = (sled_x, CORD_Y, 0.0)
    for s, nm in ((1, "L"), (-1, "R")):
        lb = objs["Limb" + nm]
        lb.rotation_quaternion = rot_y(FLEX_DEG * flex * s).to_quaternion()
        tip = limb_tip(s, flex)
        nock = Vector((sled_x, CORD_Y, s * NOCK_Z))
        d = nock - tip
        cd = objs["Cord" + nm]
        cd.location = tip
        cd.rotation_quaternion = Vector((1, 0, 0)).rotation_difference(d.normalized())
        cd.scale = (d.length, 1.0, 1.0)


def build():
    sc = bpy.context.scene
    coll = ensure_collection("FrisbeeLauncher", sc)
    mats = materials()
    root = empty("FrisbeeLauncher", None, (0, 0, 0), coll, size=0.3, shape="ARROWS")
    root.rotation_mode = "XYZ"; root.rotation_euler = (math.radians(90), 0, 0)
    objs = {}
    objs["Body"] = build_body().finish(root, (0, 0, 0), mats["vc"], coll)
    objs["Trigger"] = build_trigger().finish(root, TRIGGER_PIVOT, mats["vc"], coll)
    for s, nm in ((1, "L"), (-1, "R")):
        lb = build_limb(s).finish(root, (0, 0, 0), mats["vc"], coll)
        lb.location = (LIMB_PIVOT[0], LIMB_PIVOT[1], s * LIMB_PIVOT[2])
        objs["Limb" + nm] = lb
        tx, ty, tz = LIMB_TIP_LOCAL
        empty("LimbTip" + nm, lb, (tx, ty, s * tz), coll, 0.05)
        objs["Cord" + nm] = build_cord("Cord" + nm).finish(root, (0, 0, 0), mats["vc"], coll)
    objs["Sled"] = build_sled().finish(root, (0, 0, 0), mats["vc"], coll)
    empty("SledHandle", objs["Sled"], (0.10, DISC_LOADED[1] + 0.12 - CORD_Y, 0.0), coll, 0.05)
    d = build_disc("DiscDeck").finish(root, (0, 0, 0), mats["vc"], coll)
    d.location = DISC_LOADED
    objs["DiscDeck"] = d
    dh = build_disc("DiscHand").finish(root, (0, 0, 0), mats["vc"], coll)
    dh.location = (DISC_LOADED[0], SLOT_Y[0] + CAGE_C[1], 1.8)
    dh.scale = (0, 0, 0)
    objs["DiscHand"] = dh
    cg = build_cage().finish(root, (0, 0, 0), mats["vc"], coll)
    cg.location = CAGE_C
    objs["Cage"] = cg
    for k, y in enumerate(SLOT_Y):
        cd = build_disc(f"CageDisc{k}").finish(cg, (0, 0, 0), mats["vc"], coll)
        cd.location = (0.0, y, 0.0)
    empty("LaunchSocket", root, LAUNCH, coll, 0.1)
    empty("GripSocket", root, GRIP, coll, 0.1)
    set_state(objs)
    return root, objs


# ------------------------------------------------------------------ export (geometry back to the offline pipeline)
def dump(path):
    dg = bpy.context.evaluated_depsgraph_get()
    out = {"objects": {}}
    coll = bpy.data.collections["FrisbeeLauncher"]
    for ob in coll.objects:
        q = ob.rotation_quaternion if ob.rotation_mode == "QUATERNION" else ob.rotation_euler.to_quaternion()
        rec = {"parent": ob.parent.name if ob.parent else None, "location": list(ob.location),
               "rotation_wxyz": list(q), "scale": list(ob.scale), "type": ob.type}
        if ob.type == "MESH":
            me = ob.data
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
            rec.update(pos=Pp, nrm=N, col=C)
        out["objects"][ob.name] = rec
    out["meta"] = {"grip": list(GRIP), "trigger_pivot": list(TRIGGER_PIVOT), "deck_y": DECK_Y, "cord_y": CORD_Y,
                   "disc_r": DISC_R, "disc_h": DISC_H, "sled_cocked_x": SLED_COCKED_X, "sled_front_x": SLED_FRONT_X,
                   "disc_loaded": list(DISC_LOADED), "limb_pivot": list(LIMB_PIVOT), "limb_tip_local": list(LIMB_TIP_LOCAL),
                   "flex_deg": FLEX_DEG, "nock_z": NOCK_Z, "foregrip": FOREGRIP, "cage_c": list(CAGE_C),
                   "cage_post_r": CAGE_POST_R, "slot_y": SLOT_Y, "cage_bottom": CAGE_BOTTOM, "launch": list(LAUNCH)}
    json.dump(out, open(path, "w"))
    return path
