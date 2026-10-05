"""Tile every PNG in a QA folder into one sheet (Blender's Python has no PIL,
so this uses bpy images). blender -b -P contact_sheet.py -- <qa_dir> <out.png> [tile]"""

import sys
from pathlib import Path

import bpy

argv = sys.argv[sys.argv.index("--") + 1:]
src, dst = Path(argv[0]), Path(argv[1])
tile = int(argv[2]) if len(argv) > 2 else 256
files = sorted(p for p in src.glob("*.png") if p.resolve() != dst.resolve())
cols = 6
rows = (len(files) + cols - 1) // cols
sheet = bpy.data.images.new("sheet", cols * tile, rows * tile)
px = [0.0] * (cols * tile * rows * tile * 4)
for i, f in enumerate(files):
    img = bpy.data.images.load(str(f))
    img.scale(tile, tile)
    data = img.pixels[:]
    cx, cy = i % cols, rows - 1 - i // cols
    for y in range(tile):
        row = ((cy * tile + y) * cols * tile + cx * tile) * 4
        px[row:row + tile * 4] = data[y * tile * 4:(y + 1) * tile * 4]
sheet.pixels[:] = px
sheet.filepath_raw = str(dst)
sheet.file_format = "PNG"
sheet.save()
print("TIKSEE_SHEET", dst, [f.stem for f in files])
