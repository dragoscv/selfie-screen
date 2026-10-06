"""Procedural build: model (models.py) -> normalise -> rig -> weights -> clips
(clips.py) -> .blend + raw glb. Called from build.py --procedural."""

from __future__ import annotations

import json
import math
from pathlib import Path

import bpy
from mathutils import Euler, Matrix, Vector
from mathutils.kdtree import KDTree

import clips as C
import models


def reset_scene() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.render.fps = 30


def all_meshes(mdl: models.Model) -> list[bpy.types.Object]:
    out = [mdl.body] + [p[0] for p in mdl.parts]
    out += [o for o in (mdl.eyes, mdl.mouth) if o]
    return out


def normalise(mdl: models.Model) -> None:
    """Feet on z = 0, x centred, y centred on the feet, exactly 1 unit tall."""
    meshes = all_meshes(mdl)
    pts = [v.co for o in meshes for v in o.data.vertices]
    lo_z, hi_z = min(p.z for p in pts), max(p.z for p in pts)
    cx = (min(p.x for p in pts) + max(p.x for p in pts)) / 2
    feet = [j[1] for n, j in mdl.joints.items() if n.startswith(("leg_front_lower", "leg_back_lower", "leg."))]
    cy = sum(f[1] for f in feet) / len(feet) if feet else 0.0
    if not feet:
        cy = (min(p.y for p in pts) + max(p.y for p in pts)) / 2
    s = 1.0 / (hi_z - lo_z)
    m = Matrix.Scale(s, 4) @ Matrix.Translation((-cx, -cy, -lo_z))
    for o in meshes:
        o.data.transform(m, shape_keys=True)
        o.data.update()

    def f(p):
        return tuple(m @ Vector(p))
    mdl.joints = {n: (f(h), f(t), par) for n, (h, t, par) in mdl.joints.items()}


def build_rig(mdl: models.Model) -> bpy.types.Object:
    data = bpy.data.armatures.new("rig")
    arm = bpy.data.objects.new("rig", data)
    bpy.context.scene.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    arm.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    joints = {"root": ((0, 0, 0), (0, 0, 0.1), None), **mdl.joints}
    for name, (h, t, _p) in joints.items():
        b = data.edit_bones.new(name)
        b.head, b.tail = Vector(h), Vector(t)
        if (b.tail - b.head).length < 1e-3:
            b.tail = b.head + Vector((0, 0, 0.05))
        b.roll = 0.0
        b.use_deform = name != "root"
    for name, (_h, _t, p) in joints.items():
        if p:
            data.edit_bones[name].parent = data.edit_bones[p]
    bpy.ops.object.mode_set(mode="OBJECT")
    return arm


def bind_rigid(obj: bpy.types.Object, bone: str) -> None:
    g = obj.vertex_groups.new(name=bone)
    g.add([v.index for v in obj.data.vertices], 1.0, "REPLACE")


def attach(obj: bpy.types.Object, arm: bpy.types.Object) -> None:
    obj.parent = arm
    if not any(m.type == "ARMATURE" for m in obj.modifiers):
        mod = obj.modifiers.new("rig", "ARMATURE")
        mod.object = arm


def unweighted(obj: bpy.types.Object) -> list[int]:
    return [v.index for v in obj.data.vertices if not any(g.weight > 1e-3 for g in v.groups)]


def heal(obj: bpy.types.Object, bad: list[int]) -> None:
    """Give heat-weighting holes the weights of the nearest weighted vertex."""
    badset = set(bad)
    kd = KDTree(len(obj.data.vertices))
    for v in obj.data.vertices:
        if v.index not in badset:
            kd.insert(v.co, v.index)
    kd.balance()
    for i in bad:
        _c, j, _d = kd.find(obj.data.vertices[i].co)
        for ge in obj.data.vertices[j].groups:
            obj.vertex_groups[ge.group].add([i], ge.weight, "REPLACE")


def skin(mdl: models.Model, arm: bpy.types.Object) -> dict:
    report = {"heat_unweighted": 0}
    if mdl.body_bones:
        for b in arm.data.bones:
            b.use_deform = b.name in mdl.body_bones
        bpy.ops.object.select_all(action="DESELECT")
        mdl.body.select_set(True)
        arm.select_set(True)
        bpy.context.view_layer.objects.active = arm
        bpy.ops.object.parent_set(type="ARMATURE_AUTO")
        for b in arm.data.bones:
            b.use_deform = b.name != "root"
        bad = unweighted(mdl.body)
        report["heat_unweighted"] = len(bad)
        if bad:
            heal(mdl.body, bad)
        bpy.ops.object.select_all(action="DESELECT")
        mdl.body.select_set(True)
        bpy.context.view_layer.objects.active = mdl.body
        bpy.ops.object.vertex_group_limit_total(group_select_mode="ALL", limit=4)
        bpy.ops.object.vertex_group_normalize_all(group_select_mode="ALL", lock_active=False)
    else:
        bind_rigid(mdl.body, "body")
    attach(mdl.body, arm)
    for obj, how, bone in mdl.parts:
        if how == "copy":
            models.nearest_weights(mdl.body, obj)
        else:
            bind_rigid(obj, bone)
        attach(obj, arm)
    if mdl.eyes:
        bind_rigid(mdl.eyes, "head")
        attach(mdl.eyes, arm)
    if mdl.mouth:
        bind_rigid(mdl.mouth, "jaw")
        attach(mdl.mouth, arm)
    report["unweighted"] = sum(len(unweighted(o)) for o in all_meshes(mdl))
    return report


def local_quat(bone: bpy.types.Bone, rot_deg: tuple[float, ...]):
    """Armature-space euler (degrees) -> pose-bone local quaternion."""
    r = Euler(tuple(math.radians(a) for a in rot_deg[:3]), "XYZ").to_matrix()
    rest = bone.matrix_local.to_3x3()
    return (rest.inverted() @ r @ rest).to_quaternion()


def local_lift(bone: bpy.types.Bone, dz: float) -> Vector:
    return bone.matrix_local.to_3x3().inverted() @ Vector((0, 0, dz))


def bake(arm: bpy.types.Object, family: str) -> list[dict]:
    lib = C.clips_for(family)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="POSE")
    arm.animation_data_create()
    bones = [pb for pb in arm.pose.bones if pb.name != "root"]
    for pb in arm.pose.bones:
        pb.rotation_mode = "QUATERNION"
    out = []
    for name in C.ORDER:
        length, keys = lib[name]
        action = bpy.data.actions.new(name)
        action.use_fake_user = True
        arm.animation_data.action = action
        spin_frames = range(0, length + 1)
        for frame, pose in keys:
            for pb in bones:
                if pb.name in C.SPIN:
                    continue
                v = pose.get(pb.name, (0, 0, 0))
                pb.rotation_quaternion = local_quat(pb.bone, v)
                pb.location = local_lift(pb.bone, v[3]) if len(v) > 3 else (0, 0, 0)
                pb.keyframe_insert("rotation_quaternion", frame=frame)
                pb.keyframe_insert("location", frame=frame)
        for pb in bones:
            if pb.name not in C.SPIN:
                continue
            for f in spin_frames:
                ang = 90.0 * f / length
                pb.rotation_quaternion = local_quat(pb.bone, (0, 0, ang))
                pb.location = (0, 0, 0)
                pb.keyframe_insert("rotation_quaternion", frame=f)
                pb.keyframe_insert("location", frame=f)
        action.frame_range = (0, length)
        action.use_frame_range = True
        action.use_cyclic = name in C.LOOPS
        out.append({"name": name, "s": round(length / 30, 3)})
        for pb in arm.pose.bones:
            pb.rotation_quaternion = (1, 0, 0, 0)
            pb.location = (0, 0, 0)
    arm.animation_data.action = bpy.data.actions["idle"]
    bpy.context.scene.frame_set(0)
    bpy.ops.object.mode_set(mode="OBJECT")
    return out


def run(pet: str, spec: dict, out_dir: Path) -> dict:
    reset_scene()
    mdl = models.build(pet)
    normalise(mdl)
    arm = build_rig(mdl)
    report = skin(mdl, arm)
    for o in all_meshes(mdl):
        if o.data.shape_keys:
            for kb in o.data.shape_keys.key_blocks:
                kb.value = 0.0
    clips = bake(arm, spec["family"])
    arm.scale = (spec["heightM"],) * 3
    out_dir.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(out_dir / f"{pet}.blend"))
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(
        filepath=str(out_dir / f"{pet}.raw.glb"), export_format="GLB",
        export_animation_mode="ACTIONS", export_force_sampling=True, export_morph=True,
        export_morph_normal=False, export_skins=True, export_apply=False, export_yup=True,
        export_vertex_color="MATERIAL", export_texcoords=False, export_extras=False,
    )
    meshes = all_meshes(mdl)
    morphs = []
    for o in meshes:
        if o.data.shape_keys:
            morphs += [f"{o.name}:{kb.name}" for kb in o.data.shape_keys.key_blocks[1:]]
    result = {
        "pet": pet, "procedural": True,
        "tris": sum(models.tri_count(o) for o in meshes),
        "body_tris": models.tri_count(mdl.body),
        "weights": "auto" if mdl.body_bones else "rigid",
        **report,
        "bones": [b.name for b in arm.data.bones],
        "morphs": morphs,
        "clips": clips,
        "mouth": bool(mdl.mouth),
    }
    print("TIKSEE_BUILD", json.dumps(result))
    return result
