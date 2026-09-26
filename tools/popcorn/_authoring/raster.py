"""Tiny numpy z-buffer rasterizer for preview renders (flat lambert)."""
import numpy as np
from PIL import Image, ImageDraw


def perspective(fov_deg, aspect, near, far):
    f = 1.0 / np.tan(np.radians(fov_deg) / 2)
    m = np.zeros((4, 4))
    m[0, 0] = f / aspect
    m[1, 1] = f
    m[2, 2] = (far + near) / (near - far)
    m[2, 3] = 2 * far * near / (near - far)
    m[3, 2] = -1
    return m


def look_at(eye, target, up=(0, 1, 0)):
    eye = np.asarray(eye, float); target = np.asarray(target, float)
    z = eye - target; z /= np.linalg.norm(z)
    x = np.cross(up, z); x /= np.linalg.norm(x)
    y = np.cross(z, x)
    m = np.eye(4)
    m[:3, 0] = x; m[:3, 1] = y; m[:3, 2] = z; m[:3, 3] = eye
    return m  # camera world matrix


class Renderer:
    def __init__(self, w, h, fov=65, near=0.01, far=100, bg=(58, 58, 58), ortho=None):
        self.w, self.h = w, h
        self.fov, self.near, self.far = fov, near, far
        self.ortho = ortho  # half-height of ortho view if set
        self.color = np.zeros((h, w, 3), float)
        self.color[:] = (np.array(bg, float) / 255.0) ** 2.2
        self.depth = np.full((h, w), np.inf)
        self.cam = np.eye(4)
        self.light_dir = np.array([0.6, 1.0, 0.4]) / np.linalg.norm([0.6, 1.0, 0.4])
        self.light_in_camera = True
        self.ambient = 0.55
        self.key = 0.65
        self.transparent = []

    def set_camera(self, cam_world):
        self.cam = np.asarray(cam_world, float)

    def draw(self, verts, faces, colors, alpha=1.0, double_sided=True):
        """verts (n,3) world; faces (m,3); colors: (3,) or (n,3) per-vertex or (m,3) per-face."""
        if alpha < 1.0:
            self.transparent.append((verts, faces, colors, alpha))
            return
        self._raster(verts, faces, colors, 1.0, write_depth=True)

    def finish(self):
        for v, f, c, a in self.transparent:
            self._raster(v, f, c, a, write_depth=False)
        self.transparent = []

    def _raster(self, verts, faces, colors, alpha, write_depth):
        verts = np.asarray(verts, float)
        faces = np.asarray(faces, np.int64)
        if len(faces) == 0: return
        view = np.linalg.inv(self.cam)
        vc = (view[:3, :3] @ verts.T).T + view[:3, 3]
        # face colors
        colors = np.asarray(colors, float)
        if colors.ndim == 1:
            fc = np.tile(colors, (len(faces), 1))
        elif len(colors) == len(verts) and len(colors) != len(faces):
            fc = colors[faces].mean(axis=1)
        else:
            fc = colors
        a = vc[faces[:, 0]]; b = vc[faces[:, 1]]; c = vc[faces[:, 2]]
        n = np.cross(b - a, c - a)
        nl = np.linalg.norm(n, axis=1, keepdims=True); nl[nl == 0] = 1
        n = n / nl
        # face towards camera for double sided lighting
        center = (a + b + c) / 3
        facing = np.sum(n * -center, axis=1) if not self.ortho else n[:, 2]
        n[facing < 0] *= -1
        L = self.light_dir if self.light_in_camera else view[:3, :3] @ self.light_dir
        lam = np.clip(n @ L, 0, 1)
        fill = np.clip(n @ np.array([-0.5, 0.2, 0.8]) / np.linalg.norm([-0.5, 0.2, 0.8]), 0, 1)
        shade = self.ambient + self.key * lam + 0.15 * fill
        fcol = np.clip(fc * shade[:, None], 0, 1)
        # project
        H, W = self.h, self.w
        if self.ortho:
            s = self.ortho
            asp = W / H
            sx = (vc[:, 0] / (s * asp) * 0.5 + 0.5) * W
            sy = (0.5 - vc[:, 1] / s * 0.5) * H
            sz = -vc[:, 2]
        else:
            f = 1.0 / np.tan(np.radians(self.fov) / 2)
            asp = W / H
            z = -vc[:, 2]
            zz = np.where(z > 1e-6, z, 1e-6)
            sx = (vc[:, 0] * f / asp / zz * 0.5 + 0.5) * W
            sy = (0.5 - vc[:, 1] * f / zz * 0.5) * H
            sz = z
        for i, (i0, i1, i2) in enumerate(faces):
            z0, z1, z2 = sz[i0], sz[i1], sz[i2]
            if min(z0, z1, z2) < self.near: continue
            x0, y0, x1, y1, x2, y2 = sx[i0], sy[i0], sx[i1], sy[i1], sx[i2], sy[i2]
            minx = max(int(np.floor(min(x0, x1, x2))), 0); maxx = min(int(np.ceil(max(x0, x1, x2))), W - 1)
            miny = max(int(np.floor(min(y0, y1, y2))), 0); maxy = min(int(np.ceil(max(y0, y1, y2))), H - 1)
            if minx > maxx or miny > maxy: continue
            den = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
            if abs(den) < 1e-9: continue
            xs = np.arange(minx, maxx + 1) + 0.5
            ys = np.arange(miny, maxy + 1) + 0.5
            X, Y = np.meshgrid(xs, ys)
            w0 = ((y1 - y2) * (X - x2) + (x2 - x1) * (Y - y2)) / den
            w1 = ((y2 - y0) * (X - x2) + (x0 - x2) * (Y - y2)) / den
            w2 = 1 - w0 - w1
            m = (w0 >= -1e-6) & (w1 >= -1e-6) & (w2 >= -1e-6)
            if not m.any(): continue
            if self.ortho:
                zp = w0 * z0 + w1 * z1 + w2 * z2
            else:
                zp = 1.0 / (w0 / z0 + w1 / z1 + w2 / z2)
            sub = self.depth[miny:maxy + 1, minx:maxx + 1]
            m &= zp < sub
            if not m.any(): continue
            csub = self.color[miny:maxy + 1, minx:maxx + 1]
            if alpha >= 1:
                csub[m] = fcol[i]
            else:
                csub[m] = csub[m] * (1 - alpha) + fcol[i] * alpha
            if write_depth:
                sub[m] = zp[m]

    def project(self, p):
        view = np.linalg.inv(self.cam)
        vc = view[:3, :3] @ np.asarray(p, float) + view[:3, 3]
        f = 1.0 / np.tan(np.radians(self.fov) / 2)
        asp = self.w / self.h
        if self.ortho:
            s = self.ortho
            return ((vc[0] / (s * asp) * 0.5 + 0.5) * self.w, (0.5 - vc[1] / s * 0.5) * self.h)
        z = -vc[2]
        return ((vc[0] * f / asp / z * 0.5 + 0.5) * self.w, (0.5 - vc[1] * f / z * 0.5) * self.h)

    def image(self, markers=None, label=None):
        self.finish()
        img = Image.fromarray((np.clip(self.color, 0, 1) ** (1 / 2.2) * 255).astype(np.uint8))
        d = ImageDraw.Draw(img)
        if markers:
            for p, col in markers:
                x, y = self.project(p)
                d.ellipse([x - 4, y - 4, x + 4, y + 4], outline=col, width=2)
        if label:
            try:
                from PIL import ImageFont
                font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 15)
            except Exception:
                font = None
            d.text((10, 8), label, fill=(255, 255, 255), font=font)
        return img
