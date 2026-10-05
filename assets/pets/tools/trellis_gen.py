"""Image-to-3D for every concept on the TRELLIS.2 VM (conda env trellis2).
python trellis_gen.py <concepts_dir> <out_dir> parrot=parrot-1 cat=cat-1 ...
Writes <out>/<pet>.glb (decimated, 1024 px textures) and <out>/<pet>.mp4 preview."""

import os
import sys

os.environ["OPENCV_IO_ENABLE_OPENEXR"] = "1"
os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"

import cv2  # noqa: E402
import imageio  # noqa: E402
import o_voxel  # noqa: E402
import torch  # noqa: E402
from PIL import Image  # noqa: E402
from trellis2.pipelines import Trellis2ImageTo3DPipeline  # noqa: E402
from trellis2.renderers import EnvMap  # noqa: E402
from trellis2.utils import render_utils  # noqa: E402

src, out = sys.argv[1], sys.argv[2]
picks = dict(a.split("=", 1) for a in sys.argv[3:])
os.makedirs(out, exist_ok=True)
hdri = cv2.imread("assets/hdri/courtyard.exr", cv2.IMREAD_UNCHANGED)
if hdri is None:  # OpenCV 5 wheels ship without EXR; exr.sh pre-converts via OpenEXR
    import numpy as np
    hdri = np.load("assets/hdri/courtyard.npy")
else:
    hdri = cv2.cvtColor(hdri, cv2.COLOR_BGR2RGB)
envmap = EnvMap(torch.tensor(hdri, dtype=torch.float32, device="cuda"))
pipeline = Trellis2ImageTo3DPipeline.from_pretrained("microsoft/TRELLIS.2-4B")
pipeline.cuda()
for pet, concept in picks.items():
    image = Image.open(os.path.join(src, f"{concept}.png"))
    torch.manual_seed(7)
    mesh = pipeline.run(image)[0]
    mesh.simplify(16777216)
    video = render_utils.make_pbr_vis_frames(render_utils.render_video(mesh, envmap=envmap))
    imageio.mimsave(os.path.join(out, f"{pet}.mp4"), video, fps=15)
    glb = o_voxel.postprocess.to_glb(
        vertices=mesh.vertices, faces=mesh.faces, attr_volume=mesh.attrs, coords=mesh.coords,
        attr_layout=mesh.layout, voxel_size=mesh.voxel_size,
        aabb=[[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
        decimation_target=60000, texture_size=1024,
        remesh=True, remesh_band=1, remesh_project=0, verbose=False,
    )
    glb.export(os.path.join(out, f"{pet}.glb"))
    print("TIKSEE_GEN", pet, flush=True)
    torch.cuda.empty_cache()
print("GEN_DONE", flush=True)
