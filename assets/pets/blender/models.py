"""Procedural stylised ("chibi") pets for the -Procedural build.

Bodies are metaballs (one watertight surface, so heat weights always find a
solution), parts that must stay rigid (ears, beak, wings, horns, props, feet)
are separate closed meshes bound to one bone or copying the body weights,
colours are vertex colours (attribute "Col") painted by per-pet rules.

Everything is built in design units (about 1 tall, pet faces -Y, feet near
z = 0). build.py normalises to exactly 1 tall, rigs, and scales to metres.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Callable

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector
from mathutils.bvhtree import BVHTree
from mathutils.kdtree import KDTree

V = Vector
K = 0.575  # isolated metaball surface radius / element radius (stiffness 2, threshold 0.6)
Col = tuple[float, float, float]
ColourFn = Callable[[Vector, Vector], Col]


def lin(h: str) -> Col:
    h = h.lstrip("#")
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)  # type: ignore[return-value]


def mix(a: Col, b: Col, t: float) -> Col:
    t = max(0.0, min(1.0, t))
    return tuple(x + (y - x) * t for x, y in zip(a, b))  # type: ignore[return-value]


# --------------------------------------------------------------- materials

def material(name: str, *, rough: float = 0.6, vcol: bool = True, color: Col = (1, 1, 1),
             emit: Col | None = None, strength: float = 0.0) -> bpy.types.Material:
    m = bpy.data.materials.get(name)
    if m:
        return m
    m = bpy.data.materials.new(name)
    nt = m.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = 0.0
    bsdf.inputs["Base Color"].default_value = (*color, 1)
    m.diffuse_color = (*color, 1)
    if vcol:
        a = nt.nodes.new("ShaderNodeVertexColor")
        a.layer_name = "Col"
        nt.links.new(a.outputs["Color"], bsdf.inputs["Base Color"])
    if emit:
        bsdf.inputs["Emission Color"].default_value = (*emit, 1)
        bsdf.inputs["Emission Strength"].default_value = strength
    return m


def mats() -> dict[str, bpy.types.Material]:
    return {
        "fur": material("fur", rough=0.62),
        "gloss": material("gloss", rough=0.25),
        "shell": material("shell", rough=0.16),
        "eye": material("eye", rough=0.06),
        "glow": material("glow", vcol=False, color=(1, 1, 1), emit=(1, 1, 1), strength=2.5),
        "cyan": material("cyan", vcol=False, color=(0.25, 0.9, 1.0), emit=(0.2, 0.85, 1.0), strength=5.0),
        "mouth": material("mouth", rough=0.5),
    }


# ------------------------------------------------------------- mesh utils

def link(obj: bpy.types.Object) -> bpy.types.Object:
    bpy.context.scene.collection.objects.link(obj)
    return obj


def paint(obj: bpy.types.Object, cols) -> None:
    me = obj.data
    attr = me.color_attributes.get("Col") or me.color_attributes.new("Col", "FLOAT_COLOR", "POINT")
    me.color_attributes.active_color = attr
    me.color_attributes.render_color_index = me.color_attributes.find("Col")
    for v in me.vertices:
        c = cols[v.index] if isinstance(cols, list) else cols
        if callable(c):
            c = c(v.co, v.normal)
        attr.data[v.index].color = (*c, 1.0)


def tri_count(obj: bpy.types.Object) -> int:
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def decimate(obj: bpy.types.Object, tris: int) -> None:
    n = tri_count(obj)
    if n <= tris:
        return
    m = obj.modifiers.new("dec", "DECIMATE")
    m.ratio = tris / n
    m.use_symmetry = True
    m.symmetry_axis = "X"
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(obj.evaluated_get(dg))
    old = obj.data
    obj.modifiers.clear()
    obj.data = me
    bpy.data.meshes.remove(old)
    for p in me.polygons:
        p.use_smooth = True


def bvh_of(obj: bpy.types.Object) -> BVHTree:
    me = obj.data
    return BVHTree.FromPolygons([v.co.copy() for v in me.vertices], [tuple(p.vertices) for p in me.polygons])


def cast(bvh: BVHTree, origin, direction) -> tuple[Vector, Vector]:
    d = V(direction).normalized()
    loc, nor, _i, _d = bvh.ray_cast(V(origin), d)
    if loc is None:
        raise RuntimeError(f"ray missed the body from {tuple(origin)}")
    if nor.dot(d) > 0:
        nor = -nor
    return loc, nor


def catmull(pts, n: int) -> list[Vector]:
    p = [V(x) for x in pts]
    p = [p[0] * 2 - p[1]] + p + [p[-1] * 2 - p[-2]]
    segs = len(pts) - 1
    out = []
    for i in range(n):
        u = i / (n - 1) * segs
        k = min(int(u), segs - 1)
        t = u - k
        p0, p1, p2, p3 = p[k], p[k + 1], p[k + 2], p[k + 3]
        out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t
                          + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3))
    return out


def interp(vals: list[float], t: float) -> float:
    u = max(0.0, min(1.0, t)) * (len(vals) - 1)
    k = min(int(u), len(vals) - 2)
    return vals[k] + (vals[k + 1] - vals[k]) * (u - k)


class Curve:
    """Dense polyline for 'how far along the tail is this vertex' queries."""

    def __init__(self, pts, n: int = 48):
        self.p = catmull(pts, n)

    def nearest(self, co: Vector) -> tuple[float, float]:
        best, bi = 1e9, 0
        for i, q in enumerate(self.p):
            d = (q - co).length_squared
            if d < best:
                best, bi = d, i
        return bi / (len(self.p) - 1), math.sqrt(best)


def frame(n: Vector) -> tuple[Vector, Vector, Vector]:
    """(side, out, up) right-handed: side x out = up; up is nearest world +Z."""
    out = n.normalized()
    up = V((0, 0, 1)) - out * out.z
    up = up.normalized() if up.length > 1e-4 else V((0, 1, 0))
    side = out.cross(up).normalized()
    return side, out, up


class Geo:
    """Accumulates closed sub-meshes with per-vertex colour and tag."""

    def __init__(self) -> None:
        self.bm = bmesh.new()
        self.lay = self.bm.verts.layers.int.new("item")
        self.cols: list = []
        self.tags: list = []

    def _take(self, new: list, col, mat: int, tag) -> list:
        item = len(self.cols)
        for v in new:
            v[self.lay] = item
            for f in v.link_faces:
                f.material_index = mat
        self.cols.append(col)
        self.tags.append(tag)
        return new

    def ellipsoid(self, c, r, col, mat: int = 0, rot: Matrix | None = None, seg: int = 16,
                  rings: int = 10, tag=None) -> None:
        verts = bmesh.ops.create_uvsphere(self.bm, u_segments=seg, v_segments=rings, radius=1.0)["verts"]
        m = Matrix.Translation(V(c)) @ (rot.to_4x4() if rot else Matrix()) @ Matrix.Diagonal((*r, 1))
        bmesh.ops.transform(self.bm, matrix=m, verts=verts)
        self._take(verts, col, mat, tag)

    def tube(self, pts, radii, col, mat: int = 0, seg: int = 10, thin=None, squash: float = 1.0,
             closed: bool = False, smooth: int = 0, tag=None) -> None:
        """Loft circles along pts (Catmull-Rom resampled when smooth > 0).
        thin: world axis the cross-section is squashed along (by squash)."""
        if smooth:
            radii = [interp(radii, i / (smooth - 1)) for i in range(smooth)]
            pts = catmull(pts, smooth)
        p = [V(x) for x in pts]
        n = len(p)
        rings = []
        prev = None
        for i in range(n):
            if closed:
                t = (p[(i + 1) % n] - p[i - 1]).normalized()
            else:
                t = (p[min(i + 1, n - 1)] - p[max(i - 1, 0)]).normalized()
            if thin is not None:
                b = V(thin) - t * V(thin).dot(t)
                b.normalize()
                a = t.cross(b).normalized()
            else:
                if prev is None:
                    ref = V((0, 0, 1)) if abs(t.z) < 0.9 else V((1, 0, 0))
                    a = t.cross(ref).normalized()
                else:
                    a = (prev - t * prev.dot(t)).normalized()
                b = t.cross(a).normalized()
            prev = a
            r = radii[i]
            if not closed and i in (0, n - 1) and r < 1e-5:
                rings.append([self.bm.verts.new(p[i])])
                continue
            rings.append([self.bm.verts.new(p[i] + a * (math.cos(2 * math.pi * k / seg) * r)
                                            + b * (math.sin(2 * math.pi * k / seg) * r * squash))
                          for k in range(seg)])
        pairs = list(zip(rings, rings[1:])) + ([(rings[-1], rings[0])] if closed else [])
        for r0, r1 in pairs:
            if len(r0) == 1:
                for k in range(seg):
                    self.bm.faces.new((r0[0], r1[k], r1[(k + 1) % seg]))
            elif len(r1) == 1:
                for k in range(seg):
                    self.bm.faces.new((r0[k], r0[(k + 1) % seg], r1[0]))
            else:
                for k in range(seg):
                    self.bm.faces.new((r0[k], r0[(k + 1) % seg], r1[(k + 1) % seg], r1[k]))
        if not closed:
            for ring in (rings[0], rings[-1]):
                if len(ring) > 1:
                    self.bm.faces.new(ring)
            self._take([v for ring in rings for v in ring], col, mat, tag)

    def slab(self, outline, thickness: float, col, mat: int = 0, tag=None) -> None:
        """Flat closed shell from a (roughly planar) outline: wing membranes."""
        before = set(self.bm.verts)
        vs = [self.bm.verts.new(V(p)) for p in outline]
        f = self.bm.faces.new(vs)
        tri = bmesh.ops.triangulate(self.bm, faces=[f])["faces"]
        bmesh.ops.solidify(self.bm, geom=tri, thickness=thickness)
        self._take([v for v in self.bm.verts if v not in before], col, mat, tag)

    def obj(self, name: str, materials: list) -> bpy.types.Object:
        bmesh.ops.recalc_face_normals(self.bm, faces=self.bm.faces[:])
        items = [v[self.lay] for v in self.bm.verts]
        self.cols = [self.cols[i] for i in items]
        self.tags = [self.tags[i] for i in items]
        me = bpy.data.meshes.new(name)
        self.bm.to_mesh(me)
        self.bm.free()
        for p in me.polygons:
            p.use_smooth = True
        for m in materials:
            me.materials.append(m)
        o = link(bpy.data.objects.new(name, me))
        paint(o, self.cols)
        return o


def metaballs(name: str, elems: list, res: float) -> bpy.types.Object:
    """('b', centre, surface_radius) | ('e', centre, (rx, ry, rz)[, euler_deg])."""
    mb = bpy.data.metaballs.new(name + "_mb")
    mb.resolution = mb.render_resolution = res
    mb.threshold = 0.6
    o = link(bpy.data.objects.new(name + "_mb", mb))
    for e in elems:
        el = mb.elements.new(type="BALL" if e[0] == "b" else "ELLIPSOID")
        el.co = V(e[1])
        el.stiffness = 2.0
        if e[0] == "b":
            el.radius = e[2] / K
        else:
            el.radius = 1.0 / K
            el.size_x, el.size_y, el.size_z = e[2]
            if len(e) > 3:
                el.rotation = Euler(tuple(math.radians(a) for a in e[3])).to_quaternion()
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(o.evaluated_get(dg))
    me.name = name
    bpy.data.objects.remove(o)
    bpy.data.metaballs.remove(mb)
    for p in me.polygons:
        p.use_smooth = True
    return link(bpy.data.objects.new(name, me))


def leg_elems(x: float, ys: tuple[float, float], top: float, r: float, foot: float) -> list:
    out = []
    for sx in (x, -x):
        for y in ys:
            for z in (top, top - 0.085, top - 0.16):
                out.append(("b", (sx, y, z), r))
            out.append(("e", (sx, y - 0.014, 0.05), (foot, foot * 1.15, foot * 0.8)))
    return out


def chain_elems(pts, radii: list[float], spacing: float = 0.03) -> list:
    dense = catmull(pts, 64)
    length = sum((b - a).length for a, b in zip(dense, dense[1:]))
    n = max(3, int(length / spacing) + 1)
    return [("b", tuple(p), interp(radii, i / (n - 1))) for i, p in enumerate(catmull(pts, n))]


# ------------------------------------------------------------- eyes/mouth

@dataclass
class EyeSpec:
    x: float
    z: float
    r: float
    iris: Col
    flat: float = 0.55
    tall: float = 1.15
    embed: float = 0.45
    fwd: float = 0.6
    pupil: Col | None = None
    glow: bool = False  # drone: emissive cyan eyes, no highlight


def build_eyes(target: bpy.types.Object, spec: EyeSpec, M: dict) -> bpy.types.Object:
    """Both eyes in one mesh 'eyes' with a 'blink' key that squashes them to a line."""
    bvh = bvh_of(target)
    g = Geo()
    for s in (1, -1):
        p, n = cast(bvh, (spec.x * s, -5, spec.z), (0, 1, 0))
        n = (n + V((0, -1, 0)) * spec.fwd).normalized()
        side, out, up = frame(n)
        rot = Matrix((side, out, up)).transposed()
        rn = spec.r * spec.flat
        c = p - out * (rn * spec.embed)
        info = (c.copy(), up.copy(), spec.r * spec.tall)
        if spec.glow:
            g.ellipsoid(c, (spec.r, rn, spec.r * spec.tall), (0.3, 0.9, 1.0), 1, rot, 16, 10, ("iris", *info))
            continue
        g.ellipsoid(c, (spec.r, rn, spec.r * spec.tall), spec.iris, 0, rot, 20, 12, ("iris", *info))
        if spec.pupil:
            pc = c + out * (rn * 0.42)
            g.ellipsoid(pc, (spec.r * 0.55, rn * 0.62, spec.r * 0.62 * spec.tall), spec.pupil, 0, rot, 16, 10,
                        ("iris", *info))
        hx = V((1, 0, 0)) - out * out.x
        hx.normalize()
        hl = c + up * (spec.r * spec.tall * 0.38) + hx * (spec.r * 0.3) + out * (rn * 0.86)
        hr = spec.r * 0.24
        g.ellipsoid(hl, (hr, hr * 0.6, hr), (1, 1, 1), 1, rot, 10, 6, ("hl", *info))
        hl2 = c - up * (spec.r * spec.tall * 0.35) - hx * (spec.r * 0.32) + out * (rn * 0.84)
        g.ellipsoid(hl2, (hr * 0.45, hr * 0.3, hr * 0.45), (1, 1, 1), 1, rot, 8, 5, ("hl", *info))
    o = g.obj("eyes", [M["eye"], M["cyan"] if spec.glow else M["glow"]])
    tags = g.tags
    o.shape_key_add(name="Basis", from_mix=False)
    k = o.shape_key_add(name="blink", from_mix=False)
    for i, v in enumerate(o.data.vertices):
        kind, c, up, rz = tags[i]
        d = v.co - c
        a = d.dot(up)
        if kind == "hl":
            k.data[i].co = c
        else:
            k.data[i].co = v.co - up * a + up * (a * 0.1 - rz * 0.3)
    return o


VISEMES = {  # (width scale, height scale) of the opening
    "rest": (1.0, 1.0), "aa": (1.1, 4.5), "ee": (1.45, 1.8), "ih": (1.2, 2.4),
    "oh": (0.75, 3.6), "ou": (0.5, 2.2), "fv": (1.1, 0.6), "mbp": (1.05, 0.25),
}


def build_mouth(at: Vector, n: Vector, width: float, M: dict, col: Col) -> bpy.types.Object:
    side, out, up = frame(n)
    rot = Matrix((side, out, up)).transposed()
    c = at - out * (width * 0.05)
    g = Geo()
    g.ellipsoid(c, (width / 2, width * 0.16, width * 0.11), col, 0, rot, 18, 10)
    o = g.obj("mouth", [M["mouth"]])
    o.shape_key_add(name="Basis", from_mix=False)
    for name, (sx, sz) in VISEMES.items():
        k = o.shape_key_add(name=f"mouth_{name}", from_mix=False)
        for i, v in enumerate(o.data.vertices):
            d = v.co - c
            k.data[i].co = c + side * (d.dot(side) * sx) + out * d.dot(out) + up * (d.dot(up) * sz - (sz - 1) * width * 0.04)
    return o


def mouth_on(body: bpy.types.Object, z: float, width: float, M: dict, col: Col) -> bpy.types.Object:
    p, n = cast(bvh_of(body), (0, -5, z), (0, 1, 0))
    n = (n + V((0, -1, 0))).normalized()
    return build_mouth(p, n, width, M, col)


# ------------------------------------------------------------------- model

Joint = tuple[tuple[float, float, float], tuple[float, float, float], str | None]


@dataclass
class Model:
    family: str
    body: bpy.types.Object
    parts: list = field(default_factory=list)  # (obj, 'rigid'|'copy', bone|None)
    joints: dict[str, Joint] = field(default_factory=dict)
    body_bones: set[str] = field(default_factory=set)
    eyes: bpy.types.Object | None = None
    mouth: bpy.types.Object | None = None


def part(geo: Geo, name: str, mlist: list, bind: str, bone: str | None) -> tuple:
    return (geo.obj(name, mlist), bind, bone)


def t3(v) -> tuple[float, float, float]:
    return (float(v[0]), float(v[1]), float(v[2]))


# --------------------------------------------------------------- quadruped

def quadruped(cfg: dict) -> Model:
    M = mats()
    hc, hr = V(cfg["head_c"]), cfg["head_r"]
    x, yf, yb, top, lr, foot = cfg["leg"]
    elems = list(cfg["elems"]) + leg_elems(x, (yf, yb), top, lr, foot)
    elems += chain_elems(cfg["tail"], cfg["tail_r"], cfg.get("tail_spacing", 0.03))
    body = metaballs(cfg["id"], elems, cfg.get("res", 0.011))
    decimate(body, cfg.get("tris", 5600))
    body.data.materials.append(M["fur"])
    paint(body, cfg["colour"])
    mdl = Model(cfg["family"], body)
    for p in cfg["parts"](M, body):
        mdl.parts.append(p)
    mdl.eyes = build_eyes(body, cfg["eye"], M)
    mz, mw = cfg["mouth"]
    mdl.mouth = mouth_on(body, mz, mw, M, lin("#3A1015"))
    mouth_c = sum((v.co for v in mdl.mouth.data.vertices), V()) / len(mdl.mouth.data.vertices)

    bz = cfg["body_z"]
    nz = cfg["neck_z"]
    hb = hc.z - hr * 0.45
    tail = catmull(cfg["tail"], 4)
    J: dict[str, Joint] = {
        "hips": ((0, yb + 0.03, bz), (0, 0.03, bz + 0.01), "root"),
        "chest": ((0, 0.03, bz + 0.01), (0, hc.y, nz), "hips"),
        "neck": ((0, hc.y, nz), (0, hc.y, hb), "chest"),
        "head": ((0, hc.y, hb), (0, hc.y, hc.z + hr * 0.95), "neck"),
        "jaw": ((0, mouth_c.y + hr * 0.45, mouth_c.z + 0.03), t3(mouth_c), "head"),
        "tail1": (t3(tail[0]), t3(tail[1]), "hips"),
        "tail2": (t3(tail[1]), t3(tail[2]), "tail1"),
        "tail3": (t3(tail[2]), t3(tail[3]), "tail2"),
    }
    knee = top * 0.5
    for side, sx in (("L", x), ("R", -x)):
        for end, y, parent in (("front", yf, "chest"), ("back", yb, "hips")):
            up = f"leg_{end}_upper.{side}"
            J[up] = ((sx, y, top), (sx, y, knee), parent)
            J[f"leg_{end}_lower.{side}"] = ((sx, y, knee), (sx, y - 0.012, 0.03), up)
    J.update(cfg.get("joints", {}))
    mdl.joints = J
    mdl.body_bones = {"hips", "chest", "neck", "head", "tail1", "tail2", "tail3"} | {
        b for b in J if b.startswith("leg_")}
    return mdl


def pointed_ears(M: dict, base, tip, r: float, outer, inner, tip_col=None, tilt: float = 0.0) -> list:
    out = []
    for side, s in (("L", 1), ("R", -1)):
        b = V((base[0] * s, base[1], base[2]))
        t = V((tip[0] * s, tip[1], tip[2]))
        mid = b.lerp(t, 0.5) + V((0, 0, 0))
        g = Geo()
        axis = (t - b).normalized()
        if tip_col:
            def col(co, n, b=b, axis=axis, L=(t - b).length):
                return tip_col if (co - b).dot(axis) > L * 0.68 else outer
        else:
            col = outer
        thin = V((s * tilt, -1, 0)).normalized()
        g.tube([b - axis * r * 0.6, b, mid, t], [r * 0.85, r, r * 0.6, 0.0], col, 0, 12, thin, 0.42)
        ib = b + V((0, -r * 0.3, 0)) + axis * r * 0.25
        it = t - axis * (t - b).length * 0.2 + V((0, -r * 0.2, 0))
        g.tube([ib, ib.lerp(it, 0.5), it], [r * 0.62, r * 0.38, 0.0], inner, 0, 10, thin, 0.3)
        out.append((g.obj(f"ear_{side}", [M["fur"]]), "rigid", f"ear.{side}"))
    return out


def ear_joints(base, tip) -> dict[str, Joint]:
    return {f"ear.{side}": ((base[0] * s, base[1], base[2]), (tip[0] * s, tip[1], tip[2]), "head")
            for side, s in (("L", 1), ("R", -1))}


def nose(M: dict, body, z: float, r, col: Col, mat: str = "gloss") -> tuple:
    p, n = cast(bvh_of(body), (0, -5, z), (0, 1, 0))
    side, out, up = frame((n + V((0, -1, 0))).normalized())
    g = Geo()
    g.ellipsoid(p + out * (r[1] * 0.2), r, col, 0, Matrix((side, out, up)).transposed(), 14, 8)
    return (g.obj("nose", [M[mat]]), "rigid", "head")


def cat() -> Model:
    O, D, W, P = lin("#F3963E"), lin("#C8601C"), lin("#FFF6EA"), lin("#F49AAA")
    hc, hr = (0, -0.2, 0.64), 0.23
    tail = [(0, 0.27, 0.36), (0, 0.38, 0.42), (0, 0.45, 0.54), (0, 0.45, 0.67), (0, 0.4, 0.75)]
    tc = Curve(tail)
    ear_b, ear_t = (0.125, -0.17, 0.81), (0.2, -0.15, 1.0)

    def colour(co: Vector, n: Vector) -> Col:
        if co.z < 0.115:
            return W
        t, d = tc.nearest(co)
        if co.y > 0.25 and d < 0.075:
            return D if (math.sin(t * 30) > 0.35 or t > 0.9) else O
        if (co - V((0, -0.39, 0.545))).length < 0.085:
            return W
        if co.y < -0.2 and 0.14 < co.z < 0.49 and abs(co.x) < 0.1:
            return W
        if co.z < 0.24 and abs(co.x) < 0.09 and -0.1 < co.y < 0.2:
            return W
        if co.z > 0.72 and co.y < -0.25 and abs(co.x) < 0.09 and math.cos(co.x * 60) > 0.55:
            return D
        if n.z > 0.2 and co.y > -0.12 and co.z > 0.3 and math.sin(co.y * 40) > 0.45:
            return D
        return O

    def parts(M, body):
        return pointed_ears(M, ear_b, ear_t, 0.088, O, P, tilt=0.35) + [
            nose(M, body, 0.59, (0.026, 0.016, 0.018), P)]

    return quadruped({
        "id": "cat", "family": "quadruped",
        "elems": [("e", (0, 0.06, 0.33), (0.16, 0.24, 0.15)), ("b", (0, -0.1, 0.37), 0.14),
                  ("b", hc, hr), ("e", (0, -0.21, 0.6), (0.255, 0.2, 0.17)),
                  ("b", (0.036, -0.385, 0.565), 0.06), ("b", (-0.036, -0.385, 0.565), 0.06)],
        "head_c": hc, "head_r": hr, "leg": (0.095, -0.12, 0.21, 0.27, 0.058, 0.064),
        "tail": tail, "tail_r": [0.05, 0.048, 0.045], "colour": colour, "parts": parts,
        "eye": EyeSpec(0.095, 0.645, 0.06, lin("#14100E")), "mouth": (0.53, 0.05),
        "body_z": 0.34, "neck_z": 0.44, "joints": ear_joints(ear_b, ear_t),
    })


def fox() -> Model:
    O, W, B, Dk = lin("#EC7428"), lin("#FFF3E2"), lin("#2A1F1B"), lin("#3B2A22")
    hc, hr = (0, -0.19, 0.63), 0.22
    tail = [(0, 0.27, 0.35), (0, 0.41, 0.36), (0, 0.53, 0.44), (0, 0.59, 0.57), (0, 0.56, 0.69)]
    tc = Curve(tail)
    ear_b, ear_t = (0.12, -0.16, 0.79), (0.21, -0.14, 1.03)

    def colour(co: Vector, n: Vector) -> Col:
        t, d = tc.nearest(co)
        if co.y > 0.25 and d < 0.13:
            return W if t > 0.8 else O
        if co.z < 0.15:
            return B
        if co.y < -0.3 and co.z < 0.585:
            return W
        if co.y < -0.22 and co.z < 0.6 and abs(co.x) > 0.1 and co.z > 0.5:
            return W
        if co.y < -0.19 and 0.15 < co.z < 0.5 and abs(co.x) < 0.09:
            return W
        return O

    def parts(M, body):
        return pointed_ears(M, ear_b, ear_t, 0.1, O, W, Dk, tilt=0.3) + [
            nose(M, body, 0.575, (0.03, 0.022, 0.024), B)]

    return quadruped({
        "id": "fox", "family": "quadruped",
        "elems": [("e", (0, 0.06, 0.33), (0.145, 0.24, 0.14)), ("b", (0, -0.09, 0.37), 0.13),
                  ("b", hc, hr), ("e", (0, -0.2, 0.6), (0.245, 0.19, 0.16)),
                  ("e", (0, -0.37, 0.555), (0.08, 0.125, 0.065))],
        "head_c": hc, "head_r": hr, "leg": (0.085, -0.12, 0.21, 0.27, 0.052, 0.058),
        "tail": tail, "tail_r": [0.06, 0.1, 0.11, 0.075], "colour": colour, "parts": parts,
        "eye": EyeSpec(0.092, 0.645, 0.056, lin("#14100E")), "mouth": (0.515, 0.045),
        "body_z": 0.34, "neck_z": 0.44, "joints": ear_joints(ear_b, ear_t),
    })


def redpanda() -> Model:
    R, Dk, W, Rg = lin("#C4512A"), lin("#3A1E16"), lin("#FFF8F0"), lin("#7C2E17")
    hc, hr = (0, -0.2, 0.64), 0.235
    tail = [(0, 0.27, 0.36), (0, 0.42, 0.38), (0, 0.55, 0.44), (0, 0.63, 0.55)]
    tc = Curve(tail)

    def colour(co: Vector, n: Vector) -> Col:
        t, d = tc.nearest(co)
        if co.y > 0.25 and d < 0.13:
            return Rg if (int(t * 7.5) % 2 == 1 or t > 0.93) else R
        if co.z < 0.25 and (abs(co.x) > 0.05 or co.z < 0.15):
            return Dk
        if n.z < -0.55 and co.z < 0.33:
            return Dk
        front = co.y < -0.3
        if front and (co - V((0, -0.4, 0.55))).length < 0.1:
            return W
        for s in (1, -1):
            if front and math.hypot(co.x - 0.088 * s, co.z - 0.735) < 0.035:
                return W
            if co.y < -0.22 and math.hypot(co.x - 0.16 * s, co.z - 0.585) < 0.065:
                return W
        return R

    def parts(M, body):
        out = []
        for side, s in (("L", 1), ("R", -1)):
            g = Geo()
            rot = Euler((0, math.radians(-28 * s), 0)).to_matrix()
            g.ellipsoid((0.165 * s, -0.16, 0.84), (0.078, 0.038, 0.072), R, 0, rot)
            g.ellipsoid((0.163 * s, -0.19, 0.835), (0.056, 0.02, 0.05), W, 0, rot)
            out.append((g.obj(f"ear_{side}", [M["fur"]]), "rigid", f"ear.{side}"))
        out.append(nose(M, body, 0.575, (0.03, 0.02, 0.022), lin("#1E1412")))
        return out

    return quadruped({
        "id": "redpanda", "family": "quadruped",
        "elems": [("e", (0, 0.06, 0.33), (0.165, 0.24, 0.15)), ("b", (0, -0.1, 0.37), 0.14),
                  ("b", hc, hr), ("e", (0, -0.21, 0.6), (0.27, 0.2, 0.17)),
                  ("e", (0, -0.38, 0.555), (0.085, 0.09, 0.065))],
        "head_c": hc, "head_r": hr, "leg": (0.1, -0.12, 0.21, 0.27, 0.06, 0.064),
        "tail": tail, "tail_r": [0.075, 0.09, 0.09, 0.075], "colour": colour, "parts": parts,
        "eye": EyeSpec(0.095, 0.66, 0.055, lin("#14100E")), "mouth": (0.515, 0.045),
        "body_z": 0.34, "neck_z": 0.44,
        "joints": ear_joints((0.15, -0.16, 0.8), (0.2, -0.16, 0.9)),
    })


def dragon() -> Model:
    T, Td, C, Cd, H = lin("#2FA897"), lin("#1C7A73"), lin("#F4E4B4"), lin("#D9BF85"), lin("#F2E6C4")
    Mb = lin("#64CDBF")
    hc, hr = (0, -0.18, 0.64), 0.23
    tail = [(0, 0.28, 0.32), (0, 0.43, 0.27), (0, 0.56, 0.25), (0, 0.66, 0.3), (0, 0.71, 0.39)]
    tc = Curve(tail)

    def colour(co: Vector, n: Vector) -> Col:
        t, d = tc.nearest(co)
        if co.y > 0.25 and d < 0.11:
            return Td if n.z > 0.5 else T
        belly = (n.y < -0.3 or n.z < -0.4) and abs(co.x) < 0.12 and 0.12 < co.z < 0.5 and -0.33 < co.y < 0.2
        if belly:
            return Cd if (co.z * 26) % 1.0 < 0.14 else C
        if co.y < -0.4 and co.z < 0.56:
            return mix(T, C, 0.55)
        return mix(T, Td, max(0.0, n.z - 0.3) * 1.2)

    def parts(M, body):
        out = []
        g = Geo()
        for s in (1, -1):
            g.tube([(0.085 * s, -0.13, 0.8), (0.11 * s, -0.08, 0.9), (0.13 * s, 0.0, 0.97)],
                   [0.042, 0.03, 0.0], H, 0, 10, smooth=6)
        out.append((g.obj("horns", [M["gloss"]]), "rigid", "head"))
        g = Geo()
        for s in (1, -1):
            g.ellipsoid((0.035 * s, -0.485, 0.61), (0.012, 0.008, 0.009), lin("#14302C"), 0)
        out.append((g.obj("nostrils", [M["gloss"]]), "rigid", "head"))
        bvh = bvh_of(body)
        g = Geo()
        for y, h in ((-0.02, 0.07), (0.07, 0.08), (0.16, 0.08), (0.25, 0.07), (0.36, 0.06),
                     (0.47, 0.05), (0.57, 0.045), (0.66, 0.04)):
            p, nrm = cast(bvh, (0, y, 5), (0, 0, -1))
            nrm = (nrm + V((0, 0, 1))).normalized()
            g.tube([p - nrm * 0.02, p + nrm * h * 0.5, p + nrm * h], [h * 0.48, h * 0.3, 0.0], C, 0, 8,
                   (1, 0, 0), 0.45)
        out.append((g.obj("spikes", [M["gloss"]]), "copy", None))
        for side, s in (("L", 1), ("R", -1)):
            g = Geo()
            sh, tip = V((0.13 * s, 0.03, 0.5)), V((0.37 * s, 0.17, 0.77))
            outline = [sh, tip, V((0.36 * s, 0.23, 0.62)), V((0.3 * s, 0.21, 0.56)),
                       V((0.26 * s, 0.22, 0.46)), V((0.19 * s, 0.14, 0.45))]
            g.slab(outline, 0.014, Mb, 0)
            g.tube([sh, sh.lerp(tip, 0.5), tip], [0.024, 0.017, 0.006], Td, 0, 8)
            out.append((g.obj(f"wing_{side}", [M["fur"]]), "rigid", f"wing.{side}"))
        return out

    return quadruped({
        "id": "dragon", "family": "dragon",
        "elems": [("e", (0, 0.06, 0.33), (0.18, 0.25, 0.17)), ("b", (0, -0.08, 0.34), 0.16),
                  ("b", hc, hr), ("e", (0, -0.19, 0.61), (0.25, 0.2, 0.17)),
                  ("e", (0, -0.37, 0.58), (0.115, 0.12, 0.09))],
        "head_c": hc, "head_r": hr, "leg": (0.105, -0.12, 0.22, 0.27, 0.065, 0.07),
        "tail": tail, "tail_r": [0.085, 0.07, 0.05, 0.035], "colour": colour, "parts": parts,
        "eye": EyeSpec(0.1, 0.665, 0.06, lin("#14100E")), "mouth": (0.535, 0.06),
        "body_z": 0.34, "neck_z": 0.44,
        "joints": {"wing.L": ((0.13, 0.03, 0.5), (0.37, 0.17, 0.77), "chest"),
                   "wing.R": ((-0.13, 0.03, 0.5), (-0.37, 0.17, 0.77), "chest")},
    })


# -------------------------------------------------------------------- bird

def bird(cfg: dict) -> Model:
    M = mats()
    body = metaballs(cfg["id"], cfg["elems"], cfg.get("res", 0.011))
    decimate(body, cfg.get("tris", 5000))
    body.data.materials.append(M["fur"])
    paint(body, cfg["colour"])
    mdl = Model("bird", body)
    for p in cfg["parts"](M, body):
        mdl.parts.append(p)
    mdl.eyes = build_eyes(body, cfg["eye"], M)
    if "mouth_at" in cfg:
        at, w = cfg["mouth_at"]
        mdl.mouth = build_mouth(V(at), V((0, -1, 0)), w, M, lin("#3A1015"))
    else:
        mz, w = cfg["mouth"]
        mdl.mouth = mouth_on(body, mz, w, M, lin("#3A1015"))
    mdl.joints = dict(cfg["joints"])
    mdl.body_bones = {"hips", "chest", "neck", "head"}
    return mdl


def bird_feet(M: dict, x: float, top: float, col: Col) -> list:
    out = []
    for side, s in (("L", 1), ("R", -1)):
        g = Geo()
        fx = x * s
        g.tube([(fx, -0.01, top), (fx, -0.02, 0.025)], [0.022, 0.02], col, 0, 8)
        for dx, dy in ((0.025, -0.07), (-0.022, -0.068), (0.012, 0.045)):
            g.tube([(fx, -0.02, 0.022), (fx + dx * s, -0.02 + dy * 0.6, 0.016), (fx + dx * s, -0.02 + dy, 0.012)],
                   [0.016, 0.013, 0.0], col, 0, 8)
        out.append((g.obj(f"foot_{side}", [M["gloss"]]), "rigid", f"leg.{side}"))
    return out


def bird_joints(head_y: float, chest_top: float, head_top: float, jaw, wing, tail, leg_x: float,
                ears=None) -> dict[str, Joint]:
    J: dict[str, Joint] = {
        "hips": ((0, 0.02, 0.12), (0, 0.02, 0.36), "root"),
        "chest": ((0, 0.02, 0.36), (0, head_y, chest_top), "hips"),
        "neck": ((0, head_y, chest_top), (0, head_y, chest_top + 0.07), "chest"),
        "head": ((0, head_y, chest_top + 0.07), (0, head_y, head_top), "neck"),
        "jaw": (jaw[0], jaw[1], "head"),
        "tail1": (tail[0], tail[1], "hips"),
    }
    for side, s in (("L", 1), ("R", -1)):
        J[f"wing.{side}"] = ((wing[0][0] * s, wing[0][1], wing[0][2]), (wing[1][0] * s, wing[1][1], wing[1][2]), "chest")
        J[f"leg.{side}"] = ((leg_x * s, 0.0, 0.13), (leg_x * s, -0.02, 0.0), "hips")
        if ears:
            J[f"ear.{side}"] = ((ears[0][0] * s, ears[0][1], ears[0][2]), (ears[1][0] * s, ears[1][1], ears[1][2]), "head")
    return J


def parrot() -> Model:
    Rd, Y, Bl, Iv, Dk, Fw, Gr = (lin("#D8262C"), lin("#F7C21A"), lin("#2C68D4"), lin("#F3E7CC"),
                                 lin("#2E2D33"), lin("#F6F1EA"), lin("#74737C"))
    wing = [(0.15, 0.0, 0.56), (0.185, 0.06, 0.44), (0.18, 0.13, 0.29), (0.14, 0.19, 0.15)]

    def colour(co: Vector, n: Vector) -> Col:
        if co.y < -0.06 and co.z > 0.58:
            for s in (1, -1):
                if math.hypot(co.x - 0.1 * s, co.z - 0.7) < 0.08:
                    return Fw
        return Rd

    def wing_col(co: Vector, n: Vector) -> Col:
        z = co.z
        if z > 0.43:
            return Rd
        if z > 0.33:
            return Y
        return Bl

    def parts(M, body):
        out = []
        g = Geo()
        g.tube([(0, -0.15, 0.69), (0, -0.25, 0.69), (0, -0.31, 0.65), (0, -0.325, 0.585), (0, -0.305, 0.545)],
               [0.07, 0.062, 0.046, 0.026, 0.0], Iv, 0, 12, (1, 0, 0), 0.78, smooth=10)
        out.append((g.obj("beak", [M["gloss"]]), "rigid", "head"))
        g = Geo()
        g.tube([(0, -0.16, 0.62), (0, -0.24, 0.6), (0, -0.275, 0.575)], [0.055, 0.04, 0.0], Dk, 0, 10,
               (1, 0, 0), 0.85)
        out.append((g.obj("beak_lower", [M["gloss"]]), "rigid", "jaw"))
        for side, s in (("L", 1), ("R", -1)):
            g = Geo()
            g.tube([(p[0] * s, p[1], p[2]) for p in wing], [0.075, 0.095, 0.075, 0.0], wing_col, 0, 12,
                   (1, 0, 0), 0.38, smooth=10)
            out.append((g.obj(f"wing_{side}", [M["fur"]]), "rigid", f"wing.{side}"))
        g = Geo()
        g.tube([(0, 0.13, 0.22), (0, 0.22, 0.12), (0, 0.28, 0.02)], [0.075, 0.065, 0.03],
               lambda co, n: Rd if co.z > 0.14 else Bl, 0, 12, (0, 0.55, 0.85), 0.45, smooth=6)
        out.append((g.obj("tail", [M["fur"]]), "rigid", "tail1"))
        out += bird_feet(M, 0.07, 0.13, Gr)
        return out

    return bird({
        "id": "parrot",
        "elems": [("e", (0, 0.03, 0.34), (0.18, 0.17, 0.24)), ("b", (0, -0.03, 0.29), 0.15),
                  ("b", (0, -0.02, 0.68), 0.205), ("e", (0, -0.04, 0.655), (0.2, 0.18, 0.17))],
        "colour": colour, "parts": parts,
        "eye": EyeSpec(0.1, 0.705, 0.05, lin("#14100E"), fwd=0.8),
        "mouth_at": ((0, -0.272, 0.6), 0.075),
        "joints": bird_joints(-0.02, 0.52, 0.88, ((0, -0.16, 0.62), (0, -0.275, 0.575)),
                              (wing[0], wing[-1]), ((0, 0.13, 0.22), (0, 0.28, 0.02)), 0.07),
    })


def owl() -> Model:
    Br, Lt, Sp, Am, Oc, Bk = (lin("#8C6A4C"), lin("#EFE3CF"), lin("#5C4331"), lin("#F4A01A"),
                              lin("#7A6440"), lin("#0E0B0A"))
    wing = [(0.22, 0.0, 0.52), (0.25, 0.06, 0.38), (0.22, 0.12, 0.22), (0.16, 0.16, 0.12)]
    tuft = ((0.14, -0.03, 0.83), (0.23, -0.01, 0.99))

    def colour(co: Vector, n: Vector) -> Col:
        if co.y < -0.06:
            for s in (1, -1):
                d = math.hypot(co.x - 0.105 * s, co.z - 0.69)
                if d < 0.115:
                    return Lt
                if d < 0.135 and co.z > 0.6:
                    return Sp
        if n.y < -0.25 and co.z < 0.54 and abs(co.x) < 0.18:
            return Sp if (math.sin(co.z * 70) > 0.75 and math.sin(co.x * 45 + co.z * 20) > 0.2) else Lt
        if math.sin(co.x * 70) * math.sin(co.z * 70) > 0.8:
            return Lt
        return Br

    def wing_col(co: Vector, n: Vector) -> Col:
        return Lt if math.sin(co.y * 90) * math.sin(co.z * 60) > 0.7 else Br

    def parts(M, body):
        out = []
        g = Geo()
        g.tube([(0, -0.2, 0.665), (0, -0.245, 0.635), (0, -0.25, 0.598)], [0.03, 0.022, 0.0], Oc, 0, 10,
               (1, 0, 0), 0.8)
        out.append((g.obj("beak", [M["gloss"]]), "rigid", "head"))
        g = Geo()
        g.tube([(0, -0.205, 0.61), (0, -0.232, 0.596)], [0.018, 0.0], Oc, 0, 8)
        out.append((g.obj("beak_lower", [M["gloss"]]), "rigid", "jaw"))
        for side, s in (("L", 1), ("R", -1)):
            g = Geo()
            g.tube([(p[0] * s, p[1], p[2]) for p in wing], [0.075, 0.095, 0.075, 0.0], wing_col, 0, 12,
                   (1, 0, 0), 0.38, smooth=10)
            out.append((g.obj(f"wing_{side}", [M["fur"]]), "rigid", f"wing.{side}"))
            g = Geo()
            b, t = V((tuft[0][0] * s, tuft[0][1], tuft[0][2])), V((tuft[1][0] * s, tuft[1][1], tuft[1][2]))
            g.tube([b - (t - b) * 0.3, b, b.lerp(t, 0.55), t], [0.045, 0.05, 0.032, 0.0], Br, 0, 10, (0, -1, 0), 0.5)
            out.append((g.obj(f"tuft_{side}", [M["fur"]]), "rigid", f"ear.{side}"))
        g = Geo()
        g.tube([(0, 0.2, 0.18), (0, 0.27, 0.09)], [0.065, 0.03], Br, 0, 10, (0, 0.6, 0.8), 0.5)
        out.append((g.obj("tail", [M["fur"]]), "rigid", "tail1"))
        out += bird_feet(M, 0.08, 0.13, lin("#B89048"))
        return out

    return bird({
        "id": "owl",
        "elems": [("e", (0, 0.02, 0.34), (0.25, 0.23, 0.27)), ("e", (0, 0.0, 0.67), (0.255, 0.23, 0.21))],
        "colour": colour, "parts": parts,
        "eye": EyeSpec(0.105, 0.69, 0.068, Am, flat=0.5, tall=1.0, fwd=0.9, pupil=Bk),
        "mouth": (0.575, 0.05),
        "joints": bird_joints(0.0, 0.5, 0.86, ((0, -0.205, 0.61), (0, -0.232, 0.596)),
                              (wing[0], wing[-1]), ((0, 0.2, 0.18), (0, 0.27, 0.09)), 0.08, tuft),
    })


# ------------------------------------------------------------------- drone

def drone() -> Model:
    M = mats()
    Wt, Bl, Yl, Rd, Gy, Vs = (lin("#F4F6F8"), lin("#2F7BEA"), lin("#F6C21C"), lin("#E8413A"),
                              lin("#9AA3AE"), lin("#0E131B"))
    g = Geo()
    g.ellipsoid((0, 0, 0.5), (0.44, 0.42, 0.36), Wt, 0, None, 28, 16)
    body = g.obj("drone", [M["shell"]])
    mdl = Model("robot", body)
    g = Geo()
    g.ellipsoid((0, 0, 0.42), (0.448, 0.428, 0.04), Bl, 0, None, 28, 6)
    g.ellipsoid((0, 0, 0.15), (0.075, 0.075, 0.05), Yl, 0, None, 14, 8)
    g.tube([(0, 0.06, 0.84), (0, 0.08, 0.96)], [0.012, 0.012], Gy, 0, 8)
    g.ellipsoid((0, 0.08, 0.975), (0.032, 0.032, 0.032), Rd, 0, None, 12, 8)
    props = []
    accents = [Yl, Rd, Bl, Yl]
    for i, (sx, sy) in enumerate(((1, -1), (-1, -1), (-1, 1), (1, 1))):
        a = V((0.26 * sx, 0.26 * sy, 0.6))
        b = V((0.42 * sx, 0.42 * sy, 0.68))
        g.tube([a, b], [0.034, 0.028], Wt, 0, 10)
        g.ellipsoid(b + V((0, 0, 0.01)), (0.042, 0.042, 0.03), accents[i], 0, None, 12, 6)
        p = Geo()
        c = b + V((0, 0, 0.045))
        for k in range(4):
            rot = Euler((0, 0, math.radians(45 + 90 * k))).to_matrix()
            p.ellipsoid(c + rot @ V((0.065, 0, 0)), (0.062, 0.022, 0.007), accents[i], 0, rot, 10, 6)
        circle = [c + V((math.cos(t) * 0.13, math.sin(t) * 0.13, 0)) for t in
                  (2 * math.pi * k / 24 for k in range(24))]
        p.tube(circle, [0.01] * 24, Gy, 0, 6, closed=True)
        props.append((p.obj(f"prop{i + 1}", [M["shell"]]), "rigid", f"prop{i + 1}"))
        mdl.joints[f"prop{i + 1}"] = (t3(b), t3(b + V((0, 0, 0.12))), "body")
    mdl.parts.append((g.obj("shell_parts", [M["shell"]]), "rigid", "body"))
    v = Geo()
    v.ellipsoid((0, -0.3, 0.53), (0.3, 0.16, 0.2), Vs, 0, None, 24, 14)
    visor = v.obj("visor", [M["eye"]])
    mdl.eyes = build_eyes(visor, EyeSpec(0.1, 0.54, 0.05, (0.3, 0.9, 1.0), flat=0.4, tall=1.35, embed=0.2,
                                         fwd=0.3, glow=True), M)
    mdl.parts.append((visor, "rigid", "head"))
    mdl.parts += props
    mdl.joints.update({
        "body": ((0, 0, 0.14), (0, 0, 0.86), "root"),
        "head": ((0, -0.3, 0.4), (0, -0.3, 0.68), "body"),
    })
    mdl.body_bones = set()
    return mdl


BUILDERS = {"cat": cat, "fox": fox, "redpanda": redpanda, "dragon": dragon,
            "parrot": parrot, "owl": owl, "drone": drone}


def build(pet: str) -> Model:
    return BUILDERS[pet]()


def nearest_weights(src: bpy.types.Object, dst: bpy.types.Object) -> None:
    """Copy the weights of the nearest weighted src vertex onto every dst vertex."""
    kd = KDTree(len(src.data.vertices))
    for v in src.data.vertices:
        if v.groups:
            kd.insert(v.co, v.index)
    kd.balance()
    names = {g.index: g.name for g in src.vertex_groups}
    for v in dst.data.vertices:
        _co, i, _d = kd.find(v.co)
        for ge in src.data.vertices[i].groups:
            name = names[ge.group]
            grp = dst.vertex_groups.get(name) or dst.vertex_groups.new(name=name)
            grp.add([v.index], ge.weight, "REPLACE")
