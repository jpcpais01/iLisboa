import json, sys
t = int(sys.argv[1]); p = json.load(open('nbprompt.json'))
P = ("The first image is a real aerial photograph of Lisbon, Portugal, assembled from earlier photos of the same helicopter flight. "
     "Some areas are soft, stretched or still look like a 3D render (mostly near the edges and the far distance). "
     "Return the same photograph, pixel-aligned: same camera, same framing, same horizon, nothing zoomed, cropped or moved. Keep its exact colours, light, haze and "
     "every area that is already sharp and real. Re-photograph only the soft, stretched or render-looking areas so the whole picture is equally sharp, real and "
     "hyperrealistic: real roof tiles, windows and shutters, weathered plaster, real trees, cars and water. "
     "The second image is the 3D render of this exact view, the third its exact depth map and the fourth the exact outlines of every building, roof and street: "
     "the geometry must match them. Do not add, remove, move or resize any building or landmark.")
json.dump([{'name': f'c{t:03d}_nb2', 'endpoint': 'fal-ai/nano-banana-2/edit', 'body': {'prompt': P, 'image_urls': [f'@c{t:03d}_photo.jpg', f'@k{t:03d}_render.jpg', f'@k{t:03d}_depth.png', f'@k{t:03d}_edges.png'], 'aspect_ratio': '16:9', 'resolution': '2K', 'output_format': 'jpeg', 'num_images': 1, 'seed': 3}}],
          open(f'/home/claude/iLisboa/vtest/jobsc{t}.json', 'w'), indent=1)
