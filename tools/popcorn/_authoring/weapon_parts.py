"""Popcorn Shotgun — procedural low-poly model (weapon-local units, forward -X, up +Y, +Z = gun's left side).

Proportions are traced from the reference render (1500x1050 px side view):
1 unit = 242.6 px, origin at px (830, 578) = barrel axis above the receiver's red band.
The whole weapon is ~5.4 units long; the root node keeps a 0.19 scale like the HexSniper
(5.4 * 0.19 = 1.03 "weapon metres"; the FP/TP mounts add the ~0.4 / ~0.35 factors).
"""
import numpy as np
from geom import MeshBuilder, prism_x, extrude_z, box, srgb_to_linear, icosahedron, ngon

PXU = 242.6
OX, OY = 830.0, 578.0


def X(px):
    return (px - OX) / PXU


def Y(py):
    return -(py - OY) / PXU


def P(px, py):
    return (X(px), Y(py))


def bx(pxa, pxb, pya, pyb, z0, z1, bevel=0.0):
    """Axis-aligned box from pixel extents (any order) and z range."""
    xa, xb = sorted([X(pxa), X(pxb)])
    ya, yb = sorted([Y(pya), Y(pyb)])
    return box(xa, xb, ya, yb, min(z0, z1), max(z0, z1), bevel=bevel)


# ---- palette (sRGB picked on the reference, converted to linear for glTF) ----
RED = srgb_to_linear((206, 86, 72))
RED_DARK = srgb_to_linear((176, 66, 56))
CREAM = srgb_to_linear((222, 212, 196))
CREAM_DARK = srgb_to_linear((200, 190, 172))
SLATE = srgb_to_linear((80, 90, 110))
SLATE_DARK = srgb_to_linear((52, 58, 72))
GOLD = srgb_to_linear((228, 172, 68))
GLASS = srgb_to_linear((150, 162, 168))
POPCORN = srgb_to_linear((244, 236, 218))
POPCORN_TINT = srgb_to_linear((236, 214, 170))
KERNEL = srgb_to_linear((236, 168, 38))
KERNEL_TIP = srgb_to_linear((248, 236, 205))

# ---- key dimensions (units) ----
BARREL_R = 0.31
PUMP_CY = -0.585                             # v2: chunkier pump tucked right under the barrel
PUMP_R = 0.28
PUMP_X0, PUMP_X1 = X(625), X(290)          # rear / front (rear is +X) — v2: shorter, where the Potato's left hand rests
PUMP_CENTER_X = 0.5 * (PUMP_X0 + PUMP_X1)
PUMP_TRAVEL = 0.34                          # slide back toward the receiver (+X)
TANK_Z_OUT = 0.56
# popcorn physics box (Tank node local, node sits at its centre)
TANK_FLOOR_PY, TANK_CEIL_PY = 382, 163
TANK_INNER_Z = 0.47


def tank_inner_box():
    x0, x1 = sorted([X(646), X(1024)])
    y0, y1 = Y(TANK_FLOOR_PY), Y(TANK_CEIL_PY)
    c = np.array([(x0 + x1) / 2, (y0 + y1) / 2, 0.0])
    half = np.array([(x1 - x0) / 2, (y1 - y0) / 2, TANK_INNER_Z])
    return c, half


LID_HINGE = np.array([0.0, Y(146), -0.60])   # x filled in build (hinge runs along X on the gun's right side)


def build():
    """Return dict of part-name -> MeshBuilder (in weapon-local units, part-local frames noted)."""
    parts = {}
    body = MeshBuilder("Body")

    # ---------------- barrel ----------------
    # muzzle ring (red) with front chamfer
    body.add_convex(prism_x([(X(122), 0.34), (X(132), 0.39), (X(186), 0.39), (X(190), 0.35)]), RED)
    # bore (dark octagon slightly proud of the muzzle face)
    body.add_convex(prism_x([(X(119), 0.20), (X(124), 0.22)]), SLATE_DARK)
    # front flare
    body.add_convex(prism_x([(X(186), 0.35), (X(226), 0.35), (X(248), BARREL_R)]), SLATE)
    # main tube
    body.add_convex(prism_x([(X(246), BARREL_R), (X(566), BARREL_R)]), SLATE)
    # rear collar into the receiver
    body.add_convex(prism_x([(X(562), BARREL_R), (X(588), 0.36), (X(622), 0.36)]), SLATE)

    # ---------------- magazine rod + front cap ----------------
    body.add_convex(prism_x([(X(232), 0.10), (X(712), 0.10)], cy=PUMP_CY), SLATE_DARK)
    body.add_convex(prism_x([(X(184), 0.12), (X(190), 0.15), (X(232), 0.15), (X(236), 0.13)], cy=PUMP_CY), SLATE)

    # ---------------- receiver (cream) ----------------
    rec = [P(615, 483), P(1015, 483), P(1045, 513), P(1045, 665), P(615, 665)]
    body.add_convex(extrude_z(rec, 0.36, bevel=0.035), CREAM)
    low = [P(712, 660), P(835, 660), P(835, 772), P(732, 772), P(712, 748)]
    body.add_convex(extrude_z(low, 0.31, bevel=0.03), CREAM)
    # red band (raised)
    band = [P(840, 474), P(896, 474), P(896, 669), P(840, 669)]
    body.add_convex(extrude_z(band, 0.395, bevel=0.03), RED)
    # gold plate both sides
    for s in (1, -1):
        plate = [P(924, 545), P(1012, 545), P(1012, 581), P(924, 581)]
        pts = extrude_z(plate, 0.03, bevel=0.012, z0=s * 0.375)
        body.add_convex(pts, GOLD)

    # ---------------- tank neck (red funnel) ----------------
    neck = []
    for (x0, x1, y, zh) in [(X(700), X(940), Y(486), 0.34), (X(716), X(924), Y(438), 0.29)]:
        for x in (x0, x1):
            for z in (-zh, zh):
                neck.append((x, y, z))
    body.add_convex(np.array(neck), RED)

    parts["Body"] = body

    # ---------------- trigger guard / grip / stock ----------------
    lower = MeshBuilder("Lower")
    lower.add_convex(extrude_z([P(835, 662), P(862, 662), P(862, 738), P(850, 758), P(835, 750)], 0.12, bevel=0.025), SLATE)
    lower.add_convex(extrude_z([P(840, 734), P(1000, 734), P(1004, 760), P(850, 760)], 0.12, bevel=0.025), SLATE)
    grip = [P(988, 660), P(1046, 660), P(1113, 896), P(1100, 918), P(1036, 918), P(1022, 904)]
    lower.add_convex(extrude_z(grip, 0.17, bevel=0.04), SLATE)
    for s in (1, -1):
        ins = [P(1030, 742), P(1050, 738), P(1086, 878), P(1066, 886)]
        lower.add_convex(extrude_z(ins, 0.025, bevel=0.01, z0=s * 0.17), RED)
    # stock connector
    lower.add_convex(extrude_z([P(1040, 528), P(1124, 546), P(1124, 652), P(1040, 614)], 0.19, bevel=0.03), SLATE)
    # stock: red front band / cream body / red butt
    lower.add_convex(extrude_z([P(1115, 548), P(1162, 548), P(1240, 742), P(1195, 719)], 0.235, bevel=0.035), RED)
    lower.add_convex(extrude_z([P(1160, 548), P(1406, 551), P(1406, 830), P(1238, 741)], 0.225, bevel=0.035), CREAM)
    lower.add_convex(extrude_z([P(1404, 550), P(1436, 552), P(1426, 836), P(1404, 830)], 0.24, bevel=0.035), RED)
    parts["Body"].extend(lower)

    # ---------------- tank frame (static) ----------------
    tank = MeshBuilder("TankFrame")
    # bottom band (cream) with 3 raised red stripes
    tank.add_convex(bx(622, 1040, 394, 442, -0.55, 0.55, 0.03), CREAM)
    for (a, b) in [(755, 806), (875, 918), (995, 1041)]:
        tank.add_convex(bx(a, b, 391, 446, -0.575, 0.575, 0.02), RED)
    # floor slab (inside, under the popcorn)
    tank.add_convex(bx(626, 1036, 382, 394, -0.54, 0.54), CREAM_DARK)
    # lower sill (window frame bottom, all around)
    tank.add_convex(bx(630, 1034, 368, 395, -0.565, 0.565, 0.02), CREAM)
    # top sill: cream ring around the lid opening (kernels drop through it)
    for (a, b, z0, z1) in [(628, 650, -0.565, 0.565), (1014, 1036, -0.565, 0.565),
                           (650, 1014, 0.44, 0.565), (650, 1014, -0.565, -0.44)]:
        tank.add_convex(bx(a, b, 144, 163, z0, z1, 0.015), CREAM)
    # 4 red corner posts
    for (a, b) in [(610, 644), (1024, 1057)]:
        for zs in (1, -1):
            z0, z1 = sorted([zs * 0.46, zs * 0.585])
            tank.add_convex(bx(a, b, 140, 398, z0, z1, 0.02), RED)
    parts["TankFrame"] = tank

    # glass: 4 thin panels (double sided, transparent)
    glass = MeshBuilder("TankGlass")
    gy0, gy1 = Y(370), Y(162)
    gx0, gx1 = X(642), X(1026)
    gz = 0.505
    for zs in (1, -1):
        glass.add_convex(box(gx0, gx1, gy0, gy1, zs * gz - 0.008, zs * gz + 0.008), GLASS)
    for xv in (gx0, gx1):
        glass.add_convex(box(xv - 0.008, xv + 0.008, gy0, gy1, -gz, gz), GLASS)
    parts["TankGlass"] = glass

    # lid (red, chamfered top) — hinged on its FRONT edge (toward the muzzle): the rear edge flips
    # up and forward, so the open lid stands in front of the tank, away from the FP camera
    lid = MeshBuilder("TankLid")
    lp = []
    for (x0, x1, y, zh) in [(X(600), X(1066), Y(146), 0.62), (X(600), X(1066), Y(122), 0.62),
                            (X(624), X(1042), Y(92), 0.50)]:
        for x in (x0, x1):
            for z in (-zh, zh):
                lp.append((x, y, z))
    lid.add_convex(np.array(lp), RED)
    # small cream pull-lip on the rear edge (the left hand flips the lid from here)
    lid.add_convex(bx(1050, 1088, 120, 140, -0.28, 0.28, 0.008), CREAM)
    parts["TankLid"] = lid

    # ---------------- pump (red, 5 ribs) ----------------
    pump = MeshBuilder("Pump")
    pump.add_convex(prism_x([(X(625), 0.24), (X(614), PUMP_R), (X(301), PUMP_R), (X(290), 0.24)], cy=PUMP_CY), RED)
    for px in (340, 400, 460, 520, 578):
        pump.add_convex(prism_x([(X(px + 7), PUMP_R), (X(px + 4), PUMP_R + 0.025), (X(px - 4), PUMP_R + 0.025), (X(px - 7), PUMP_R)], cy=PUMP_CY), RED_DARK)
    parts["Pump"] = pump

    # ---------------- trigger (gold) ----------------
    trig = MeshBuilder("Trigger")
    segs = [[P(956, 668), P(968, 668), P(974, 700), P(962, 702)],
            [P(962, 700), P(974, 698), P(974, 724), P(962, 726)],
            [P(962, 724), P(974, 722), P(966, 746), P(954, 742)]]
    for s in segs:
        trig.add_convex(extrude_z(s, 0.05, bevel=0.012), GOLD)
    parts["Trigger"] = trig
    return parts


def popcorn_piece(seed=7, radius=0.13):
    """One low-poly popcorn 'flake': 4 merged, jittered icosahedra (flat shaded)."""
    rng = np.random.default_rng(seed)
    mb = MeshBuilder("Popcorn")
    v, f = icosahedron()
    centers = [np.zeros(3)] + [rng.normal(size=3) for _ in range(4)]
    for i, c in enumerate(centers):
        if i > 0:
            c = c / np.linalg.norm(c) * radius * 0.55
        r = radius * (0.72 if i == 0 else rng.uniform(0.48, 0.62))
        jitter = 1 + rng.uniform(-0.18, 0.18, size=(len(v), 1))
        pts = v * r * jitter + c
        cols = np.array([POPCORN if rng.random() > 0.25 else POPCORN_TINT for _ in range(len(f))])
        mb.add_tris(pts, [tuple(x) for x in f], cols)
    return mb


def kernel_piece(length=0.105, width=0.07):
    """Corn kernel: squashed teardrop (flat shaded), golden with a pale tip."""
    mb = MeshBuilder("Kernel")
    ring = ngon(1.0, 6, phase=0)
    top = np.array([0, length * 0.55, 0])
    bot = np.array([0, -length * 0.45, 0])
    r1 = [(u * width * 0.5, length * 0.18, v * width * 0.32) for u, v in ring]
    r2 = [(u * width * 0.34, -length * 0.22, v * width * 0.24) for u, v in ring]
    P_ = [top, bot] + r1 + r2
    tris = []
    cols = []
    n = 6
    for i in range(n):
        a, b = 2 + i, 2 + (i + 1) % n
        c, d = 2 + n + i, 2 + n + (i + 1) % n
        tris.append((0, b, a)); cols.append(KERNEL)
        tris.append((a, b, d)); cols.append(KERNEL)
        tris.append((a, d, c)); cols.append(KERNEL)
        tris.append((c, d, 1)); cols.append(KERNEL_TIP)
    mb.add_tris(np.array(P_), tris, np.array(cols))
    return mb
