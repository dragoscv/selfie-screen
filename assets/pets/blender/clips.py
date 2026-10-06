"""Animation library for the procedural pets, per family. Rotations are
authored in ARMATURE space (degrees about the pet's own axes, so one number
means the same thing on every bone); build.py converts them to each bone's
local frame:

  X = pitch: tip of an upright bone tilts forward (pet faces -Y); a bone that
      points down swings its tip backwards; a bone pointing back lifts it.
  Y = roll:  tip of an upright bone tilts to +X (the pet's left).
  Z = yaw:   the face turns to +X (the pet's left).

A key value is (rx, ry, rz) or (rx, ry, rz, dz); dz lifts the bone by a
fraction of pet height (hips/body only, |dz| <= 0.04). Bones not listed in a
key are at rest in that key, so every clip keys every bone (clean
cross-fades). 30 fps. Looping clips end on their first key. SPIN bones
(drone props) rotate linearly 0 -> 90 deg about their own axis per loop.
"""

from __future__ import annotations

Key = dict[str, tuple[float, ...]]
Clip = tuple[int, list[tuple[int, Key]]]

LOOPS = {"idle", "talk", "dance", "sleep", "fly", "walk"}
SPIN = ("prop1", "prop2", "prop3", "prop4")
ORDER = ["idle", "look", "talk", "react", "dance", "sleep", "fly", "walk", "hop", "wave"]


def lr(name: str, left: tuple[float, ...], right: tuple[float, ...] | None = None) -> Key:
    """Mirror a pose onto .L/.R: roll and yaw flip sign on the right side."""
    if right is None:
        right = (left[0], -left[1], -left[2], *left[3:])
    return {f"{name}.L": left, f"{name}.R": right}


def k(*parts: Key) -> Key:
    out: Key = {}
    for p in parts:
        out.update(p)
    return out


def loop(length: int, keys: list[tuple[int, Key]]) -> Clip:
    return (length, keys + [(length, keys[0][1])])


def _none(*_a, **_k) -> Key:
    return {}


# ---------------------------------------------------------------- quadruped

def _legs(fl, fr, bl, br) -> Key:
    """Each arg: (upper pitch, lower pitch) of that leg."""
    out: Key = {}
    for name, (u, lo) in (("front_%s.L", fl), ("front_%s.R", fr), ("back_%s.L", bl), ("back_%s.R", br)):
        out["leg_" + name % "upper"] = (u, 0, 0)
        out["leg_" + name % "lower"] = (lo, 0, 0)
    return out


CROUCH = _legs((-26, 50), (-26, 50), (26, -50), (26, -50))


def quadruped(wings: bool) -> dict[str, Clip]:
    W = (lambda left, right=None: lr("wing", left, right)) if wings else _none
    E = _none if wings else (lambda left, right=None: lr("ear", left, right))
    c: dict[str, Clip] = {}
    c["idle"] = loop(60, [
        (0, k({"chest": (0, 0, 0), "head": (0, 0, 0), "tail1": (6, 0, -12), "tail2": (0, 0, -8),
               "tail3": (0, 0, -6)}, W((0, 6, 0)))),
        (20, k({"chest": (-2, 0, 0), "head": (-2, 4, 3), "tail1": (8, 0, 0), "tail2": (0, 0, 2)}, W((0, 2, 0)))),
        (30, k({"chest": (-3, 0, 0), "head": (-3, 5, 4), "tail1": (8, 0, 12), "tail2": (0, 0, 8),
                "tail3": (0, 0, 6)}, W((0, 0, 0)))),
        (36, k({"chest": (-2, 0, 0), "head": (-2, 4, 3), "tail1": (8, 0, 10), "tail2": (0, 0, 6)},
               E((-22, 0, -14), (0, 0, 0)), W((0, 0, 0)))),
        (42, k({"chest": (-1, 0, 0), "head": (-1, 2, 2), "tail1": (7, 0, 4)}, W((0, 4, 0)))),
    ])
    c["look"] = (90, [
        (0, {}),
        (16, k({"neck": (0, 0, 14), "head": (-4, 6, 34)}, E((-10, 0, 0)))),
        (40, k({"neck": (0, 0, 14), "head": (-6, 8, 36)}, E((-10, 0, 0)))),
        (58, k({"neck": (0, 0, -14), "head": (-4, -6, -34)}, E((-10, 0, 0)))),
        (74, k({"neck": (0, 0, -12), "head": (-2, -6, -30)})),
        (90, {}),
    ])
    c["talk"] = loop(24, [
        (0, {}),
        (5, k({"head": (-6, 3, 2), "jaw": (14, 0, 0), "chest": (-2, 0, 0)}, E((-8, 0, 0)))),
        (12, {"head": (2, 0, 0), "jaw": (2, 0, 0)}),
        (17, k({"head": (-5, -3, -2), "jaw": (11, 0, 0), "chest": (-2, 0, 0)}, E((-6, 0, 0)))),
    ])
    c["react"] = (36, [
        (0, {}),
        (5, k({"hips": (0, 0, 0, -0.03), "chest": (4, 0, 0), "head": (8, 0, 0)}, CROUCH, E((10, 0, 0)),
              W((0, 20, 0)))),
        (11, k({"hips": (0, 0, 0, 0.04), "chest": (-6, 0, 0), "neck": (-10, 0, 0), "head": (-16, 0, 0),
                "jaw": (12, 0, 0), "tail1": (-30, 0, 0), "tail2": (-20, 0, 0)},
               _legs((10, -4), (10, -4), (-10, 6), (-10, 6)), E((-25, 0, -15)), W((0, -55, 0)))),
        (18, k({"hips": (0, 0, 0, 0.02), "neck": (-8, 0, 0), "head": (-12, 4, 6), "tail1": (-20, 0, 0)},
               E((-20, 0, -10)), W((0, -35, 0)))),
        (24, k({"hips": (0, 0, 0, -0.015), "head": (-4, 0, 0)},
               _legs((-12, 24), (-12, 24), (12, -24), (12, -24)))),
        (36, {}),
    ])
    da = k({"hips": (0, 8, 0), "chest": (0, -6, 8), "head": (-4, -10, 8), "tail1": (0, 0, -30),
            "tail2": (0, 0, -20), "tail3": (0, 0, -15)},
           _legs((-40, 50), (0, 0), (0, 0), (0, 0)), E((0, 0, -12), (0, 0, 0)), W((0, -40, 0), (0, 10, 0)))
    db = k({"hips": (0, -8, 0), "chest": (0, 6, -8), "head": (-4, 10, -8), "tail1": (0, 0, 30),
            "tail2": (0, 0, 20), "tail3": (0, 0, 15)},
           _legs((0, 0), (-40, 50), (0, 0), (0, 0)), E((0, 0, 0), (0, 0, 12)), W((0, -10, 0), (0, 40, 0)))
    mid = {"hips": (0, 0, 0, 0.03), "head": (-8, 0, 0), "chest": (-4, 0, 0)}
    c["dance"] = loop(48, [(0, da), (12, mid), (24, db), (36, mid)])
    sa = k({"hips": (0, 0, 0, -0.035), "chest": (6, 0, 0), "neck": (18, 0, 14), "head": (20, 26, 30),
            "tail1": (12, 0, 48), "tail2": (6, 0, 40), "tail3": (0, 0, 32)},
           CROUCH, E((-25, 0, -15)), W((0, 25, 0)))
    sb = k(sa, {"hips": (0, 0, 0, -0.03), "chest": (2, 0, 0), "head": (17, 26, 30)})
    c["sleep"] = loop(90, [(0, sa), (45, sb)])
    fa = k({"chest": (-4, 0, 0), "neck": (-8, 0, 0), "head": (-14, 0, 0),
            "tail1": (-12, 0, 0), "tail2": (-6, 0, 0), "tail3": (-4, 0, 0)},
           _legs((-75, -10), (-75, -10), (75, 10), (75, 10)), E((-40, 0, -10)), W((0, 40, 0)))
    fb = k(fa, {"hips": (0, 0, 0, 0.02), "chest": (-2, 0, 0), "tail1": (-6, 0, 6), "tail2": (-2, 0, 8)},
           _legs((-70, -14), (-70, -14), (70, 14), (70, 14)), E((-46, 0, -12)), W((0, -45, 0)))
    c["fly"] = loop(15, [(0, fa), (8, fb)])
    a, s = 22, 38  # stride pitch, swing knee bend

    def gait(p: float) -> Key:
        def leg(ph: float, back: bool) -> tuple[float, float]:
            ph %= 1.0
            if ph < 0.5:  # stance: foot moves back
                u, lo = -a + 2 * a * (ph / 0.5), 0.0
            else:  # swing: forward with knee bent
                t = (ph - 0.5) / 0.5
                u, lo = a - 2 * a * t, s * (1 - abs(2 * t - 1))
            return (u, -lo if back else lo)
        bob = 0.012 if p % 0.5 < 0.25 else -0.004
        return k({"hips": (0, 3 if p < 0.5 else -3, 0, bob), "head": (2 if p % 0.5 < 0.25 else -2, 0, 0),
                  "tail1": (6, 0, 10 if p < 0.5 else -10), "tail2": (0, 0, 8 if p < 0.5 else -8)},
                 _legs(leg(p, False), leg(p + 0.5, False), leg(p + 0.5, True), leg(p, True)), W((0, 10, 0)))
    c["walk"] = loop(24, [(f, gait(f / 24)) for f in (0, 3, 6, 9, 12, 15, 18, 21)])
    c["hop"] = (18, [
        (0, {}),
        (4, k({"hips": (0, 0, 0, -0.035), "chest": (4, 0, 0), "head": (6, 0, 0)}, CROUCH)),
        (8, k({"hips": (0, 0, 0, 0.04), "chest": (-6, 0, 0), "head": (-10, 0, 0), "tail1": (-24, 0, 0)},
              _legs((-20, 30), (-20, 30), (30, -10), (30, -10)), E((-25, 0, 0)), W((0, -50, 0)))),
        (12, k({"hips": (0, 0, 0, -0.03), "head": (6, 0, 0)}, CROUCH, W((0, 20, 0)))),
        (18, {}),
    ])
    up = k({"chest": (0, -6, 0), "head": (-6, 10, 10)}, _legs((-100, 30), (0, 0), (0, 0), (0, 0)),
           E((-10, 0, 0)), W((0, -60, 0), (0, 0, 0)))
    wl = k(up, {"leg_front_upper.L": (-100, 0, 22), "leg_front_lower.L": (10, 0, 0)}, W((0, -80, 0), (0, 0, 0)))
    wr = k(up, {"leg_front_upper.L": (-100, 0, -18), "leg_front_lower.L": (55, 0, 0)}, W((0, -45, 0), (0, 0, 0)))
    c["wave"] = (36, [(0, {}), (7, up), (13, wl), (19, wr), (25, wl), (31, up), (36, {})])
    return c


# --------------------------------------------------------------------- bird

def bird() -> dict[str, Clip]:
    def W(left, right=None):
        return lr("wing", left, right)

    def E(left, right=None):
        return lr("ear", left, right)

    def L(left, right=None):
        return lr("leg", left, right)

    c: dict[str, Clip] = {}
    c["idle"] = loop(60, [
        (0, {"tail1": (0, 0, -6)}),
        (20, k({"chest": (-3, 0, 0), "head": (-2, 6, 4), "tail1": (0, 0, 2)}, W((0, -4, 0)))),
        (32, k({"chest": (-3, 0, 0), "head": (-2, 8, 6), "tail1": (0, 0, 6)}, W((0, -6, 0)))),
        (38, k({"chest": (-2, 0, 0), "head": (-1, 6, 4), "tail1": (0, 0, 4)}, E((-18, 0, -10), (0, 0, 0)),
               W((0, -4, 0)))),
        (44, k({"chest": (-1, 0, 0), "head": (0, 2, 2)}, W((0, -2, 0)))),
    ])
    c["look"] = (90, [
        (0, {}),
        (14, {"neck": (0, 0, 20), "head": (-4, 8, 50)}),
        (40, {"neck": (0, 0, 20), "head": (-6, 12, 54)}),
        (56, {"neck": (0, 0, -20), "head": (-4, -8, -50)}),
        (74, {"neck": (0, 0, -16), "head": (-2, -6, -44)}),
        (90, {}),
    ])
    c["talk"] = loop(24, [
        (0, {}),
        (5, k({"head": (-8, 4, 3), "jaw": (22, 0, 0), "chest": (-2, 0, 0)}, W((0, -6, 0)))),
        (12, {"head": (3, 0, 0), "jaw": (3, 0, 0)}),
        (17, k({"head": (-6, -4, -3), "jaw": (18, 0, 0), "chest": (-2, 0, 0)}, W((0, -4, 0)))),
    ])
    c["react"] = (36, [
        (0, {}),
        (5, k({"hips": (0, 0, 0, -0.03), "chest": (8, 0, 0), "head": (8, 0, 0)}, L((-20, 0, 0)))),
        (11, k({"hips": (0, 0, 0, 0.04), "chest": (-8, 0, 0), "neck": (-10, 0, 0), "head": (-18, 0, 0),
                "jaw": (16, 0, 0), "tail1": (-20, 0, 0)}, W((0, -100, 0)), E((-20, 0, -20)), L((20, 0, 0)))),
        (18, k({"hips": (0, 0, 0, 0.02), "head": (-12, 6, 8), "jaw": (10, 0, 0)}, W((0, -70, 0)),
               E((-15, 0, -15)))),
        (26, k({"hips": (0, 0, 0, -0.015)}, W((0, -15, 0)))),
        (36, {}),
    ])
    da = k({"hips": (0, 12, 0), "chest": (0, -4, 10), "head": (-6, -14, 10), "tail1": (0, 0, -20)},
           W((0, -60, 0), (0, 15, 0)), L((-10, 0, 0), (10, 0, 0)))
    db = k({"hips": (0, -12, 0), "chest": (0, 4, -10), "head": (-6, 14, -10), "tail1": (0, 0, 20)},
           W((0, -15, 0), (0, 60, 0)), L((10, 0, 0), (-10, 0, 0)))
    mid = k({"hips": (0, 0, 0, 0.035), "head": (-10, 0, 0)}, W((0, -30, 0)))
    c["dance"] = loop(48, [(0, da), (12, mid), (24, db), (36, mid)])
    sa = k({"hips": (0, 0, 0, -0.025), "chest": (8, 0, 0), "neck": (22, 0, 10), "head": (26, 14, 16),
            "tail1": (8, 0, 0)}, W((0, 6, 0)), E((-25, 0, -12)))
    sb = k(sa, {"hips": (0, 0, 0, -0.02), "chest": (4, 0, 0), "head": (24, 14, 16)}, W((0, 3, 0)))
    c["sleep"] = loop(90, [(0, sa), (45, sb)])
    fa = k({"chest": (-6, 0, 0), "head": (-10, 0, 0), "tail1": (-15, 0, 0)},
           W((0, -115, 0)), L((60, 0, 0)), E((-30, 0, -10)))
    fb = k(fa, {"hips": (0, 0, 0, 0.03), "chest": (-2, 0, 0), "head": (-6, 0, 0), "tail1": (-5, 0, 0)},
           W((0, -10, 0)))
    c["fly"] = loop(15, [(0, fa), (7, fb)])

    def step(p: float) -> Key:
        side = 1 if p < 0.5 else -1
        t = (p % 0.5) / 0.5
        lift = 1 - abs(2 * t - 1)
        swing = (-24 * lift, 0, 0)
        back = (8 * lift, 0, 0)
        return k({"hips": (0, 9 * side * lift, 0, 0.015 * lift), "chest": (0, -3 * side * lift, 0),
                  "head": (-4 * lift, -5 * side * lift, 0), "tail1": (0, 0, -12 * side * lift)},
                 W((0, -12 * lift, 0)),
                 {"leg.L": swing if side > 0 else back, "leg.R": swing if side < 0 else back})
    c["walk"] = loop(24, [(f, step(f / 24)) for f in (0, 3, 6, 9, 12, 15, 18, 21)])
    c["hop"] = (18, [
        (0, {}),
        (4, k({"hips": (0, 0, 0, -0.03), "chest": (8, 0, 0)}, L((-25, 0, 0)), W((0, -10, 0)))),
        (8, k({"hips": (0, 0, 0, 0.04), "chest": (-6, 0, 0), "head": (-10, 0, 0), "tail1": (-15, 0, 0)},
              W((0, -80, 0)), L((25, 0, 0)))),
        (12, k({"hips": (0, 0, 0, -0.025), "chest": (6, 0, 0)}, W((0, -30, 0)), L((-15, 0, 0)))),
        (18, {}),
    ])
    up = k({"hips": (0, -6, 0), "head": (-6, 10, 14)}, W((0, -100, 0), (0, 0, 0)))
    wl = k(up, {"wing.L": (-25, -115, 0)})
    wr = k(up, {"wing.L": (25, -90, 0)})
    c["wave"] = (36, [(0, {}), (7, up), (13, wl), (19, wr), (25, wl), (31, up), (36, {})])
    return c


# -------------------------------------------------------------------- robot

def robot() -> dict[str, Clip]:
    c: dict[str, Clip] = {}
    c["idle"] = loop(60, [(0, {}), (20, {"body": (2, 3, 0, 0.03), "head": (-3, 0, 6)}),
                          (40, {"body": (-2, -3, 0, 0.015), "head": (2, 0, -4)})])
    c["look"] = (90, [(0, {}), (16, {"body": (0, 0, 10), "head": (-4, 0, 40)}),
                      (40, {"body": (0, 0, 10), "head": (-8, 0, 42)}),
                      (58, {"body": (0, 0, -10), "head": (-4, 0, -40)}),
                      (74, {"body": (0, 0, -8), "head": (0, 0, -32)}), (90, {})])
    c["talk"] = loop(24, [(0, {}), (6, {"body": (-4, 0, 0, 0.02), "head": (-8, 0, 4)}),
                          (12, {"body": (0, 0, 0, 0.005)}),
                          (18, {"body": (-3, 0, 0, 0.018), "head": (-6, 0, -4)})])
    c["react"] = (36, [(0, {}), (5, {"body": (8, 0, 0, -0.03)}),
                       (11, {"body": (-18, 0, 0, 0.04), "head": (-14, 0, 0)}),
                       (20, {"body": (-8, 6, 0, 0.025), "head": (-8, 0, 10)}),
                       (28, {"body": (3, 0, 0, -0.01)}), (36, {})])
    c["dance"] = loop(48, [(0, {"body": (0, 16, -14), "head": (0, 0, 10)}), (12, {"body": (-6, 0, 0, 0.04)}),
                           (24, {"body": (0, -16, 14), "head": (0, 0, -10)}), (36, {"body": (-6, 0, 0, 0.04)})])
    c["sleep"] = loop(90, [(0, {"body": (10, 0, 0, -0.04), "head": (16, 0, 0)}),
                           (45, {"body": (12, 0, 0, -0.025), "head": (18, 0, 0)})])
    c["fly"] = loop(15, [(0, {"body": (14, 0, 0), "head": (-10, 0, 0)}),
                         (8, {"body": (16, 3, 0, 0.02), "head": (-10, 0, 0)})])
    c["walk"] = loop(24, [(0, {"body": (10, 4, 0), "head": (-8, 0, 0)}),
                          (12, {"body": (10, -4, 0, 0.02), "head": (-8, 0, 0)})])
    c["hop"] = (18, [(0, {}), (4, {"body": (4, 0, 0, -0.03)}), (8, {"body": (-8, 0, 0, 0.04), "head": (-8, 0, 0)}),
                     (12, {"body": (4, 0, 0, -0.02)}), (18, {})])
    c["wave"] = (36, [(0, {}), (7, {"body": (0, 20, 0), "head": (0, 0, 10)}),
                      (14, {"body": (0, -20, 0), "head": (0, 0, -10)}),
                      (21, {"body": (0, 20, 0), "head": (0, 0, 10)}), (28, {"body": (0, -16, 0)}), (36, {})])
    return c


def clips_for(family: str) -> dict[str, Clip]:
    if family == "robot":
        return robot()
    if family == "bird":
        return bird()
    return quadruped(wings=family == "dragon")
