"""Low-poly flat-shaded geometry helpers (convex hull based)."""
import numpy as np
from scipy.spatial import ConvexHull


def srgb_to_linear(c):
    c = np.asarray(c, float) / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


class MeshBuilder:
    """Accumulates flat-shaded triangles (non-indexed-per-face vertices) with vertex colors."""

    def __init__(self, name):
        self.name = name
        self.pos = []
        self.nrm = []
        self.col = []

    def add_tris(self, P, tris, color, normals=None):
        P = np.asarray(P, float)
        color = np.asarray(color, float)
        for k, (a, b, c) in enumerate(tris):
            pa, pb, pc = P[a], P[b], P[c]
            n = np.cross(pb - pa, pc - pa)
            ln = np.linalg.norm(n)
            if ln < 1e-12:
                continue
            n = n / ln
            col = color if color.ndim == 1 else color[k]
            self.pos += [pa, pb, pc]
            self.nrm += [n, n, n]
            self.col += [col, col, col]

    def add_convex(self, points, color, center=None):
        P = np.asarray(points, float)
        hull = ConvexHull(P)
        ctr = P[hull.vertices].mean(axis=0) if center is None else center
        tris = []
        for s, eq in zip(hull.simplices, hull.equations):
            a, b, c = s
            n = np.cross(P[b] - P[a], P[c] - P[a])
            if np.dot(n, eq[:3]) < 0:
                b, c = c, b
            tris.append((a, b, c))
        self.add_tris(P, tris, color)

    def transform(self, M):
        """Apply 4x4 transform to what has been added so far."""
        P = np.array(self.pos); N = np.array(self.nrm)
        P = (M[:3, :3] @ P.T).T + M[:3, 3]
        Ninv = np.linalg.inv(M[:3, :3]).T
        N = (Ninv @ N.T).T
        N /= np.linalg.norm(N, axis=1, keepdims=True)
        self.pos = list(P); self.nrm = list(N)

    def extend(self, other):
        self.pos += other.pos; self.nrm += other.nrm; self.col += other.col

    def arrays(self):
        return (np.array(self.pos, np.float32).reshape(-1, 3), np.array(self.nrm, np.float32).reshape(-1, 3),
                np.array(self.col, np.float32).reshape(-1, 3))

    @property
    def tri_count(self):
        return len(self.pos) // 3


# ---------------- primitive point generators ----------------

def ngon(r, n=8, phase=None):
    if phase is None:
        phase = np.pi / n  # flat top/bottom for octagon
    a = phase + np.arange(n) * 2 * np.pi / n
    return np.stack([np.cos(a) * r, np.sin(a) * r], axis=1)


def prism_x(sections, n=8, cy=0.0, cz=0.0, ry_scale=1.0, rz_scale=1.0):
    """Convex solid along X from list of (x, r) sections (radius profile must be convex)."""
    pts = []
    for x, r in sections:
        for (u, v) in ngon(r, n):
            pts.append((x, cy + u * ry_scale, cz + v * rz_scale))
    return np.array(pts)


def extrude_z(poly, zhalf, bevel=0.0, z0=0.0):
    """Convex 2D polygon (x,y) extruded along Z with a chamfer 'bevel' on the cap edges."""
    poly = np.asarray(poly, float)
    pts = []
    if bevel > 0:
        inner = shrink_polygon(poly, bevel)
        for (x, y) in poly:
            pts.append((x, y, z0 + zhalf - bevel)); pts.append((x, y, z0 - zhalf + bevel))
        for (x, y) in inner:
            pts.append((x, y, z0 + zhalf)); pts.append((x, y, z0 - zhalf))
    else:
        for (x, y) in poly:
            pts.append((x, y, z0 + zhalf)); pts.append((x, y, z0 - zhalf))
    return np.array(pts)


def shrink_polygon(poly, d):
    """Offset convex polygon inward by d (for chamfers)."""
    poly = np.asarray(poly, float)
    n = len(poly)
    # ensure CCW
    area = 0.5 * np.sum(poly[:, 0] * np.roll(poly[:, 1], -1) - np.roll(poly[:, 0], -1) * poly[:, 1])
    if area < 0:
        poly = poly[::-1]
    lines = []
    for i in range(n):
        p, q = poly[i], poly[(i + 1) % n]
        e = q - p; e /= np.linalg.norm(e)
        nrm = np.array([-e[1], e[0]])  # inward for CCW
        lines.append((p + nrm * d, e))
    out = []
    for i in range(n):
        (p1, e1), (p2, e2) = lines[i - 1], lines[i]
        A = np.array([e1, -e2]).T
        try:
            t = np.linalg.solve(A, p2 - p1)
            out.append(p1 + e1 * t[0])
        except np.linalg.LinAlgError:
            out.append(p2)
    return np.array(out)


def box(xmin, xmax, ymin, ymax, zmin, zmax, bevel=0.0):
    poly = [(xmin, ymin), (xmax, ymin), (xmax, ymax), (xmin, ymax)]
    if bevel > 0:
        # bevel all 12 edges: convex hull of 3 insets per corner
        pts = []
        for x in (xmin, xmax):
            for y in (ymin, ymax):
                for z in (zmin, zmax):
                    sx = 1 if x == xmin else -1; sy = 1 if y == ymin else -1; sz = 1 if z == zmin else -1
                    pts.append((x + sx * bevel, y + sy * bevel, z))
                    pts.append((x + sx * bevel, y, z + sz * bevel))
                    pts.append((x, y + sy * bevel, z + sz * bevel))
        return np.array(pts)
    return extrude_z(poly, (zmax - zmin) / 2, 0.0, (zmax + zmin) / 2)


def icosahedron():
    t = (1 + 5 ** 0.5) / 2
    v = np.array([(-1, t, 0), (1, t, 0), (-1, -t, 0), (1, -t, 0), (0, -1, t), (0, 1, t), (0, -1, -t), (0, 1, -t),
                  (t, 0, -1), (t, 0, 1), (-t, 0, -1), (-t, 0, 1)], float)
    v /= np.linalg.norm(v, axis=1, keepdims=True)
    f = [(0, 11, 5), (0, 5, 1), (0, 1, 7), (0, 7, 10), (0, 10, 11), (1, 5, 9), (5, 11, 4), (11, 10, 2), (10, 7, 6),
         (7, 1, 8), (3, 9, 4), (3, 4, 2), (3, 2, 6), (3, 6, 8), (3, 8, 9), (4, 9, 5), (2, 4, 11), (6, 2, 10), (8, 6, 7),
         (9, 8, 1)]
    return v, np.array(f)
