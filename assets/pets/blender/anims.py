"""Shared animation library. A clip is a loop of keyframes; each key maps bone
-> (rx, ry, rz) degrees, or bone -> (rx, ry, rz, dz) where dz lifts the bone
by a fraction of pet height. Bones a family lacks are skipped, so one clip
serves every family. 30 fps; frame 0 and the last frame must match (loop)."""

Key = dict[str, tuple[float, ...]]
Clip = tuple[int, list[tuple[int, Key]]]  # (length in frames, [(frame, key)])

CLIPS: dict[str, Clip] = {
    "idle": (60, [
        (0, {"chest": (0, 0, 0), "head": (0, 0, 0), "tail1": (0, 0, -8), "body": (0, 0, 0, 0.0)}),
        (30, {"chest": (3, 0, 0), "head": (-3, 0, 2), "tail1": (0, 0, 8), "body": (0, 0, 0, 0.04)}),
        (60, {"chest": (0, 0, 0), "head": (0, 0, 0), "tail1": (0, 0, -8), "body": (0, 0, 0, 0.0)}),
    ]),
    "look": (90, [
        (0, {"head": (0, 0, 0), "neck": (0, 0, 0), "body": (0, 0, 0)}),
        (20, {"head": (0, 0, 28), "neck": (0, 0, 10), "body": (0, 0, 20)}),
        (45, {"head": (-6, 0, 28), "neck": (0, 0, 10), "body": (0, 0, 20)}),
        (65, {"head": (0, 0, -22), "neck": (0, 0, -8), "body": (0, 0, -18)}),
        (90, {"head": (0, 0, 0), "neck": (0, 0, 0), "body": (0, 0, 0)}),
    ]),
    "talk": (24, [
        (0, {"head": (0, 0, 0), "jaw": (0, 0, 0), "body": (0, 0, 0)}),
        (6, {"head": (-5, 0, 0), "jaw": (14, 0, 0), "body": (-4, 0, 0)}),
        (12, {"head": (0, 0, 0), "jaw": (2, 0, 0), "body": (0, 0, 0)}),
        (18, {"head": (-4, 0, 0), "jaw": (10, 0, 0), "body": (-3, 0, 0)}),
        (24, {"head": (0, 0, 0), "jaw": (0, 0, 0), "body": (0, 0, 0)}),
    ]),
    "react": (36, [
        (0, {"hips": (0, 0, 0, 0.0), "head": (0, 0, 0), "wing.L": (0, 0, 0), "wing.R": (0, 0, 0), "body": (0, 0, 0, 0.0)}),
        (8, {"hips": (0, 0, 0, 0.25), "head": (-15, 0, 0), "wing.L": (0, -50, 0), "wing.R": (0, 50, 0), "body": (0, 0, 0, 0.3)}),
        (16, {"hips": (0, 0, 0, 0.0), "head": (5, 0, 0), "wing.L": (0, 0, 0), "wing.R": (0, 0, 0), "body": (0, 0, 360, 0.1)}),
        (24, {"hips": (0, 0, 0, 0.12), "head": (-8, 0, 0), "wing.L": (0, -30, 0), "wing.R": (0, 30, 0), "body": (0, 0, 360, 0.15)}),
        (36, {"hips": (0, 0, 0, 0.0), "head": (0, 0, 0), "wing.L": (0, 0, 0), "wing.R": (0, 0, 0), "body": (0, 0, 360, 0.0)}),
    ]),
    "dance": (48, [
        (0, {"chest": (0, 0, 0), "hips": (0, 0, 0), "head": (0, 0, 0), "tail1": (0, 0, 0), "body": (0, 0, 0)}),
        (12, {"chest": (0, 12, 10), "hips": (0, -8, -6), "head": (0, -10, 8), "tail1": (0, 0, 25), "body": (0, 18, 0)}),
        (24, {"chest": (0, 0, 0), "hips": (0, 0, 0), "head": (-8, 0, 0), "tail1": (0, 0, 0), "body": (0, 0, 0)}),
        (36, {"chest": (0, -12, -10), "hips": (0, 8, 6), "head": (0, 10, -8), "tail1": (0, 0, -25), "body": (0, -18, 0)}),
        (48, {"chest": (0, 0, 0), "hips": (0, 0, 0), "head": (0, 0, 0), "tail1": (0, 0, 0), "body": (0, 0, 0)}),
    ]),
    "sleep": (90, [
        (0, {"neck": (25, 0, 0), "head": (20, 0, 12), "chest": (4, 0, 0), "tail1": (0, 0, 30), "body": (10, 0, 0, -0.1)}),
        (45, {"neck": (25, 0, 0), "head": (24, 0, 12), "chest": (7, 0, 0), "tail1": (0, 0, 34), "body": (12, 0, 0, -0.12)}),
        (90, {"neck": (25, 0, 0), "head": (20, 0, 12), "chest": (4, 0, 0), "tail1": (0, 0, 30), "body": (10, 0, 0, -0.1)}),
    ]),
    "fly": (20, [
        (0, {"wing.L": (0, -70, 0), "wing.R": (0, 70, 0), "hips": (0, 0, 0, 0.15), "body": (0, 0, 0, 0.1)}),
        (10, {"wing.L": (0, 35, 0), "wing.R": (0, -35, 0), "hips": (0, 0, 0, 0.2), "body": (0, 0, 0, 0.14)}),
        (20, {"wing.L": (0, -70, 0), "wing.R": (0, 70, 0), "hips": (0, 0, 0, 0.15), "body": (0, 0, 0, 0.1)}),
    ]),
}

STATES = list(CLIPS)
