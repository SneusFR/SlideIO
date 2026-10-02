# -*- coding: utf-8 -*-
# GIVRE - Station alpine (fast FPS, 8 joueurs) - generateur Blender 4.3
# Plan : minimap 280 x 280 (1 unite = 1 m). u vers l'est, v vers le sud.
# Blender : X = u - 140 (est), Y = 140 - v (nord), Z vers le haut.
import bpy, bmesh, math, random, json
from mathutils import Vector, Matrix

ROOT = "GIVRE"
BAND_H = 1.4      # soubassement teal
WALL_T = 1.2      # epaisseur des murs de salle
ROOM_H = 8.0      # hauteur libre des salles
ROOF_T = 0.8
CAP_T = 0.4       # chapeau de neige
CAP_O = 0.3       # debord du chapeau
DOOR_W = 14.0     # largeur totale d'une porte de salle (cadre compris)
DOOR_H = 5.0      # hauteur libre des portes de salle
FRAME = 0.8       # face des cadres orange
FRAME_D = 0.25    # debord des cadres
GAL_Z = 6.0       # galerie nord
TRAV_H = 5.5      # hauteur libre de la traverse
FLOOR_Z = 0.03    # sols interieurs


def X(u):
    return u - 140.0


def Y(v):
    return 140.0 - v


def R(u0, v0, u1, v1):
    """Rectangle minimap -> (x0, y0, x1, y1) Blender."""
    xa, xb = sorted((X(u0), X(u1)))
    ya, yb = sorted((Y(v0), Y(v1)))
    return xa, ya, xb, yb


# ------------------------------------------------------------------ couleurs
def hex_lin(h):
    h = h.lstrip('#')
    c = [int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)]
    f = lambda x: x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4
    return (f(c[0]), f(c[1]), f(c[2]), 1.0)


PALETTE = {
    # nom: (hex sRGB, roughness, specular)
    'GIV_Neige': ('#f4f5f9', 0.92, 0.25),
    'GIV_Mur': ('#d6cec8', 0.9, 0.2),
    'GIV_Bande': ('#1f6f96', 0.8, 0.3),
    'GIV_Teal': ('#286a8c', 0.75, 0.3),
    'GIV_Orange': ('#f45a1c', 0.6, 0.35),
    'GIV_Caisse': ('#c8662f', 0.75, 0.3),
    'GIV_Ardoise': ('#5b7187', 0.8, 0.3),
    'GIV_Rail': ('#2a3a4d', 0.5, 0.4),
    'GIV_Tuyau': ('#434c58', 0.55, 0.4),
    'GIV_SolInt': ('#7c879a', 0.45, 0.4),
    'GIV_Plafond': ('#a6a6ab', 0.9, 0.2),
    'GIV_PorteSombre': ('#5f6b7b', 0.7, 0.3),
    'GIV_Sombre': ('#2f3742', 0.8, 0.2),
    'GIV_Fenetre': ('#6f7782', 0.35, 0.5),
    'GIV_Montagne': ('#f2f5fa', 0.95, 0.1),
    'GIV_Collider': ('#ff2fd0', 1.0, 0.0),
    'GIV_Clip': ('#2fd0ff', 1.0, 0.0),
}


def M(name):
    m = bpy.data.materials.get(name)
    if m is None:
        m = make_materials()[name]
    return m


def make_materials():
    out = {}
    for name, (hx, rough, spec) in PALETTE.items():
        m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
        m.use_nodes = True
        nt = m.node_tree
        bsdf = nt.nodes.get("Principled BSDF")
        if bsdf is None:
            nt.nodes.clear()
            bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
            o = nt.nodes.new("ShaderNodeOutputMaterial")
            nt.links.new(bsdf.outputs[0], o.inputs[0])
        col = hex_lin(hx)
        bsdf.inputs["Base Color"].default_value = col
        bsdf.inputs["Roughness"].default_value = rough
        if "Specular IOR Level" in bsdf.inputs:
            bsdf.inputs["Specular IOR Level"].default_value = spec
        m.diffuse_color = col
        m.roughness = rough
        if name in ('GIV_Collider', 'GIV_Clip'):
            bsdf.inputs["Alpha"].default_value = 0.35
            m.diffuse_color = (col[0], col[1], col[2], 0.35)
            try:
                m.surface_render_method = 'BLENDED'
            except Exception:
                pass
        out[name] = m
    # lampes (emissif)
    m = bpy.data.materials.get('GIV_Lampe') or bpy.data.materials.new('GIV_Lampe')
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (1, 1, 1, 1)
    bsdf.inputs["Emission Color"].default_value = (1.0, 0.98, 0.95, 1)
    bsdf.inputs["Emission Strength"].default_value = 6.0
    m.diffuse_color = (1, 1, 1, 1)
    out['GIV_Lampe'] = m
    return out


# ------------------------------------------------------------- collections
def get_coll(name, parent=None):
    c = bpy.data.collections.get(name)
    if c is None:
        c = bpy.data.collections.new(name)
        (parent if parent is not None else bpy.context.scene.collection).children.link(c)
    return c


def root():
    return get_coll(ROOT)


def sub(name):
    return get_coll(ROOT + "_" + name, root())


def clear(c):
    for ch in list(c.children):
        clear(ch)
    for o in list(c.objects):
        d = o.data
        bpy.data.objects.remove(o, do_unlink=True)
        if d is not None and getattr(d, 'users', 1) == 0:
            for coll_ in (bpy.data.meshes, bpy.data.lights, bpy.data.cameras):
                try:
                    coll_.remove(d)
                    break
                except Exception:
                    pass


# ------------------------------------------------------------ mesh builder
def rect(x0, y0, x1, y1):
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]


def chamfer(x0, y0, x1, y1, c):
    return [(x0 + c, y0), (x1 - c, y0), (x1, y0 + c), (x1, y1 - c),
            (x1 - c, y1), (x0 + c, y1), (x0, y1 - c), (x0, y0 + c)]


def is_rect(poly):
    if len(poly) != 4:
        return False
    xs = sorted(set(round(p[0], 4) for p in poly))
    ys = sorted(set(round(p[1], 4) for p in poly))
    return len(xs) == 2 and len(ys) == 2


class MB:
    """Accumule des primitives dans un seul bmesh -> un objet."""

    def __init__(self):
        self.bm = bmesh.new()
        self.mats = []
        self.wl = self.bm.edges.layers.float.new("bevel_weight_edge")
        self.col = []
        self.has_w = False

    def mi(self, m):
        m = M(m) if isinstance(m, str) else m
        if m not in self.mats:
            self.mats.append(m)
        return self.mats.index(m)

    def face(self, verts, mat, smooth=False, w=0.0):
        f = self.bm.faces.new(verts)
        f.material_index = self.mi(mat)
        f.smooth = smooth
        if w > 0:
            self.has_w = True
            for e in f.edges:
                if e[self.wl] < w:
                    e[self.wl] = w
        return f

    def add_col(self, poly, z0, z1, role):
        if not role:
            return
        if is_rect(poly):
            xs = [p[0] for p in poly]
            ys = [p[1] for p in poly]
            self.col.append({'t': 'box', 'role': role,
                             'min': [min(xs), min(ys), z0], 'max': [max(xs), max(ys), z1]})
        else:
            pts = [[p[0], p[1], z0] for p in poly] + [[p[0], p[1], z1] for p in poly]
            self.col.append({'t': 'hull', 'role': role, 'pts': pts})

    def prism(self, poly, zs, mats, top=None, bot=None, smooth=False, w=0.0, col=None):
        bm = self.bm
        rings = [[bm.verts.new((p[0], p[1], z)) for p in poly] for z in zs]
        n = len(poly)
        for k in range(len(zs) - 1):
            for i in range(n):
                j = (i + 1) % n
                self.face((rings[k][i], rings[k][j], rings[k + 1][j], rings[k + 1][i]),
                          mats[k], smooth, w)
        if top:
            self.face(rings[-1], top, smooth, w)
        if bot:
            self.face(list(reversed(rings[0])), bot, smooth, w)
        self.add_col(poly, zs[0], zs[-1], col)

    def loft(self, poly0, z0, poly1, z1, mat, top=None, smooth=False, w=0.0):
        bm = self.bm
        r0 = [bm.verts.new((p[0], p[1], z0)) for p in poly0]
        r1 = [bm.verts.new((p[0], p[1], z1)) for p in poly1]
        n = len(poly0)
        for i in range(n):
            j = (i + 1) % n
            self.face((r0[i], r0[j], r1[j], r1[i]), mat, smooth, w)
        if top:
            self.face(r1, top, smooth, w)

    def block(self, x0, y0, x1, y1, z0, z1, side='GIV_Mur', band='GIV_Bande', top='GIV_Mur',
              bot=None, band_h=BAND_H, col='solid', poly=None, w=0.0):
        poly = poly or rect(x0, y0, x1, y1)
        if band and z0 < band_h - 0.01 and z1 > band_h + 0.01:
            zs, mats = [z0, band_h, z1], [band, side]
        elif band and z1 <= band_h + 0.01:
            zs, mats = [z0, z1], [band]
        else:
            zs, mats = [z0, z1], [side]
        self.prism(poly, zs, mats, top=top, bot=bot, col=col, w=w)

    def cap(self, x0, y0, x1, y1, z, o=CAP_O, t=CAP_T, w=1.0, c=0.0, mat='GIV_Neige'):
        poly = chamfer(x0 - o, y0 - o, x1 + o, y1 + o, c + o * 0.586) if c > 0 else rect(x0 - o, y0 - o, x1 + o, y1 + o)
        self.prism(poly, [z - 0.05, z + t], [mat], top=mat, bot=mat, smooth=True, w=w)

    def beam(self, p0, p1, wd, ht, mat, col=None, w=0.0):
        """Poutre entre deux points 3D (section wd x ht, verticale)."""
        p0, p1 = Vector(p0), Vector(p1)
        d = p1 - p0
        hd = Vector((d.x, d.y, 0.0))
        if hd.length < 1e-6:
            hd = Vector((1.0, 0.0, 0.0))
        hd.normalize()
        n = Vector((-hd.y, hd.x, 0.0)) * (wd / 2.0)
        up = Vector((0.0, 0.0, ht / 2.0))
        c = [p0 - n - up, p0 + n - up, p0 + n + up, p0 - n + up,
             p1 - n - up, p1 + n - up, p1 + n + up, p1 - n + up]
        bm = self.bm
        v = [bm.verts.new(q) for q in c]
        quads = [(0, 1, 2, 3), (7, 6, 5, 4), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)]
        for q in quads:
            try:
                self.face([v[i] for i in q], mat, False, w)
            except ValueError:
                pass
        if col:
            self.col.append({'t': 'hull', 'role': col, 'pts': [list(q) for q in c]})

    def tube(self, p0, p1, r, mat, n=12, caps=True, smooth=True):
        p0, p1 = Vector(p0), Vector(p1)
        ax = (p1 - p0).normalized()
        ref = Vector((0, 0, 1)) if abs(ax.z) < 0.9 else Vector((1, 0, 0))
        e1 = ax.cross(ref).normalized()
        e2 = ax.cross(e1).normalized()
        bm = self.bm
        r0, r1 = [], []
        for i in range(n):
            a = 2 * math.pi * i / n
            off = (e1 * math.cos(a) + e2 * math.sin(a)) * r
            r0.append(bm.verts.new(p0 + off))
            r1.append(bm.verts.new(p1 + off))
        for i in range(n):
            j = (i + 1) % n
            self.face((r0[i], r0[j], r1[j], r1[i]), mat, smooth)
        if caps:
            self.face(list(reversed(r0)), mat, False)
            self.face(r1, mat, False)
        pts = [list(q.co) for q in r0 + r1]
        self.col.append({'t': 'hull', 'role': 'solid', 'pts': pts})

    def sphere(self, c, r, mat, seg=12, rings=6):
        ret = bmesh.ops.create_uvsphere(self.bm, u_segments=seg, v_segments=rings, radius=r,
                                        matrix=Matrix.Translation(Vector(c)))
        mi = self.mi(mat)
        fs = set()
        for v in ret['verts']:
            for f in v.link_faces:
                fs.add(f)
        for f in fs:
            f.material_index = mi
            f.smooth = True

    def wedge(self, L, W, H, top='GIV_Neige', side='GIV_Teal', col='solid'):
        """Rampe locale : monte de x=0 (z=0) a x=L (z=H), largeur W centree sur y=0."""
        bm = self.bm
        a = bm.verts.new((0, -W / 2, 0)); b = bm.verts.new((L, -W / 2, 0))
        c = bm.verts.new((L, W / 2, 0)); d = bm.verts.new((0, W / 2, 0))
        e = bm.verts.new((L, -W / 2, H)); f = bm.verts.new((L, W / 2, H))
        self.face((a, e, f, d), top)
        self.face((a, b, e), side)
        self.face((d, f, c), side)
        self.face((b, c, f, e), side)
        pts = [[0, -W / 2, 0], [L, -W / 2, 0], [L, W / 2, 0], [0, W / 2, 0], [L, -W / 2, H], [L, W / 2, H]]
        if col:
            self.col.append({'t': 'hull', 'role': col, 'pts': pts})

    def to_object(self, name, coll, bevel=0.2, segs=3, loc=(0, 0, 0), rot_z=0.0):
        me = bpy.data.meshes.new(name)
        self.bm.normal_update()
        self.bm.to_mesh(me)
        self.bm.free()
        for m in self.mats:
            me.materials.append(m)
        ob = bpy.data.objects.new(name, me)
        coll.objects.link(ob)
        ob.location = loc
        ob.rotation_euler = (0, 0, rot_z)
        if self.has_w and bevel > 0:
            md = ob.modifiers.new("Arrondi", 'BEVEL')
            md.width = bevel
            md.segments = segs
            md.limit_method = 'WEIGHT'
            try:
                md.edge_weight = "bevel_weight_edge"
            except Exception:
                pass
            md.harden_normals = True
            md.use_clamp_overlap = True
        if self.col:
            # colliders exprimes dans le repere du monde
            mw = Matrix.Translation(Vector(loc)) @ Matrix.Rotation(rot_z, 4, 'Z')
            out = []
            for c in self.col:
                if c['t'] == 'box' and abs(rot_z) < 1e-6:
                    out.append({'t': 'box', 'role': c['role'],
                                'min': [c['min'][i] + loc[i] for i in range(3)],
                                'max': [c['max'][i] + loc[i] for i in range(3)]})
                else:
                    if c['t'] == 'box':
                        mn, mx = c['min'], c['max']
                        pts = [[x, y, z] for x in (mn[0], mx[0]) for y in (mn[1], mx[1]) for z in (mn[2], mx[2])]
                    else:
                        pts = c['pts']
                    out.append({'t': 'hull', 'role': c['role'],
                                'pts': [list(mw @ Vector(p)) for p in pts]})
            ob['givre_col'] = json.dumps(out)
        return ob


# ---------------------------------------------------------------- layout
ROOMS = {
    # nom : (u0, v0, u1, v1), portes {cote: [centre]}
    'STOCK': ((13.0, 15.0, 78.75, 78.75), {'S': [64.0], 'E': [45.0]}),
    'CHAUFFERIE': ((201.5, 15.0, 267.0, 78.75), {'W': [45.0], 'S': [235.8]}),
    'ATELIER': ((13.0, 201.5, 78.75, 265.0), {'N': [44.0], 'E': [233.8]}),
    'TRANSIT': ((201.5, 201.5, 267.0, 265.0), {'W': [233.8], 'N': [213.0, 235.8]}),
}

MASSES = [
    # nom, u0, v0, u1, v1, hauteur
    ('PN1', 0, 0, 78.75, 15.0, 16.0),
    ('PN2', 78.75, 0, 201.5, 15.0, 18.0),
    ('PN3', 201.5, 0, 280, 15.0, 16.5),
    ('PW1', 0, 15.0, 13.0, 78.75, 15.0),
    ('W_MID', 0, 78.75, 53.25, 159.4, 14.0),
    ('W_LOW', 0, 159.4, 33.25, 201.5, 12.5),
    ('PW3', 0, 201.5, 13.0, 265.0, 15.0),
    ('PS1', 0, 265.0, 78.75, 280, 16.0),
    ('PS2A', 78.75, 245.05, 140.0, 280, 13.5),
    ('PS2B', 140.0, 245.05, 201.5, 280, 15.0),
    ('PS3', 201.5, 265.0, 280, 280, 16.5),
    ('PE1', 267.0, 15.0, 280, 78.75, 15.0),
    ('E_MID1', 247.05, 78.75, 280, 95.3, 14.0),
    ('E_MID2', 259.1, 95.3, 280, 164.9, 15.5),
    ('E_MID3', 247.05, 164.9, 280, 201.5, 14.0),
    ('PE3', 267.0, 201.5, 280, 265.0, 15.0),
    ('N_MID', 78.75, 15.0, 201.5, 33.2, 14.5),
    ('P1', 78.75, 56.75, 127.35, 85.3, 4.0),
    ('Q1', 149.9, 56.75, 201.5, 85.3, 4.0),
    ('P3', 74.75, 78.75, 94.3, 113.35, 9.5),
    ('Q4', 186.0, 78.75, 201.5, 113.35, 9.5),
    ('Q3', 201.5, 78.75, 224.55, 95.3, 10.5),
    ('WB', 74.75, 135.85, 94.3, 151.4, 8.0),
    ('R1', 186.0, 135.85, 201.5, 181.5, 9.0),
    ('R2', 201.5, 164.9, 224.55, 181.5, 10.0),
    ('T1', 89.9, 177.0, 127.35, 181.5, 6.6),
    ('T2', 149.9, 177.0, 186.0, 181.5, 6.6),
    ('SB', 54.75, 182.0, 77.25, 201.5, 8.0),
    ('TW', 74.75, 173.0, 77.25, 182.0, 5.0),
    ('CS1', 78.75, 203.0, 127.35, 222.5, 9.0),
    ('CS2', 149.9, 203.0, 201.5, 222.5, 8.5),
]

ROOM_PILLARS = {
    'STOCK': [(35.0, 36.5), (56.5, 36.5), (35.0, 58.5), (56.5, 58.5)],
    'CHAUFFERIE': [(221.0, 37.0), (241.0, 37.0), (221.0, 57.5), (241.0, 57.5)],
    'ATELIER': [(35.0, 227.0), (56.5, 227.0), (35.0, 245.0), (56.5, 245.0)],
    'TRANSIT': [(223.0, 222.0), (244.0, 222.0), (223.0, 238.0), (244.0, 238.0)],
}

# Volumes techniques poses sur les toits du pourtour (silhouette en gradins)
UPPERS = [
    ('W_MID_haut', 10.0, 100.0, 35.0, 140.0, 14.0, 4.0),
    ('E_MID2_haut', 266.0, 110.0, 278.0, 150.0, 15.5, 3.5),
    ('PS2A_haut', 95.0, 255.0, 125.0, 272.0, 13.5, 4.0),
    ('E_MID1_haut', 255.0, 82.0, 275.0, 92.0, 14.0, 3.0),
    ('W_LOW_haut', 5.0, 170.0, 25.0, 195.0, 12.5, 3.0),
    ('N_MID_haut', 128.0, 17.0, 152.0, 29.0, 14.5, 2.5),
]

# Murets (couverture basse, franchissable)
LOW_WALLS = [('MURET_CourOuest', 93.8, 151.4, 94.8, 177.0, 1.2)]


# ------------------------------------------------------------- stage: base
def stage_setup():
    sc = bpy.context.scene
    for n in ('Cube', 'Light', 'Camera'):
        o = bpy.data.objects.get(n)
        if o is not None:
            bpy.data.objects.remove(o, do_unlink=True)
    make_materials()
    root()
    for s in ('Sol', 'Batiments', 'Salles', 'Galerie', 'Couvertures', 'Decor', 'Fond',
              'Lumieres', 'Cameras', 'Spawns', 'Colliders'):
        sub(s)
    sc.unit_settings.system = 'METRIC'
    sc.unit_settings.scale_length = 1.0
    return "setup ok"


def stage_ground():
    c = sub('Sol')
    clear(c)
    mb = MB()
    mb.prism(rect(-140, -140, 140, 140), [-1.0, 0.0], ['GIV_Neige'], top='GIV_Neige', col='solid')
    mb.to_object('SOL_Neige', c)
    return "ground ok"


def stage_masses():
    c = sub('Batiments')
    clear(c)
    for (name, u0, v0, u1, v1, h) in MASSES:
        x0, y0, x1, y1 = R(u0, v0, u1, v1)
        mb = MB()
        mb.block(x0, y0, x1, y1, 0.0, h)
        mb.cap(x0, y0, x1, y1, h)
        mb.to_object('BAT_' + name, c)
    for (name, u0, v0, u1, v1, z0, dh) in UPPERS:
        x0, y0, x1, y1 = R(u0, v0, u1, v1)
        mb = MB()
        mb.block(x0, y0, x1, y1, z0, z0 + dh, band=None, col=None)
        mb.cap(x0, y0, x1, y1, z0 + dh)
        mb.to_object('BAT_' + name, c)
    for (name, u0, v0, u1, v1, h) in LOW_WALLS:
        x0, y0, x1, y1 = R(u0, v0, u1, v1)
        mb = MB()
        mb.block(x0, y0, x1, y1, 0.0, h, side='GIV_Teal', band=None, top='GIV_Teal')
        mb.cap(x0, y0, x1, y1, h, o=0.12, t=0.22, w=0.6)
        mb.to_object(name, c)
    return "masses ok: %d" % len(MASSES)


# ---------------------------------------------------------------- helpers
def ccw(poly):
    a = 0.0
    for i in range(len(poly)):
        x0, y0 = poly[i]
        x1, y1 = poly[(i + 1) % len(poly)]
        a += x0 * y1 - x1 * y0
    return poly if a > 0 else list(reversed(poly))


def offset_ortho(poly, o):
    """Decale un polygone orthogonal CCW vers l'exterieur de o."""
    n = len(poly)
    out = []
    for i in range(n):
        p = Vector((poly[i][0], poly[i][1]))
        a = Vector((poly[i - 1][0], poly[i - 1][1]))
        b = Vector((poly[(i + 1) % n][0], poly[(i + 1) % n][1]))
        e0 = (p - a).normalized()
        e1 = (b - p).normalized()
        n0 = Vector((e0.y, -e0.x))
        n1 = Vector((e1.y, -e1.x))
        q = p + (n0 + n1) * o
        out.append((q.x, q.y))
    return out


def wall_run(mb, axis, a0, a1, c, t, H, holes, side='GIV_Mur', band='GIV_Bande'):
    """Mur droit le long de X (axis 'x', y=c) ou de Y (axis 'y', x=c), avec ouvertures.
    holes : (centre, largeur_totale, hauteur_trou)."""
    segs = []
    cur = a0
    for (ac, W, hh) in sorted(holes):
        h0, h1 = ac - W / 2.0, ac + W / 2.0
        if h0 > cur + 0.01:
            segs.append((cur, h0, 0.0, H))
        segs.append((h0, h1, hh, H))
        cur = h1
    if a1 > cur + 0.01:
        segs.append((cur, a1, 0.0, H))
    for (s0, s1, z0, z1) in segs:
        if z1 - z0 < 0.01:
            continue
        bot = 'GIV_Mur' if z0 > 0.01 else None
        if axis == 'x':
            mb.block(s0, c - t / 2.0, s1, c + t / 2.0, z0, z1, side=side, band=band, bot=bot)
        else:
            mb.block(c - t / 2.0, s0, c + t / 2.0, s1, z0, z1, side=side, band=band, bot=bot)


def frame_run(mb, axis, ac, c, t, W, hc, z0=0.0, f=FRAME, d=FRAME_D, mat='GIV_Orange'):
    """Cadre orange traversant : 2 jambages + linteau, autour d'un trou de largeur W."""
    h0, h1 = ac - W / 2.0, ac + W / 2.0
    p0, p1 = c - t / 2.0 - d, c + t / 2.0 + d
    parts = [(h0, h0 + f, z0, z0 + hc), (h1 - f, h1, z0, z0 + hc), (h0, h1, z0 + hc, z0 + hc + f)]
    for (s0, s1, za, zb) in parts:
        if axis == 'x':
            mb.block(s0, p0, s1, p1, za, zb, side=mat, band=None, top=mat, bot=mat, w=0.15)
        else:
            mb.block(p0, s0, p1, s1, za, zb, side=mat, band=None, top=mat, bot=mat, w=0.15)


def ceiling_lights(mb, x0, y0, x1, y1, zc, nx, ny, pw=3.2, ph=1.1, along='x'):
    pts = []
    for i in range(nx):
        for j in range(ny):
            cx = x0 + (x1 - x0) * (i + 0.5) / nx
            cy = y0 + (y1 - y0) * (j + 0.5) / ny
            a, b = (pw, ph) if along == 'x' else (ph, pw)
            mb.prism(rect(cx - a / 2 - 0.15, cy - b / 2 - 0.15, cx + a / 2 + 0.15, cy + b / 2 + 0.15),
                     [zc - 0.1, zc], ['GIV_Sombre'], bot='GIV_Sombre')
            mb.prism(rect(cx - a / 2, cy - b / 2, cx + a / 2, cy + b / 2),
                     [zc - 0.14, zc - 0.1], ['GIV_Lampe'], bot='GIV_Lampe')
            pts.append((cx, cy))
    return pts


LIGHT_W = 700.0   # puissance des lumieres de zone des salles (W)


def area_light(coll, name, x, y, z, sx, sy, power):
    ld = bpy.data.lights.new(name, 'AREA')
    ld.shape = 'RECTANGLE'
    ld.size = sx
    ld.size_y = sy
    ld.energy = power
    ld.color = (1.0, 0.98, 0.95)
    try:
        ld.use_shadow = True
    except Exception:
        pass
    ob = bpy.data.objects.new(name, ld)
    coll.objects.link(ob)
    ob.location = (x, y, z)
    return ob


# ------------------------------------------------------------- stage: salles
def build_room(name, rc, doors):
    u0, v0, u1, v1 = rc
    t, H = WALL_T, ROOM_H
    pretty = name.capitalize()
    c = get_coll(ROOT + '_Salle_' + pretty, sub('Salles'))
    clear(c)
    x0, y0, x1, y1 = R(u0, v0, u1, v1)          # lignes d'axe des murs
    hole_h = DOOR_H + FRAME

    def holes(side):
        res = []
        for ctr in doors.get(side, []):
            a = X(ctr) if side in 'NS' else Y(ctr)
            res.append((a, DOOR_W, hole_h))
        return res

    walls, frames = MB(), MB()
    for side, yc in (('N', y1), ('S', y0)):
        wall_run(walls, 'x', x0 - t / 2, x1 + t / 2, yc, t, H, holes(side))
        for (a, W, hh) in holes(side):
            frame_run(frames, 'x', a, yc, t, W, DOOR_H)
    for side, xc in (('W', x0), ('E', x1)):
        wall_run(walls, 'y', y0 + t / 2, y1 - t / 2, xc, t, H, holes(side))
        for (a, W, hh) in holes(side):
            frame_run(frames, 'y', a, xc, t, W, DOOR_H)
    for (pu, pv) in ROOM_PILLARS.get(name, []):
        px, py = X(pu), Y(pv)
        walls.block(px - 0.55, py - 0.55, px + 0.55, py + 0.55, 0.0, H)
        walls.block(px - 0.62, py - 0.62, px + 0.62, py + 0.62, 2.6, 2.9, side='GIV_Orange', band=None,
                    top='GIV_Orange', bot='GIV_Orange', col=None)
    walls.to_object('SALLE_%s_Murs' % pretty, c)
    frames.to_object('SALLE_%s_Cadres' % pretty, c, segs=2)

    rx0, ry0, rx1, ry1 = x0 - t / 2, y0 - t / 2, x1 + t / 2, y1 + t / 2
    roof = MB()
    roof.block(rx0, ry0, rx1, ry1, H, H + ROOF_T, band=None, bot='GIV_Plafond')
    roof.cap(rx0, ry0, rx1, ry1, H + ROOF_T)
    roof.to_object('SALLE_%s_Toit' % pretty, c)

    fl = MB()
    fl.prism(rect(rx0, ry0, rx1, ry1), [0.0, FLOOR_Z], ['GIV_SolInt'], top='GIV_SolInt')
    fl.to_object('SALLE_%s_Sol' % pretty, c)

    ix0, iy0, ix1, iy1 = x0 + t / 2, y0 + t / 2, x1 - t / 2, y1 - t / 2
    lp = MB()
    ceiling_lights(lp, ix0, iy0, ix1, iy1, H, 5, 5)
    # deux conduites le long du mur nord
    for k, off in enumerate((0.9, 1.7)):
        lp.tube((ix0 + 0.5, iy1 - off, H - 0.9 - 0.35 * k), (ix1 - 0.5, iy1 - off, H - 0.9 - 0.35 * k),
                0.22, 'GIV_Tuyau')
    lp.col = []
    lp.to_object('SALLE_%s_Plafonniers' % pretty, c)
    for i in range(3):
        for j in range(3):
            cx = ix0 + (ix1 - ix0) * (i + 0.5) / 3
            cy = iy0 + (iy1 - iy0) * (j + 0.5) / 3
            area_light(c, 'LUM_%s_%d%d' % (pretty, i, j), cx, cy, H - 0.4,
                       (ix1 - ix0) / 3 * 0.8, (iy1 - iy0) / 3 * 0.8, LIGHT_W)
    return c


def stage_rooms():
    out = []
    for name, (rc, doors) in ROOMS.items():
        build_room(name, rc, doors)
        out.append(name)
    return "rooms ok: " + ", ".join(out)


def stage_traverse():
    c = get_coll(ROOT + '_Salle_Traverse', sub('Salles'))
    clear(c)
    Hc = TRAV_H
    poly_uv = [(89.9, 181.5), (224.55, 181.5), (224.55, 201.5), (201.5, 201.5), (201.5, 203.0), (89.9, 203.0)]
    poly = ccw([(X(u), Y(v)) for (u, v) in poly_uv])
    roof = MB()
    roof.prism(poly, [Hc, Hc + 0.6], ['GIV_Mur'], top='GIV_Mur', bot='GIV_Plafond', col='solid')
    capp = offset_ortho(poly, CAP_O)
    roof.prism(capp, [Hc + 0.55, Hc + 0.6 + CAP_T], ['GIV_Neige'], top='GIV_Neige', bot='GIV_Neige',
               smooth=True, w=1.0)
    # poutre au-dessus du portail nord (entre T1 et T2)
    bx0, by0, bx1, by1 = R(127.35, 177.0, 149.9, 181.5)
    roof.block(bx0, by0, bx1, by1, Hc, 6.3, band=None, bot='GIV_Plafond')
    roof.cap(bx0, by0, bx1, by1, 6.3)
    roof.to_object('TRAVERSE_Toit', c)

    fl = MB()
    fl.prism(poly, [0.0, FLOOR_Z], ['GIV_SolInt'], top='GIV_SolInt')
    fl.to_object('TRAVERSE_Sol', c)

    fr = MB()
    ph = 4.7
    frame_run(fr, 'x', X(138.625), Y(179.25), 4.5, 22.55, ph)      # portail nord (cour centrale)
    frame_run(fr, 'x', X(138.625), Y(202.3), 1.4, 22.55, ph)       # portail sud (couloir central)
    frame_run(fr, 'y', Y(192.25), X(90.6), 1.4, 21.5, ph)          # entree ouest
    frame_run(fr, 'y', Y(191.5), X(223.85), 1.4, 20.0, ph)         # entree est
    fr.to_object('TRAVERSE_Cadres', c, segs=2)

    lp = MB()
    x0, y0, x1, y1 = R(91.5, 181.5, 223.0, 201.5)
    ceiling_lights(lp, x0, y0, x1, y1, Hc, 12, 1)
    runs = {182.6: [(90.5, 126.5), (150.7, 224.0)], 200.4: [(90.5, 126.5), (150.7, 205.2), (221.3, 224.0)]}
    for vv, segs in runs.items():
        for (ua, ub) in segs:
            lp.tube((X(ua), Y(vv), Hc - 0.7), (X(ub), Y(vv), Hc - 0.7), 0.25, 'GIV_Tuyau')
    lp.col = []
    lp.to_object('TRAVERSE_Plafonniers', c)
    for i in range(5):
        cx = x0 + (x1 - x0) * (i + 0.5) / 5
        area_light(c, 'LUM_Traverse_%d' % i, cx, (y0 + y1) / 2, Hc - 0.3, 20.0, 14.0, LIGHT_W * 0.8)
    return "traverse ok"


# ------------------------------------------------------------ stage: galerie
def rail_line(mb, p0, p1, h=1.1, spacing=2.0, post=0.14, col='solid'):
    p0, p1 = Vector(p0), Vector(p1)
    L = Vector((p1.x - p0.x, p1.y - p0.y)).length
    n = max(1, int(round(L / spacing)))
    for i in range(n + 1):
        p = p0.lerp(p1, i / n)
        mb.prism(rect(p.x - post / 2, p.y - post / 2, p.x + post / 2, p.y + post / 2),
                 [p.z, p.z + h], ['GIV_Rail'], top='GIV_Rail')
    up = Vector((0, 0, 1))
    mb.beam(p0 + up * (h - 0.08), p1 + up * (h - 0.08), 0.13, 0.16, 'GIV_Rail')
    mb.beam(p0 + up * (h * 0.5), p1 + up * (h * 0.5), 0.09, 0.09, 'GIV_Rail')
    if col:
        # collider plein : panneau du sol jusqu'a la main courante
        d = p1 - p0
        hd = Vector((d.x, d.y, 0)).normalized()
        nrm = Vector((-hd.y, hd.x, 0)) * 0.1
        pts = [p0 - nrm, p0 + nrm, p1 - nrm, p1 + nrm,
               p0 - nrm + up * h, p0 + nrm + up * h, p1 - nrm + up * h, p1 + nrm + up * h]
        mb.col.append({'t': 'hull', 'role': col, 'pts': [list(q) for q in pts]})


def stage_gallery():
    c = sub('Galerie')
    clear(c)
    g = MB()
    x0, y0, x1, y1 = R(106.2, 33.2, 174.1, 56.75)
    g.prism(rect(x0, y0, x1, y1), [0.0, GAL_Z], ['GIV_Teal'], top='GIV_Neige', col='solid')
    ys = Y(56.75)
    for (ua, ub) in ((106.2, 127.35), (149.9, 174.1)):
        xa, xb = X(ua), X(ub)
        g.block(xa, ys, xb, ys + 0.5, GAL_Z, GAL_Z + 0.5, side='GIV_Teal', band=None, top='GIV_Teal')
        g.cap(xa, ys, xb, ys + 0.5, GAL_Z + 0.5, o=0.08, t=0.15, w=0.5)
    g.to_object('GALERIE_Nord', c)

    W = 56.75 - 33.2
    r = MB()
    r.wedge(106.2 - 78.75, W, GAL_Z)
    r.to_object('RAMPE_Ouest', c, loc=(X(78.75), Y((33.2 + 56.75) / 2), 0.0), rot_z=0.0)
    r = MB()
    r.wedge(201.5 - 174.1, W, GAL_Z)
    r.to_object('RAMPE_Est', c, loc=(X(201.5), Y((33.2 + 56.75) / 2), 0.0), rot_z=math.pi)
    r = MB()
    r.wedge(85.3 - 56.75, 149.9 - 127.35, GAL_Z)
    r.to_object('RAMPE_Sud', c, loc=(X((127.35 + 149.9) / 2), Y(85.3), 0.0), rot_z=math.pi / 2)

    rl = MB()
    zt = GAL_Z + 0.65
    for (ua, ub) in ((106.2, 127.35), (149.9, 174.1)):
        rl_x0, rl_x1 = X(ua) + 0.2, X(ub) - 0.2
        rail_line(rl, (rl_x0, ys + 0.25, zt), (rl_x1, ys + 0.25, zt), h=0.6, spacing=2.2)
    zr = lambda u: GAL_Z * (u - 78.75) / (106.2 - 78.75)
    rail_line(rl, (X(91.5), ys + 0.35, zr(91.5)), (X(106.2), ys + 0.35, GAL_Z), h=1.1)
    ze = lambda u: GAL_Z * (201.5 - u) / (201.5 - 174.1)
    rail_line(rl, (X(174.1), ys + 0.35, GAL_Z), (X(188.7), ys + 0.35, ze(188.7)), h=1.1)
    zs = lambda v: GAL_Z * (85.3 - v) / (85.3 - 56.75)
    for xx in (X(127.35) + 0.35, X(149.9) - 0.35):
        rail_line(rl, (xx, Y(56.75), GAL_Z), (xx, Y(72.0), zs(72.0)), h=1.1)
    rl.to_object('GALERIE_GardeCorps', c)
    return "gallery ok"


# --------------------------------------------------------- stage: couvertures
def crate(mb, x0, y0, x1, y1, h, z0=0.0, snow=True):
    mb.block(x0, y0, x1, y1, z0, z0 + h, side='GIV_Caisse', band=None, top='GIV_Caisse', w=0.25)
    if snow:
        mb.cap(x0, y0, x1, y1, z0 + h, o=0.12, t=0.22, w=0.6)


CRATE_LAYOUT = [  # fractions de l'emprise (fx0, fy0, fx1, fy1, hauteur)
    (0.00, 0.00, 0.56, 0.52, 2.4),
    (0.00, 0.68, 0.88, 1.00, 1.2),
    (0.70, 0.00, 1.00, 0.36, 1.3),
]


def crate_cluster(mb, u0, v0, u1, v1, k=0, snow=True):
    x0, y0, x1, y1 = R(u0, v0, u1, v1)
    W, D = x1 - x0, y1 - y0
    for (a0, b0, a1, b1, h) in CRATE_LAYOUT:
        if k & 1:
            a0, a1 = 1 - a1, 1 - a0
        if k & 2:
            b0, b1 = 1 - b1, 1 - b0
        crate(mb, x0 + a0 * W, y0 + b0 * D, x0 + a1 * W, y0 + b1 * D, h, snow=snow)


def slate(mb, u0, v0, u1, v1, h=2.6, inset=0.3, snow=True):
    x0, y0, x1, y1 = R(u0, v0, u1, v1)
    x0, y0, x1, y1 = x0 + inset, y0 + inset, x1 - inset, y1 - inset
    mb.block(x0, y0, x1, y1, 0.0, h, side='GIV_Ardoise', band=None, top='GIV_Ardoise', w=0.2)
    if snow:
        mb.cap(x0, y0, x1, y1, h, o=0.15, t=0.25, w=0.7)
    # grilles d'aeration sombres sur les grandes faces
    za, zb = 0.7, h - 0.6
    if (x1 - x0) >= (y1 - y0):
        for (ya, yb) in ((y0 - 0.04, y0), (y1, y1 + 0.04)):
            mb.prism(rect(x0 + 1.2, ya, x1 - 1.2, yb), [za, zb], ['GIV_Sombre'], top='GIV_Sombre', bot='GIV_Sombre')
    else:
        for (xa, xb) in ((x0 - 0.04, x0), (x1, x1 + 0.04)):
            mb.prism(rect(xa, y0 + 1.2, xb, y1 - 1.2), [za, zb], ['GIV_Sombre'], top='GIV_Sombre', bot='GIV_Sombre')


def central_block(mb, u0, v0, u1, v1):
    x0, y0, x1, y1 = R(u0, v0, u1, v1)
    ch, h = 2.6, 2.9
    mb.prism(chamfer(x0 + 0.2, y0 + 0.2, x1 - 0.2, y1 - 0.2, ch), [0.0, 0.35], ['GIV_Sombre'])
    mb.prism(chamfer(x0, y0, x1, y1, ch), [0.35, h], ['GIV_Teal'], top='GIV_Teal', bot='GIV_Teal', w=0.25)
    mb.add_col(chamfer(x0, y0, x1, y1, ch), 0.0, h, 'solid')
    mb.cap(x0, y0, x1, y1, h, o=0.2, t=0.3, w=0.8, c=ch)
    cx = (x0 + x1) / 2
    for (ya, yb) in ((y0 - 0.05, y0), (y1, y1 + 0.05)):
        mb.prism(rect(cx + 2.2, ya, cx + 3.6, yb), [1.25, 2.65], ['GIV_Orange'], top='GIV_Orange', bot='GIV_Orange')
    cy = (y0 + y1) / 2
    for (xa, xb) in ((x0 - 0.05, x0), (x1, x1 + 0.05)):
        mb.prism(rect(xa, cy - 0.7, xb, cy + 0.7), [1.25, 2.65], ['GIV_Orange'], top='GIV_Orange', bot='GIV_Orange')


def boiler(mb, u0, v0, u1, v1):
    x0, y0, x1, y1 = R(u0, v0, u1, v1)
    mb.prism(rect(x0 + 0.3, y0 + 0.3, x1 - 0.3, y1 - 0.3), [0.0, 0.5], ['GIV_Sombre'], top='GIV_Sombre', col='solid')
    bx0, by0, bx1, by1 = x0 + 0.8, y0 + 0.8, x1 - 0.8, y1 - 0.8
    mb.prism(rect(bx0, by0, bx1, by1), [0.5, 4.0], ['GIV_Orange'], w=0.15, col='solid')
    mb.loft(rect(bx0, by0, bx1, by1), 4.0, rect(bx0 + 0.7, by0 + 0.7, bx1 - 0.7, by1 - 0.7), 4.6,
            'GIV_Orange', top='GIV_Orange', w=0.15)
    mb.add_col(rect(bx0, by0, bx1, by1), 4.0, 4.6, 'solid')
    cy = (by0 + by1) / 2
    mb.block(bx0 - 0.45, cy - 1.3, bx0, cy + 1.3, 1.2, 2.8, side='GIV_Caisse', band=None, top='GIV_Caisse', w=0.2)
    mb.prism(rect(bx0 - 0.5, cy - 0.9, bx0 - 0.45, cy + 0.9), [1.6, 2.4], ['GIV_Sombre'])
    cx = (bx0 + bx1) / 2
    # conduite 1 : verticale jusqu'au plafond ; conduite 2 : coude vers le mur est
    mb.tube((cx - 1.2, by1 - 2.5, 4.4), (cx - 1.2, by1 - 2.5, ROOM_H + 0.3), 0.6, 'GIV_Tuyau')
    mb.prism(rect(cx - 2.0, by1 - 3.3, cx - 0.4, by1 - 1.7), [4.4, 4.9], ['GIV_Sombre'], top='GIV_Sombre')
    xw = X(267.0) - WALL_T / 2
    mb.tube((cx + 1.2, by0 + 3.0, 4.4), (cx + 1.2, by0 + 3.0, 6.6), 0.5, 'GIV_Tuyau')
    mb.sphere((cx + 1.2, by0 + 3.0, 6.6), 0.5, 'GIV_Tuyau')
    mb.tube((cx + 1.2, by0 + 3.0, 6.6), (xw, by0 + 3.0, 6.6), 0.5, 'GIV_Tuyau')


def machine_benches(mb, u0, v0, u1, v1):
    """Atelier : deux etablis paralleles avec tetes de machine orange."""
    x0, y0, x1, y1 = R(u0, v0, u1, v1)
    x0, x1 = x0 + 0.3, x1 - 0.3
    for k, (ya, yb) in enumerate(((y0 + 0.3, y0 + 3.6), (y1 - 3.6, y1 - 0.3))):
        mb.block(x0, ya, x1, yb, 0.0, 1.0, side='GIV_Ardoise', band=None, top='GIV_Ardoise', w=0.2)
        mb.block(x0 - 0.1, ya - 0.1, x1 + 0.1, yb + 0.1, 1.0, 1.12, side='GIV_Sombre', band=None,
                 top='GIV_Sombre', bot='GIV_Sombre', col=None)
        fx = 0.3 if k == 0 else 0.62
        mx = x0 + (x1 - x0) * fx
        mb.block(mx, ya + 0.3, mx + 3.0, yb - 0.3, 1.12, 2.7, side='GIV_Orange', band=None, top='GIV_Orange', w=0.2)
        mb.block(mx + 0.8, ya + 0.9, mx + 2.2, yb - 0.9, 2.7, 3.4, side='GIV_Sombre', band=None, top='GIV_Sombre')


def booth(mb, u0, v0, u1, v1):
    """Transit : guerite de controle."""
    x0, y0, x1, y1 = R(u0, v0, u1, v1)
    x0, y0, x1, y1 = x0 + 0.3, y0 + 0.3, x1 - 0.3, y1 - 0.3
    mb.block(x0, y0, x1, y1, 0.0, 2.9, side='GIV_Ardoise', band='GIV_Bande', top='GIV_Ardoise', band_h=0.9)
    mb.block(x0 - 0.4, y0 - 0.4, x1 + 0.4, y1 + 0.4, 2.9, 3.15, side='GIV_Teal', band=None,
             top='GIV_Teal', bot='GIV_Teal', w=0.3)
    mb.prism(rect(x0 - 0.04, y0 + 0.8, x0, y1 - 0.8), [1.3, 2.4], ['GIV_Fenetre'], top='GIV_Fenetre', bot='GIV_Fenetre')
    mb.prism(rect(x0 + 0.8, y1, x1 - 0.8, y1 + 0.04), [1.3, 2.4], ['GIV_Fenetre'], top='GIV_Fenetre', bot='GIV_Fenetre')


def rack(mb, x0, y0, x1, y1, h=4.2, seed=0):
    """Etagere de stockage (le long de X)."""
    rnd = random.Random(seed)
    n = max(2, int(round((x1 - x0) / 4.0)) + 1)
    for i in range(n):
        x = x0 + (x1 - x0) * i / (n - 1)
        for y in (y0, y1):
            mb.prism(rect(x - 0.08, y - 0.08, x + 0.08, y + 0.08), [0.0, h], ['GIV_Rail'], top='GIV_Rail')
    levels = (0.15, 1.55, 2.95)
    for z in levels:
        mb.prism(rect(x0, y0, x1, y1), [z, z + 0.08], ['GIV_Tuyau'], top='GIV_Tuyau', bot='GIV_Tuyau')
        xx = x0 + 0.3
        while xx < x1 - 1.4:
            w = rnd.uniform(0.9, 1.6)
            hh = rnd.uniform(0.7, 1.15)
            mat = rnd.choice(['GIV_Caisse', 'GIV_Caisse', 'GIV_Teal', 'GIV_Ardoise'])
            if rnd.random() < 0.8:
                mb.prism(rect(xx, y0 + 0.15, min(xx + w, x1 - 0.2), y1 - 0.15), [z + 0.08, z + 0.08 + hh],
                         [mat], top=mat)
            xx += w + rnd.uniform(0.2, 0.6)
    mb.add_col(rect(x0 - 0.1, y0 - 0.1, x1 + 0.1, y1 + 0.1), 0.0, h, 'solid')


COVERS = [
    # type, u0, v0, u1, v1, param, neige
    ('crate', 22.1, 45.2, 36.7, 54.7, 0, False),       # Stock
    ('slate', 61.25, 22.1, 70.75, 30.7, 2.6, False),    # Stock
    ('slate', 211.5, 22.1, 225.05, 30.7, 2.8, False),   # Chaufferie
    ('boiler', 247.5, 31.2, 259.1, 47.7, 0, False),     # Chaufferie
    ('benches', 23.1, 210.5, 39.7, 221.0, 0, False),    # Atelier
    ('crate', 64.2, 246.5, 72.8, 256.1, 1, False),      # Atelier
    ('booth', 251.5, 211.5, 260.1, 224.0, 0, False),    # Transit
    ('crate', 225.5, 244.5, 242.1, 255.1, 2, False),    # Transit
    ('slate', 52.95, 97.3, 62.75, 110.8, 2.6, True),    # Couloir ouest (contre le mur)
    ('slate', 65.25, 140.4, 75.05, 152.9, 2.6, True),   # Couloir ouest (contre le bloc)
    ('slate', 111.3, 108.3, 123.9, 114.9, 2.4, True),   # Cour centrale
    ('crate', 165.4, 93.3, 177.0, 103.8, 3, True),      # Cour centrale NE
    ('crate', 108.3, 157.4, 119.9, 167.9, 0, True),     # Cour centrale SO
    ('central', 132.3, 126.3, 148.9, 141.9, 0, True),   # Bloc central
    ('crate', 244.5, 116.3, 253.1, 124.9, 1, True),     # Cour livraison
    ('crate', 221.5, 127.3, 233.1, 138.9, 2, True),     # Cour livraison
    ('slate', 155.4, 194.4, 165.9, 203.3, 2.4, False),  # Traverse
]

COVER_NAMES = ['Stock_Caisses', 'Stock_Bloc', 'Chaufferie_Cuve', 'Chaufferie_Chaudiere',
               'Atelier_Etablis', 'Atelier_Caisses', 'Transit_Guerite', 'Transit_Caisses',
               'CouloirOuest_Bloc1', 'CouloirOuest_Bloc2', 'CourCentrale_Bloc', 'CourCentrale_CaissesNE',
               'CourCentrale_CaissesSO', 'CourCentrale_BlocCentral', 'CourLivraison_Caisses1',
               'CourLivraison_Caisses2', 'Traverse_Bloc']


def stage_covers():
    c = sub('Couvertures')
    clear(c)
    for (cv, nm) in zip(COVERS, COVER_NAMES):
        typ, u0, v0, u1, v1, prm, snow = cv
        mb = MB()
        if typ == 'crate':
            crate_cluster(mb, u0, v0, u1, v1, prm, snow)
        elif typ == 'slate':
            slate(mb, u0, v0, u1, v1, prm, snow=snow)
        elif typ == 'central':
            central_block(mb, u0, v0, u1, v1)
        elif typ == 'boiler':
            boiler(mb, u0, v0, u1, v1)
        elif typ == 'benches':
            machine_benches(mb, u0, v0, u1, v1)
        elif typ == 'booth':
            booth(mb, u0, v0, u1, v1)
        mb.to_object('COUV_' + nm, c)
    # etageres du Stock (contre le mur nord)
    mb = MB()
    yn = Y(15.0) - WALL_T / 2
    rack(mb, X(19.0), yn - 2.2, X(33.0), yn - 0.6, seed=1)
    rack(mb, X(37.0), yn - 2.2, X(51.0), yn - 0.6, seed=2)
    mb.to_object('COUV_Stock_Etageres', c)
    return "covers ok: %d" % len(COVERS)


# ---------------------------------------------------------------- stage: decor
FAKE_DOORS = [
    # face (orientation de la facade), plan (v pour N/S, u pour E/W), centre, z0, largeur, hauteur
    ('S', 85.3, 104.0, 0.0, 2.8, 2.9),     # P1 : mur nord de la cour centrale
    ('S', 85.3, 117.0, 0.0, 2.8, 2.9),
    ('S', 85.3, 161.0, 0.0, 2.8, 2.9),     # Q1
    ('S', 85.3, 174.0, 0.0, 2.8, 2.9),
    ('S', 33.2, 121.0, GAL_Z, 3.0, 3.4),   # N_MID au niveau de la galerie
    ('S', 33.2, 159.0, GAL_Z, 3.0, 3.4),
    ('E', 53.25, 128.0, 0.0, 3.4, 4.0),    # couloir ouest
    ('W', 259.1, 146.0, 0.0, 3.4, 4.0),    # cour livraison (mur est)
    ('S', 95.3, 212.0, 0.0, 3.4, 4.0),     # cour livraison (mur nord)
    ('N', 245.05, 108.0, 0.0, 3.4, 4.0),   # passage sud (mur sud)
    ('N', 245.05, 172.0, 0.0, 3.4, 4.0),
    ('S', 222.5, 100.0, 0.0, 3.4, 4.0),    # passage sud (mur nord)
    ('S', 222.5, 178.0, 0.0, 3.4, 4.0),
    ('W', 186.0, 160.0, 0.0, 3.4, 4.0),    # cour centrale, cote est
    ('E', 94.3, 99.0, 0.0, 3.4, 4.0),      # cour centrale, cote ouest
    ('E', 33.25, 183.0, 0.0, 3.4, 4.0),    # vestibule sud-ouest
]

WINDOWS = [
    # face, plan, centre, z centre
    ('S', 33.2, 95.0, 9.6), ('S', 33.2, 108.0, 9.6), ('S', 33.2, 140.0, 9.6),
    ('S', 33.2, 172.0, 9.6), ('S', 33.2, 186.0, 9.6),
    ('E', 53.25, 92.0, 8.2), ('E', 53.25, 106.0, 8.2), ('E', 53.25, 146.0, 8.2),
    ('W', 259.1, 108.0, 8.6), ('W', 259.1, 126.0, 8.6), ('W', 259.1, 157.0, 8.6),
    ('N', 245.05, 92.0, 8.2), ('N', 245.05, 124.0, 8.2), ('N', 245.05, 156.0, 9.4), ('N', 245.05, 188.0, 9.4),
    ('E', 94.3, 108.0, 5.0), ('W', 186.0, 92.0, 5.0), ('W', 186.0, 172.0, 5.0), ('E', 94.3, 144.0, 4.2),
    ('S', 95.3, 253.0, 8.2), ('E', 33.25, 172.0, 7.6), ('E', 33.25, 194.0, 7.6), ('S', 159.4, 43.0, 8.2),
    ('N', 164.9, 210.0, 5.0), ('N', 164.9, 253.0, 8.2), ('E', 224.55, 172.0, 5.0), ('W', 247.05, 180.0, 8.2),
    ('W', 247.05, 88.0, 8.2), ('E', 224.55, 88.0, 5.0),
]

ROOF_PROPS = [
    # type, u, v, z (sommet du chapeau de neige)
    ('chimney', 252.0, 24.0, 9.2), ('chimney', 258.0, 24.0, 9.2), ('ac', 236.0, 66.0, 9.2),
    ('ac', 150.0, 22.0, 12.4), ('vent', 100.0, 24.0, 12.4), ('pipes', 178.0, 22.0, 12.4),
    ('vent', 95.0, 68.0, 4.4), ('ac', 112.0, 72.0, 4.4), ('vent', 118.0, 62.0, 4.4),
    ('vent', 166.0, 70.0, 4.4), ('ac', 186.0, 64.0, 4.4), ('vent', 160.0, 78.0, 4.4),
    ('pipes', 264.0, 86.0, 12.4), ('ac', 40.0, 40.0, 9.2), ('vent', 60.0, 60.0, 9.2),
    ('ac', 230.0, 232.0, 9.2), ('pipes', 30.0, 250.0, 9.2), ('vent', 160.0, 212.0, 7.4),
    ('ac', 100.0, 212.0, 7.9), ('pipes', 270.0, 140.0, 13.4), ('ac', 20.0, 120.0, 12.4),
    ('pipes', 120.0, 260.0, 11.9), ('ac', 210.0, 88.0, 7.9),
]


def roof_z(u, v):
    """Altitude du dessus de la neige du toit sous le point (u, v)."""
    z = 0.0
    for (nm, u0, v0, u1, v1, h) in MASSES:
        if u0 <= u <= u1 and v0 <= v <= v1:
            z = max(z, h + CAP_T)
    for nm, ((u0, v0, u1, v1), d) in ROOMS.items():
        if u0 <= u <= u1 and v0 <= v <= v1:
            z = max(z, ROOM_H + ROOF_T + CAP_T)
    return z


def facade_rect(face, plane, ctr, w, d):
    """Renvoie (x0, y0, x1, y1) d'un element plaque sur une facade, epaisseur d vers l'exterieur."""
    if face in 'NS':
        y = Y(plane)
        s = 1.0 if face == 'N' else -1.0
        a = X(ctr)
        ya, yb = sorted((y, y + s * d))
        return a - w / 2, ya, a + w / 2, yb
    x = X(plane)
    s = 1.0 if face == 'E' else -1.0
    a = Y(ctr)
    xa, xb = sorted((x, x + s * d))
    return xa, a - w / 2, xb, a + w / 2


def fake_door(mb, face, plane, ctr, z0, w, h, f=0.5, d=0.3):
    x0, y0, x1, y1 = facade_rect(face, plane, ctr, w, 0.06)
    mb.prism(rect(x0, y0, x1, y1), [z0, z0 + h], ['GIV_PorteSombre'], top='GIV_PorteSombre')
    # lames horizontales (porte de garage)
    for k in range(1, 5):
        zz = z0 + h * k / 5.0
        a0, b0, a1, b1 = facade_rect(face, plane, ctr, w - 0.2, 0.09)
        mb.prism(rect(a0, b0, a1, b1), [zz - 0.04, zz + 0.04], ['GIV_Sombre'], top='GIV_Sombre', bot='GIV_Sombre')
    for (off, ww, za, zb) in ((-(w + f) / 2, f, z0, z0 + h), ((w + f) / 2, f, z0, z0 + h),
                              (0.0, w + 2 * f, z0 + h, z0 + h + f)):
        if face in 'NS':
            a0, b0, a1, b1 = facade_rect(face, plane, ctr + off, ww, d)
        else:
            a0, b0, a1, b1 = facade_rect(face, plane, ctr - off, ww, d)
        mb.block(a0, b0, a1, b1, za, zb, side='GIV_Orange', band=None, top='GIV_Orange',
                 bot='GIV_Orange', col=None, w=0.15)


def window(mb, face, plane, ctr, zc, w=1.9, h=1.15):
    x0, y0, x1, y1 = facade_rect(face, plane, ctr, w + 0.3, 0.05)
    mb.prism(rect(x0, y0, x1, y1), [zc - h / 2 - 0.15, zc + h / 2 + 0.15], ['GIV_Mur'], top='GIV_Mur', bot='GIV_Mur')
    x0, y0, x1, y1 = facade_rect(face, plane, ctr, w, 0.09)
    mb.prism(rect(x0, y0, x1, y1), [zc - h / 2, zc + h / 2], ['GIV_Fenetre'], top='GIV_Fenetre', bot='GIV_Fenetre')


def roof_prop(mb, typ, u, v, z):
    x, y = X(u), Y(v)
    if typ == 'ac':
        mb.block(x - 1.7, y - 1.1, x + 1.7, y + 1.1, z - 0.1, z + 1.4, side='GIV_Orange', band=None,
                 top='GIV_Orange', w=0.2, col=None)
        mb.prism(rect(x - 1.75, y - 0.7, x - 1.7, y + 0.7), [z + 0.3, z + 1.1], ['GIV_Sombre'])
        mb.cap(x - 1.7, y - 1.1, x + 1.7, y + 1.1, z + 1.4, o=0.1, t=0.2, w=0.6)
    elif typ == 'vent':
        mb.block(x - 0.9, y - 0.9, x + 0.9, y + 0.9, z - 0.1, z + 1.1, side='GIV_Ardoise', band=None,
                 top='GIV_Ardoise', w=0.2, col=None)
        mb.cap(x - 0.9, y - 0.9, x + 0.9, y + 0.9, z + 1.1, o=0.1, t=0.2, w=0.6)
    elif typ == 'chimney':
        mb.block(x - 1.3, y - 1.3, x + 1.3, y + 1.3, z - 0.1, z + 1.0, side='GIV_Orange', band=None,
                 top='GIV_Orange', w=0.2, col=None)
        mb.tube((x, y, z + 1.0), (x, y, z + 6.5), 0.65, 'GIV_Tuyau')
        mb.tube((x, y, z + 6.5), (x, y, z + 6.9), 0.8, 'GIV_Sombre')
    elif typ == 'pipes':
        mb.block(x - 1.6, y - 1.0, x + 1.6, y + 1.0, z - 0.1, z + 0.9, side='GIV_Orange', band=None,
                 top='GIV_Orange', w=0.2, col=None)
        for k, dx in enumerate((-0.8, 0.8)):
            top = z + 3.2 + 0.6 * k
            mb.tube((x + dx, y, z + 0.9), (x + dx, y, top), 0.42, 'GIV_Tuyau')
            mb.sphere((x + dx, y, top), 0.42, 'GIV_Tuyau')
            mb.tube((x + dx, y, top), (x + dx, y + 1.6, top), 0.42, 'GIV_Tuyau')
            mb.sphere((x + dx, y + 1.6, top), 0.42, 'GIV_Tuyau')
            mb.tube((x + dx, y + 1.6, top), (x + dx, y + 1.6, top - 1.0), 0.42, 'GIV_Tuyau')


def stage_decor():
    c = sub('Decor')
    clear(c)
    mb = MB()
    for (face, plane, ctr, z0, w, h) in FAKE_DOORS:
        fake_door(mb, face, plane, ctr, z0, w, h)
    mb.to_object('DECOR_Portes', c, segs=2)
    mb = MB()
    for (face, plane, ctr, zc) in WINDOWS:
        window(mb, face, plane, ctr, zc)
    mb.to_object('DECOR_Fenetres', c)
    mb = MB()
    for (typ, u, v, z) in ROOF_PROPS:
        roof_prop(mb, typ, u, v, roof_z(u, v))
    mb.col = []
    mb.to_object('DECOR_Toits', c)
    return "decor ok"


# ------------------------------------------------------------ stage: fond
def stage_background():
    c = sub('Fond')
    clear(c)
    mb = MB()
    mb.prism(rect(-4500, -4500, 4500, 4500), [-1.5, -0.12], ['GIV_Neige'], top='GIV_Neige')
    mb.to_object('FOND_Plaine', c)
    mb = MB()
    rnd = random.Random(11)
    bm = mb.bm
    mi = mb.mi('GIV_Montagne')
    for (n, rmin, rmax, hmin, hmax) in ((64, 1700, 2400, 70, 150), (52, 2700, 3500, 150, 270)):
        for i in range(n):
            ang = 2 * math.pi * i / n + rnd.uniform(-0.05, 0.05)
            r = rnd.uniform(rmin, rmax)
            cx, cy = r * math.cos(ang), r * math.sin(ang)
            h = rnd.uniform(hmin, hmax)
            base = h * rnd.uniform(1.0, 1.5)
            k = rnd.choice([5, 6, 7])
            a0 = rnd.uniform(0, 2 * math.pi)
            ring0, ring1 = [], []
            zm = h * rnd.uniform(0.4, 0.55)
            for j in range(k):
                a = a0 + 2 * math.pi * j / k
                s = rnd.uniform(0.8, 1.2)
                ring0.append(bm.verts.new((cx + base * s * math.cos(a), cy + base * s * math.sin(a), -1.0)))
                s2 = s * rnd.uniform(0.45, 0.62)
                a2 = a + rnd.uniform(-0.2, 0.2)
                ring1.append(bm.verts.new((cx + base * s2 * math.cos(a2), cy + base * s2 * math.sin(a2),
                                           zm * rnd.uniform(0.85, 1.15))))
            apex = bm.verts.new((cx + rnd.uniform(-0.12, 0.12) * base, cy + rnd.uniform(-0.12, 0.12) * base, h))
            for j in range(k):
                jj = (j + 1) % k
                f = bm.faces.new((ring0[j], ring0[jj], ring1[jj], ring1[j]))
                f.material_index = mi
                f = bm.faces.new((ring1[j], ring1[jj], apex))
                f.material_index = mi
    mb.col = []
    mb.to_object('FOND_Montagnes', c)
    return "background ok"


# ------------------------------------------------------- stage: ciel / soleil
def stage_world(sun_az=60.0, sun_el=36.0, sun_e=2.4, sky_e=1.0, light_e=1.0):
    sc = bpy.context.scene
    w = bpy.data.worlds.get('GIVRE_Ciel') or bpy.data.worlds.new('GIVRE_Ciel')
    sc.world = w
    w.use_nodes = True
    nt = w.node_tree
    nt.nodes.clear()
    tc = nt.nodes.new('ShaderNodeTexCoord')
    sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    nt.links.new(tc.outputs['Generated'], sep.inputs[0])
    # fond visible par la camera : degrade du ciel
    mr = nt.nodes.new('ShaderNodeMapRange')
    cr = nt.nodes.new('ShaderNodeValToRGB')
    nt.links.new(sep.outputs['Z'], mr.inputs['Value'])
    nt.links.new(mr.outputs['Result'], cr.inputs['Fac'])
    mr.inputs['From Min'].default_value = -0.02
    mr.inputs['From Max'].default_value = 0.8
    el = cr.color_ramp.elements
    el[0].position = 0.0
    el[0].color = hex_lin('#e3f0fe')
    el[1].position = 1.0
    el[1].color = hex_lin('#4fa7f6')
    for pos, hx in ((0.05, '#a9dcfd'), (0.16, '#80d0fd'), (0.45, '#62b6fa')):
        e = el.new(pos)
        e.color = hex_lin(hx)
    bg_sky = nt.nodes.new('ShaderNodeBackground')
    nt.links.new(cr.outputs['Color'], bg_sky.inputs['Color'])
    bg_sky.inputs['Strength'].default_value = sky_e
    # eclairage d'ambiance : ciel bleu en haut, horizon clair, rebond neutre de la neige en bas
    mr2 = nt.nodes.new('ShaderNodeMapRange')
    cr2 = nt.nodes.new('ShaderNodeValToRGB')
    nt.links.new(sep.outputs['Z'], mr2.inputs['Value'])
    nt.links.new(mr2.outputs['Result'], cr2.inputs['Fac'])
    mr2.inputs['From Min'].default_value = -1.0
    mr2.inputs['From Max'].default_value = 1.0
    el2 = cr2.color_ramp.elements
    el2[0].position = 0.0
    el2[0].color = hex_lin('#b4b6ba')
    el2[1].position = 1.0
    el2[1].color = hex_lin('#98b0d6')
    for pos, hx in ((0.5, '#d8dbe0'), (0.72, '#b0c2de')):
        e = el2.new(pos)
        e.color = hex_lin(hx)
    bg_light = nt.nodes.new('ShaderNodeBackground')
    nt.links.new(cr2.outputs['Color'], bg_light.inputs['Color'])
    bg_light.inputs['Strength'].default_value = light_e
    lp = nt.nodes.new('ShaderNodeLightPath')
    mix = nt.nodes.new('ShaderNodeMixShader')
    nt.links.new(lp.outputs['Is Camera Ray'], mix.inputs[0])
    nt.links.new(bg_light.outputs[0], mix.inputs[1])
    nt.links.new(bg_sky.outputs[0], mix.inputs[2])
    out = nt.nodes.new('ShaderNodeOutputWorld')
    nt.links.new(mix.outputs[0], out.inputs['Surface'])
    for i, n in enumerate((tc, sep, mr, cr, bg_sky, mix, out)):
        n.location = (i * 220, 150)
    for i, n in enumerate((mr2, cr2, bg_light, lp)):
        n.location = (440 + i * 220, -200)

    c = sub('Lumieres')
    for o in list(c.objects):
        if o.name.startswith('GIV_Soleil'):
            bpy.data.objects.remove(o, do_unlink=True)
    ld = bpy.data.lights.get('GIV_Soleil') or bpy.data.lights.new('GIV_Soleil', 'SUN')
    ld.energy = sun_e
    ld.angle = math.radians(2.5)
    ld.color = (1.0, 0.965, 0.91)
    sun = bpy.data.objects.new('GIV_Soleil', ld)
    c.objects.link(sun)
    az, elv = math.radians(sun_az), math.radians(sun_el)
    d = -Vector((math.cos(elv) * math.cos(az), math.cos(elv) * math.sin(az), math.sin(elv)))
    sun.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    sun.location = (0, 0, 80)

    sc.render.engine = 'BLENDER_EEVEE_NEXT'
    ee = sc.eevee
    for k, v in (('taa_render_samples', 64), ('taa_samples', 16), ('use_shadows', True),
                 ('shadow_ray_count', 2), ('shadow_step_count', 6), ('use_gtao', True),
                 ('gtao_distance', 1.5), ('use_raytracing', False)):
        try:
            setattr(ee, k, v)
        except Exception:
            pass
    sc.view_settings.view_transform = 'Standard'
    sc.view_settings.look = 'None'
    sc.view_settings.exposure = 0.0
    sc.view_settings.gamma = 1.0
    sc.render.resolution_x = 1920
    sc.render.resolution_y = 1080
    return "world ok"


# ------------------------------------------------------------ stage: cameras
CAMS = [
    # nom, u, v, z, azimut (deg, 0 = est, 90 = nord), inclinaison (deg)
    ('CAM_1_CourCentrale', 139.75, 163.75, 1.6, 90.0, 3.0),
    ('CAM_2_Atelier', 20.0, 257.0, 1.6, 42.0, 2.0),
    ('CAM_3_CourLivraison', 214.0, 160.0, 1.6, 82.0, 2.0),
    ('CAM_4_GalerieNord', 138.6, 52.5, GAL_Z + 1.6, 270.0, -8.0),
    ('CAM_5_Chaufferie', 236.0, 24.0, 1.6, 262.0, 1.0),
    ('CAM_Vue_Aerienne', 140.0, 470.0, 260.0, 90.0, -40.0),
]


def stage_cameras():
    c = sub('Cameras')
    clear(c)
    for (name, u, v, z, az, pitch) in CAMS:
        cd = bpy.data.cameras.new(name)
        cd.lens = 18.0 if not name.endswith('Aerienne') else 28.0
        cd.sensor_width = 36.0
        cd.clip_start = 0.1
        cd.clip_end = 6000.0
        ob = bpy.data.objects.new(name, cd)
        c.objects.link(ob)
        ob.location = (X(u), Y(v), z)
        ob.rotation_euler = (math.radians(90.0 + pitch), 0.0, math.radians(az - 90.0))
    bpy.context.scene.camera = bpy.data.objects['CAM_1_CourCentrale']
    return "cameras ok"


# ------------------------------------------------------------- stage: spawns
SPAWNS = [  # u, v (centre de capsule a 0.93 m), salle
    (25.0, 25.0, 'STOCK'), (24.0, 70.0, 'STOCK'),
    (255.0, 70.0, 'CHAUFFERIE'), (238.0, 22.0, 'CHAUFFERIE'),
    (20.0, 230.0, 'ATELIER'), (25.0, 257.0, 'ATELIER'),
    (256.0, 257.0, 'TRANSIT'), (255.0, 236.0, 'TRANSIT'),
]


def stage_spawns():
    c = sub('Spawns')
    clear(c)
    for i, (u, v, room) in enumerate(SPAWNS):
        (u0, v0, u1, v1), _ = ROOMS[room]
        cx, cy = X((u0 + u1) / 2), Y((v0 + v1) / 2)
        x, y = X(u), Y(v)
        az = math.atan2(cy - y, cx - x)
        ob = bpy.data.objects.new('SPAWN_%02d' % (i + 1), None)
        ob.empty_display_type = 'ARROWS'
        ob.empty_display_size = 1.5
        c.objects.link(ob)
        ob.location = (x, y, 0.93)
        ob.rotation_euler = (0.0, 0.0, az - math.pi / 2)
        ob['spawn_id'] = i + 1
        ob['salle'] = room
        ob['capsule_center_height'] = 0.93
        ob['forward'] = '+Y local (=> -Z en three.js)'
    return "spawns ok"


# ----------------------------------------------------------- stage: colliders
def stage_colliders():
    c = sub('Colliders')
    clear(c)
    n_box = n_hull = 0
    for ob in list(bpy.data.objects):
        if 'givre_col' not in ob.keys() or ob.name.startswith(('COL_', 'CLIP_')):
            continue
        try:
            items = json.loads(ob['givre_col'])
        except Exception:
            continue
        for i, it in enumerate(items):
            role = it.get('role', 'solid')
            pref = 'CLIP_' if role == 'clip' else 'COL_'
            name = '%s%s_%02d' % (pref, ob.name, i)
            bm = bmesh.new()
            if it['t'] == 'box':
                mn, mx = Vector(it['min']), Vector(it['max'])
                ctr = (mn + mx) / 2
                size = mx - mn
                bmesh.ops.create_cube(bm, size=1.0, matrix=Matrix.Diagonal((size.x, size.y, size.z, 1.0)))
                n_box += 1
            else:
                pts = [Vector(p) for p in it['pts']]
                ctr = sum(pts, Vector()) / len(pts)
                for p in pts:
                    bm.verts.new(p - ctr)
                bmesh.ops.convex_hull(bm, input=bm.verts[:])
                n_hull += 1
            me = bpy.data.meshes.new(name)
            bm.to_mesh(me)
            bm.free()
            me.materials.append(M('GIV_Clip' if role == 'clip' else 'GIV_Collider'))
            co = bpy.data.objects.new(name, me)
            c.objects.link(co)
            co.location = ctr
            co['collider'] = 'box' if it['t'] == 'box' else 'convex'
            co['role'] = role
            co['source'] = ob.name
            co.display_type = 'WIRE'
            co.hide_render = True
    # blocages joueurs au-dessus des toits bas P1 / Q1 (la vue reste degagee pour le tir)
    for nm in ('P1', 'Q1'):
        u0, v0, u1, v1, h = [m for m in MASSES if m[0] == nm][0][1:]
        x0, y0, x1, y1 = R(u0, v0, u1, v1)
        bm = bmesh.new()
        hz = 12.0
        bmesh.ops.create_cube(bm, size=1.0, matrix=Matrix.Diagonal((x1 - x0, y1 - y0, hz, 1.0)))
        me = bpy.data.meshes.new('CLIP_Toit_' + nm)
        bm.to_mesh(me)
        bm.free()
        me.materials.append(M('GIV_Clip'))
        co = bpy.data.objects.new('CLIP_Toit_' + nm, me)
        c.objects.link(co)
        co.location = ((x0 + x1) / 2, (y0 + y1) / 2, h + hz / 2)
        co['collider'] = 'box'
        co['role'] = 'clip'
        co['note'] = 'bloque les joueurs uniquement (pas les tirs)'
        co.display_type = 'WIRE'
        co.hide_render = True
    lc = bpy.context.view_layer.layer_collection.children[ROOT].children[ROOT + '_Colliders']
    lc.hide_viewport = True
    return "colliders ok: %d box, %d convex" % (n_box, n_hull)


# ------------------------------------------------------------- vue / captures
def view_cam(cam_name, shading='RENDERED', overlays=False):
    sc = bpy.context.scene
    cam = bpy.data.objects[cam_name]
    sc.camera = cam
    for area in bpy.context.screen.areas:
        if area.type != 'VIEW_3D':
            continue
        sp = area.spaces.active
        sp.shading.type = shading
        sp.clip_start = 0.1
        sp.clip_end = 6000.0
        sp.overlay.show_overlays = overlays
        sp.region_3d.view_perspective = 'CAMERA'
        region = [r for r in area.regions if r.type == 'WINDOW'][0]
        with bpy.context.temp_override(area=area, region=region):
            bpy.ops.view3d.view_center_camera()
    return "view " + cam_name


def view_top(shading='SOLID', dist=330.0):
    from mathutils import Quaternion
    for area in bpy.context.screen.areas:
        if area.type != 'VIEW_3D':
            continue
        sp = area.spaces.active
        sp.shading.type = shading
        sp.clip_start = 0.5
        sp.clip_end = 6000.0
        r3d = sp.region_3d
        r3d.view_perspective = 'ORTHO'
        r3d.view_rotation = Quaternion((1, 0, 0, 0))
        r3d.view_location = (0, 0, 0)
        r3d.view_distance = dist
    return "top view"


# ---------------------------------------------- vue forcee (fenetre non redessinee)
def _set_view(eye, q, lens, shading):
    for area in bpy.context.screen.areas:
        if area.type != 'VIEW_3D':
            continue
        sp = area.spaces.active
        sp.shading.type = shading
        sp.overlay.show_overlays = False
        sp.lens = lens
        sp.clip_start = 0.1
        sp.clip_end = 6000.0
        r3d = sp.region_3d
        r3d.view_perspective = 'PERSP'
        d = 10.0
        fwd = q @ Vector((0, 0, -1))
        r3d.view_rotation = q
        r3d.view_distance = d
        r3d.view_location = Vector(eye) + fwd * d
        r3d.update()
        area.tag_redraw()
    return "view set"


def look_at(eye, target, lens=36.0, shading='RENDERED'):
    q = (Vector(target) - Vector(eye)).to_track_quat('-Z', 'Y')
    return _set_view(eye, q, lens, shading)


def look_cam(cam_name, shading='RENDERED'):
    bpy.context.view_layer.update()
    cam = bpy.data.objects[cam_name]
    lens = cam.data.lens * 72.0 / cam.data.sensor_width
    return _set_view(cam.matrix_world.translation, cam.matrix_world.to_quaternion(), lens, shading)
