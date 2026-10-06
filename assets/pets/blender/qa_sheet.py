"""Visual QA for a built pet: renders rest views, blink, mouth_aa and two
frames of every clip under soft room lighting, tiles them (numpy) into one
labelled sheet (~1600 px wide) plus a ~900 px JPEG preview.

blender -b <pet>.blend -P qa_sheet.py -- --out qa/ [--tile 320]
"""

from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector


def args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--out", required=True)
    p.add_argument("--tile", type=int, default=320)
    p.add_argument("--cols", type=int, default=5)
    return p.parse_args(argv)


def emissive(name: str, col) -> bpy.types.Material:
    m = bpy.data.materials.new(name)
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*col, 1)
    b.inputs["Emission Color"].default_value = (*col, 1)
    b.inputs["Emission Strength"].default_value = 1.0
    return m


def setup(tile: int):
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_EEVEE"
    sc.render.resolution_x = sc.render.resolution_y = tile
    sc.render.resolution_percentage = 100
    sc.render.film_transparent = False
    sc.render.image_settings.file_format = "PNG"
    sc.view_settings.view_transform = "AgX"
    world = bpy.data.worlds.new("qa")
    sc.world = world
    bg = world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (0.21, 0.21, 0.22, 1)
    bg.inputs["Strength"].default_value = 0.9
    arm = next(o for o in sc.objects if o.type == "ARMATURE")
    pts = [o.matrix_world @ v.co for o in sc.objects if o.type == "MESH" for v in o.data.vertices]
    span = max(max(abs(p.x) for p in pts) * 2, max(abs(p.y) for p in pts) * 2 * 0.7)
    h = max(arm.scale.z, span * 0.85)
    target = bpy.data.objects.new("target", None)
    sc.collection.objects.link(target)
    target.location = (0, 0, h * 0.5)
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    sc.collection.objects.link(cam)
    cam.data.lens = 60
    cam.data.clip_start = h * 0.05
    sc.camera = cam
    cam.constraints.new("TRACK_TO").target = target
    # Soft room: big warm key, cool fill, bright rim from behind.
    for name, loc, energy, size, col in (
        ("key", (-2.2, -3.0, 3.0), 260.0, 2.5, (1.0, 0.95, 0.88)),
        ("fill", (3.0, -2.0, 1.2), 90.0, 3.0, (0.85, 0.9, 1.0)),
        ("rim", (0.8, 3.2, 2.6), 200.0, 1.5, (1.0, 1.0, 1.0)),
    ):
        light = bpy.data.objects.new(name, bpy.data.lights.new(name, "AREA"))
        light.data.energy = energy * h * h
        light.data.size = size * h
        light.data.color = col
        light.location = Vector(loc) * h
        sc.collection.objects.link(light)
        light.constraints.new("TRACK_TO").target = target
    floor = bpy.data.meshes.new("floor")
    floor.from_pydata([(-1, -1, 0), (1, -1, 0), (1, 1, 0), (-1, 1, 0)], [], [(0, 1, 2, 3)])
    fo = bpy.data.objects.new("floor", floor)
    fo.scale = (h * 3,) * 3
    fo.location.z = -0.0005
    m = bpy.data.materials.new("floor")
    m.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.3, 0.3, 0.31, 1)
    m.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.9
    floor.materials.append(m)
    sc.collection.objects.link(fo)
    txt = bpy.data.curves.new("label", "FONT")
    txt.size = 0.0032
    label = bpy.data.objects.new("label", txt)
    sc.collection.objects.link(label)
    label.parent = cam
    label.location = (-0.027, -0.027, -0.1)
    txt.materials.append(emissive("label", (1.0, 1.0, 1.0)))
    return arm, cam, target, label, h


def place(cam, target, h: float, yaw: float, pitch: float = 14, dist: float = 3.0, aim: float = 0.5) -> None:
    a, p = math.radians(yaw), math.radians(pitch)
    r = h * dist
    target.location = (0, 0, h * aim)
    cam.location = Vector((math.sin(a) * math.cos(p) * r, -math.cos(a) * math.cos(p) * r, h * aim + math.sin(p) * r))


def main() -> None:
    a = args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    arm, cam, target, label, h = setup(a.tile)
    sc = bpy.context.scene
    eyes = sc.objects.get("eyes")
    mouth = sc.objects.get("mouth")
    shots: list[tuple[str, Path]] = []

    def shot(name: str, text: str) -> None:
        label.data.body = text
        path = out / f"{len(shots):02d}_{name}.png"
        sc.render.filepath = str(path)
        bpy.ops.render.render(write_still=True)
        shots.append((text, path))

    def keys(obj, name: str | None) -> None:
        if obj and obj.data.shape_keys:
            for kb in obj.data.shape_keys.key_blocks[1:]:
                kb.value = 1.0 if kb.name == name else 0.0

    arm.animation_data.action = None
    for pb in arm.pose.bones:
        pb.rotation_quaternion = (1, 0, 0, 0)
        pb.location = (0, 0, 0)
    sc.frame_set(0)
    for yaw, text in ((-30, "front 3/4"), (0, "front"), (90, "side"), (180, "back")):
        place(cam, target, h, yaw)
        shot(f"rest_{yaw}", text)
    place(cam, target, h, -12, 6, 2.2, 0.62)
    keys(eyes, "blink")
    keys(mouth, "mouth_aa")
    shot("blink_aa", "blink + mouth_aa")
    keys(eyes, None)
    keys(mouth, "mouth_ou")
    shot("ou", "mouth_ou")
    keys(mouth, None)
    place(cam, target, h, -30)
    for action in [x for x in bpy.data.actions]:
        arm.animation_data.action = action
        s, e = action.frame_range
        for f in (0.3, 0.6):
            frame = int(round(s + (e - s) * f))
            sc.frame_set(frame)
            yaw = -30 if action.name != "wave" else -15
            place(cam, target, h, yaw, dist=3.4 if action.name in ("fly", "react", "dance", "hop") else 3.0)
            shot(f"{action.name}_{int(f * 100)}", f"{action.name} {int(f * 100)}%")
    compose(shots, out, a.tile, a.cols)


def compose(shots, out: Path, tile: int, cols: int) -> None:
    rows = (len(shots) + cols - 1) // cols
    sheet = np.zeros((rows * tile, cols * tile, 4), dtype=np.float32)
    sheet[..., 3] = 1
    for i, (_t, path) in enumerate(shots):
        img = bpy.data.images.load(str(path))
        px = np.array(img.pixels[:], dtype=np.float32).reshape(tile, tile, 4)
        r, c = i // cols, i % cols
        y0 = (rows - 1 - r) * tile
        sheet[y0:y0 + tile, c * tile:(c + 1) * tile] = px
        bpy.data.images.remove(img)
    w, hgt = cols * tile, rows * tile
    img = bpy.data.images.new("sheet", w, hgt, alpha=True)
    img.pixels.foreach_set(sheet.ravel())
    img.filepath_raw = str(out / "sheet.png")
    img.file_format = "PNG"
    img.save()
    small = bpy.data.images.new("small", w, hgt, alpha=True)
    small.pixels.foreach_set(sheet.ravel())
    small.scale(900, int(900 * hgt / w))
    small.filepath_raw = str(out / "sheet_900.jpg")
    small.file_format = "JPEG"
    small.save()
    print("TIKSEE_QA", out / "sheet.png", [t for t, _p in shots])


main()
