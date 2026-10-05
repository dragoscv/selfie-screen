"""Build one pet headless: import the raw mesh (TRELLIS.2 glb, or a primitive
proxy), normalise, decimate, rig by family, add the mouth piece with 8 viseme
shape keys, bake the shared clips as actions and export a glb.

blender -b --factory-startup -P build.py -- --pet cat [--input raw.glb] --out out/
"""

import argparse
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from anims import CLIPS  # noqa: E402
from rigs import FAMILIES  # noqa: E402

TRI_BUDGET = 24000
VISEMES = ["rest", "aa", "ee", "ih", "oh", "ou", "fv", "mbp"]


def args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--pet", required=True)
    p.add_argument("--input")
    p.add_argument("--out", required=True)
    return p.parse_args(argv)


def pet_spec(pet_id: str) -> dict:
    pets = json.loads((HERE.parent / "pets.json").read_text(encoding="utf-8"))
    return next(p for p in pets if p["id"] == pet_id)


def reset_scene() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.render.fps = 30


def proxy(family: str) -> bpy.types.Object:
    """Primitive stand-in so the pipeline is testable without generated meshes."""
    parts = []

    def add(op, loc, scale):
        op(location=loc)
        o = bpy.context.active_object
        o.scale = scale
        parts.append(o)

    s = bpy.ops.mesh.primitive_uv_sphere_add
    if family == "robot":
        add(s, (0, 0, 0.5), (0.5, 0.5, 0.45))
        for x, y in ((0.5, 0.5), (-0.5, 0.5), (0.5, -0.5), (-0.5, -0.5)):
            add(bpy.ops.mesh.primitive_cylinder_add, (x * 0.8, y * 0.8, 0.6), (0.18, 0.18, 0.02))
    elif family == "bird":
        add(s, (0, 0, 0.4), (0.3, 0.28, 0.32))
        add(s, (0, -0.06, 0.8), (0.22, 0.22, 0.2))
        add(bpy.ops.mesh.primitive_cone_add, (0, -0.3, 0.74), (0.06, 0.06, 0.1))
    else:
        add(s, (0, 0, 0.48), (0.22, 0.38, 0.2))
        add(s, (0, -0.34, 0.78), (0.18, 0.18, 0.18))
        for x in (0.16, -0.16):
            for y in (-0.2, 0.22):
                add(bpy.ops.mesh.primitive_cylinder_add, (x, y, 0.2), (0.06, 0.06, 0.22))
        add(bpy.ops.mesh.primitive_cylinder_add, (0, 0.44, 0.6), (0.05, 0.05, 0.2))
        if family == "dragon":
            add(s, (0.3, 0.05, 0.7), (0.18, 0.04, 0.1))
            add(s, (-0.3, 0.05, 0.7), (0.18, 0.04, 0.1))
    for o in parts:
        o.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    return bpy.context.active_object


def import_mesh(path: str) -> bpy.types.Object:
    bpy.ops.import_scene.gltf(filepath=path)
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    bpy.ops.object.select_all(action="DESELECT")
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    obj = bpy.context.active_object
    obj.parent = None
    for o in [o for o in bpy.context.scene.objects if o.type == "EMPTY"]:
        bpy.data.objects.remove(o)
    return obj


def normalise(obj: bpy.types.Object, height: float) -> None:
    """Apply transforms, put feet on z=0, centre x/y, scale to unit height.
    The armature then scales everything to the real height in metres."""
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    pts = [obj.matrix_world @ v.co for v in obj.data.vertices]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    size = hi - lo
    k = 1.0 / size.z
    for v in obj.data.vertices:
        v.co = Vector(((v.co.x - (lo.x + hi.x) / 2) * k, (v.co.y - (lo.y + hi.y) / 2) * k, (v.co.z - lo.z) * k))
    obj.data.update()
    obj["tiksee_height_m"] = height


def bbox(obj: bpy.types.Object) -> tuple[Vector, Vector]:
    xs = [v.co for v in obj.data.vertices]
    return (Vector((min(p.x for p in xs), min(p.y for p in xs), 0.0)),
            Vector((max(p.x for p in xs), max(p.y for p in xs), 1.0)))


def decimate(obj: bpy.types.Object) -> None:
    tris = sum(len(p.vertices) - 2 for p in obj.data.polygons)
    if tris > TRI_BUDGET:
        m = obj.modifiers.new("decimate", "DECIMATE")
        m.ratio = TRI_BUDGET / tris
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier=m.name)
    bpy.ops.object.shade_smooth()


def build_rig(family: str, obj: bpy.types.Object) -> bpy.types.Object:
    lo, hi = bbox(obj)
    w, d = hi.x - lo.x, hi.y - lo.y

    def at(f):
        return Vector((f[0] * w, f[1] * d, f[2]))

    arm_data = bpy.data.armatures.new("rig")
    arm = bpy.data.objects.new("rig", arm_data)
    bpy.context.scene.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    bones = FAMILIES[family]
    for name, (head, tail, _parent, deform) in bones.items():
        b = arm_data.edit_bones.new(name)
        b.head, b.tail = at(head), at(tail)
        if (b.tail - b.head).length < 1e-4:
            b.tail = b.head + Vector((0, 0, 0.05))
        b.use_deform = deform
    for name, (_h, _t, parent, _d) in bones.items():
        if parent:
            arm_data.edit_bones[name].parent = arm_data.edit_bones[parent]
    fit_jaw(arm_data, obj)
    bpy.ops.object.mode_set(mode="OBJECT")
    return arm


def fit_jaw(arm_data: bpy.types.Armature, obj: bpy.types.Object) -> None:
    """Put the jaw on the real snout: the frontmost centre-line vertex in the
    upper half of the mesh is the nose/beak tip; the mouth sits just below it."""
    jaw = arm_data.edit_bones.get("jaw")
    head = arm_data.edit_bones.get("head")
    if jaw is None or head is None:
        return
    centre = [v.co for v in obj.data.vertices if abs(v.co.x) < 0.05 and v.co.z > 0.45]
    if not centre:
        return
    tip = min(centre, key=lambda c: c.y)
    head_top = max(c.z for c in centre)
    mouth_z = tip.z - 0.04
    pivot = Vector((0, tip.y + 0.12, mouth_z + 0.02))
    jaw.use_connect = False
    jaw.head = pivot
    jaw.tail = Vector((0, tip.y + 0.01, mouth_z))
    head.head = Vector((0, pivot.y + 0.04, mouth_z - 0.08))
    head.tail = Vector((0, pivot.y + 0.04, head_top))


def skin(obj: bpy.types.Object, arm: bpy.types.Object) -> str:
    """Automatic weights; generated meshes are often non-manifold, so fall back
    to envelope weights when heat diffusion leaves vertices unweighted."""
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.parent_set(type="ARMATURE_AUTO")
    unweighted = sum(1 for v in obj.data.vertices if not any(g.weight > 0.01 for g in v.groups))
    if unweighted > len(obj.data.vertices) * 0.02:
        for g in list(obj.vertex_groups):
            obj.vertex_groups.remove(g)
        bpy.ops.object.parent_set(type="ARMATURE_ENVELOPE")
        return f"envelope ({unweighted} unweighted with heat)"
    return "auto"


def mouth(family: str, obj: bpy.types.Object, arm: bpy.types.Object) -> bpy.types.Object | None:
    """Separate mouth piece parented to the jaw (Q36), 8 viseme shape keys."""
    if family == "robot":
        return None
    jaw = arm.data.bones["jaw"]
    pos = jaw.tail_local
    # Snap onto the surface at mouth height (frontmost vertex near that z).
    near = [v.co for v in obj.data.vertices if abs(v.co.x) < 0.05 and abs(v.co.z - pos.z) < 0.03]
    front_y = min((c.y for c in near), default=pos.y)
    bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=8, location=(0, front_y + 0.004, pos.z))
    m = bpy.context.active_object
    m.name = "mouth"
    m.scale = (0.05, 0.012, 0.012)
    bpy.ops.object.transform_apply(scale=True)
    mat = bpy.data.materials.new("mouth")
    mat.diffuse_color = (0.08, 0.02, 0.03, 1)
    bsdf = mat.node_tree.nodes.get("Principled BSDF") if mat.node_tree else None
    if bsdf:
        bsdf.inputs["Base Color"].default_value = (0.08, 0.02, 0.03, 1)
        bsdf.inputs["Roughness"].default_value = 0.6
    m.data.materials.append(mat)
    m.shape_key_add(name="Basis")
    shapes = {  # (sx, sz) scale of the opening
        "rest": (1.0, 1.0), "aa": (1.1, 4.5), "ee": (1.5, 1.8), "ih": (1.2, 2.4),
        "oh": (0.75, 3.6), "ou": (0.5, 2.2), "fv": (1.1, 0.6), "mbp": (1.05, 0.25),
    }
    centre = sum((v.co for v in m.data.vertices), Vector()) / len(m.data.vertices)
    for name, (sx, sz) in shapes.items():
        k = m.shape_key_add(name=f"mouth_{name}")
        for i, v in enumerate(m.data.vertices):
            c = v.co - centre
            k.data[i].co = centre + Vector((c.x * sx, c.y, c.z * sz))
    group = m.vertex_groups.new(name="jaw")
    group.add([v.index for v in m.data.vertices], 1.0, "REPLACE")
    mod = m.modifiers.new("rig", "ARMATURE")
    mod.object = arm
    m.parent = arm
    return m


def bake_clips(arm: bpy.types.Object) -> list[str]:
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="POSE")
    arm.animation_data_create()
    names = []
    for clip, (length, keys) in CLIPS.items():
        action = bpy.data.actions.new(clip)
        action.use_fake_user = True
        arm.animation_data.action = action
        for frame, pose in keys:
            for bone, vals in pose.items():
                pb = arm.pose.bones.get(bone)
                if pb is None:
                    continue
                pb.rotation_mode = "XYZ"
                pb.rotation_euler = tuple(math.radians(a) for a in vals[:3])
                pb.location = (0, vals[3], 0) if len(vals) > 3 else (0, 0, 0)
                pb.keyframe_insert("rotation_euler", frame=frame)
                pb.keyframe_insert("location", frame=frame)
        action.frame_range = (0, length)
        action.use_frame_range = True
        names.append(clip)
        for pb in arm.pose.bones:
            pb.rotation_euler = (0, 0, 0)
            pb.location = (0, 0, 0)
    arm.animation_data.action = bpy.data.actions["idle"]
    bpy.ops.object.mode_set(mode="OBJECT")
    return names


def main() -> None:
    a = args()
    spec = pet_spec(a.pet)
    reset_scene()
    obj = import_mesh(a.input) if a.input else proxy(spec["family"])
    obj.name = a.pet
    normalise(obj, spec["heightM"])
    decimate(obj)
    arm = build_rig(spec["family"], obj)
    weights = skin(obj, arm)
    m = mouth(spec["family"], obj, arm)
    clips = bake_clips(arm)
    arm.scale = (spec["heightM"],) * 3
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(out / f"{a.pet}.blend"))
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(
        filepath=str(out / f"{a.pet}.raw.glb"), export_format="GLB",
        export_animation_mode="ACTIONS", export_force_sampling=True,
        export_morph=True, export_skins=True, export_apply=False, export_yup=True,
    )
    tris = sum(len(p.vertices) - 2 for p in obj.data.polygons)
    print("TIKSEE_BUILD", json.dumps({"pet": a.pet, "tris": tris, "weights": weights,
                                      "mouth": bool(m), "clips": clips}))


main()
