"""Family rigs. Joint positions are fractions of the pet's bounding box:
x in [-0.5, 0.5] (left/right), y in [-0.5 front, 0.5 back], z in [0, 1] (up).
Pets face -Y in Blender, which glTF exports as +Z (towards the camera).
Bone names are the contract with the shared animation library and the runtime."""

# name: (head, tail, parent, deform)
Bone = tuple[tuple[float, float, float], tuple[float, float, float], str | None, bool]

_SPINE: dict[str, Bone] = {
    "root": ((0, 0, 0), (0, 0, 0.1), None, False),
    "hips": ((0, 0.2, 0.45), (0, -0.02, 0.5), "root", True),
    "chest": ((0, -0.02, 0.5), (0, -0.22, 0.52), "hips", True),
    "neck": ((0, -0.22, 0.52), (0, -0.3, 0.68), "chest", True),
    "head": ((0, -0.3, 0.68), (0, -0.34, 0.98), "neck", True),
    "jaw": ((0, -0.32, 0.7), (0, -0.48, 0.66), "head", True),
    "tail1": ((0, 0.32, 0.45), (0, 0.4, 0.5), "hips", True),
    "tail2": ((0, 0.4, 0.5), (0, 0.46, 0.62), "tail1", True),
    "tail3": ((0, 0.46, 0.62), (0, 0.5, 0.8), "tail2", True),
}


def _legs() -> dict[str, Bone]:
    out: dict[str, Bone] = {}
    for side, sx in (("L", 0.16), ("R", -0.16)):
        for end, sy, parent in (("front", -0.2, "chest"), ("back", 0.22, "hips")):
            up = f"leg_{end}_upper.{side}"
            out[up] = ((sx, sy, 0.42), (sx, sy, 0.2), parent, True)
            out[f"leg_{end}_lower.{side}"] = ((sx, sy, 0.2), (sx, sy - 0.03, 0.0), up, True)
    return out


QUADRUPED: dict[str, Bone] = {**_SPINE, **_legs()}

DRAGON: dict[str, Bone] = {
    **QUADRUPED,
    "wing.L": ((0.12, 0.0, 0.62), (0.45, 0.08, 0.8), "chest", True),
    "wing.R": ((-0.12, 0.0, 0.62), (-0.45, 0.08, 0.8), "chest", True),
}

BIRD: dict[str, Bone] = {
    "root": ((0, 0, 0), (0, 0, 0.1), None, False),
    "hips": ((0, 0.05, 0.12), (0, 0.0, 0.4), "root", True),
    "chest": ((0, 0.0, 0.4), (0, -0.04, 0.6), "hips", True),
    "neck": ((0, -0.04, 0.6), (0, -0.06, 0.68), "chest", True),
    "head": ((0, -0.06, 0.68), (0, -0.06, 0.98), "neck", True),
    "jaw": ((0, -0.22, 0.74), (0, -0.48, 0.7), "head", True),
    "wing.L": ((0.3, 0.02, 0.6), (0.42, 0.18, 0.25), "chest", True),
    "wing.R": ((-0.3, 0.02, 0.6), (-0.42, 0.18, 0.25), "chest", True),
    "tail1": ((0, 0.3, 0.22), (0, 0.45, 0.05), "hips", True),
    "leg.L": ((0.1, 0.0, 0.14), (0.1, -0.06, 0.0), "hips", True),
    "leg.R": ((-0.1, 0.0, 0.14), (-0.1, -0.06, 0.0), "hips", True),
}

# The drone is a rigid shell: one deform bone. Talk is shown by the visor bars.
ROBOT: dict[str, Bone] = {
    "root": ((0, 0, 0), (0, 0, 0.1), None, False),
    "body": ((0, 0, 0.1), (0, 0, 0.9), "root", True),
    "head": ((0, 0, 0.9), (0, 0, 1.0), "body", False),
}

FAMILIES: dict[str, dict[str, Bone]] = {
    "quadruped": QUADRUPED,
    "dragon": DRAGON,
    "bird": BIRD,
    "robot": ROBOT,
}
