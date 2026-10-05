"""Visual QA: render a contact sheet frame per state (mid-clip) plus a
4-view turntable of the rest pose, from the .blend written by build.py.

blender -b <pet>.blend -P render_qa.py -- --out qa/
"""

import argparse
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector


def args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--out", required=True)
    p.add_argument("--size", type=int, default=512)
    return p.parse_args(argv)


def setup(size: int) -> tuple[bpy.types.Object, bpy.types.Object]:
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_EEVEE"
    sc.render.resolution_x = sc.render.resolution_y = size
    sc.render.film_transparent = False
    sc.render.image_settings.media_type = "IMAGE"
    sc.render.image_settings.file_format = "PNG"
    world = bpy.data.worlds.new("qa")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.18, 0.2, 0.24, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.8
    sc.world = world
    arm = next(o for o in sc.objects if o.type == "ARMATURE")
    h = arm.scale.z
    target = bpy.data.objects.new("target", None)
    sc.collection.objects.link(target)
    target.location = (0, 0, h * 0.5)
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    sc.collection.objects.link(cam)
    cam.data.lens = 70
    sc.camera = cam
    t = cam.constraints.new("TRACK_TO")
    t.target = target
    for name, rot, energy in (("key", (50, 0, -35), 3.5), ("rim", (60, 0, 150), 2.0)):
        light = bpy.data.objects.new(name, bpy.data.lights.new(name, "SUN"))
        light.data.energy = energy
        light.rotation_euler = tuple(math.radians(a) for a in rot)
        sc.collection.objects.link(light)
    return arm, cam


def place(cam: bpy.types.Object, h: float, yaw_deg: float) -> None:
    r = h * 4.2
    a = math.radians(yaw_deg)
    cam.location = Vector((math.sin(a) * r, -math.cos(a) * r, h * 0.9))


def render(path: Path) -> None:
    bpy.context.scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)


def main() -> None:
    a = args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    arm, cam = setup(a.size)
    h = arm.scale.z
    sc = bpy.context.scene
    arm.animation_data.action = bpy.data.actions["idle"]
    sc.frame_set(0)
    for yaw in (0, 90, 180, 270):
        place(cam, h, yaw)
        render(out / f"turn_{yaw:03d}.png")
    place(cam, h, 25)
    for action in bpy.data.actions:
        arm.animation_data.action = action
        start, end = action.frame_range
        sc.frame_set(int((start + end) * 0.3))
        render(out / f"state_{action.name}.png")
    mouth = sc.objects.get("mouth")
    if mouth and mouth.data.shape_keys:
        arm.animation_data.action = bpy.data.actions["idle"]
        sc.frame_set(0)
        bpy.context.view_layer.update()
        verts = [mouth.matrix_world @ v.co for v in mouth.data.vertices]
        m = sum(verts, Vector()) / len(verts)
        sc.objects["target"].location = m
        cam.location = Vector((m.x + h * 0.5, m.y - h * 1.3, m.z + h * 0.1))
        cam.data.lens = 85
        keys = mouth.data.shape_keys.key_blocks
        for kb in keys[1:]:
            for other in keys[1:]:
                other.value = 0.0
            kb.value = 1.0
            render(out / f"viseme_{kb.name}.png")
    print("TIKSEE_QA", out)


main()
