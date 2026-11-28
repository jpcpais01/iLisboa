import json, sys
t = int(sys.argv[1])
P = ("Turn the first image, a 3D render of Lisbon, Portugal, into a hyperrealistic real aerial photograph. "
     "The fourth image is a real photograph of the same view from a moment earlier in the same helicopter flight, re-projected into this camera (some parts may be soft, stretched or missing): "
     "the result must match it — the same roofs, colours, materials, trees, light, haze and photographic look wherever it shows them — and be equally sharp and real everywhere. "
     "Same camera, same framing, same field of view: a pixel-aligned photo, not a new composition. Do not zoom, crop, rotate or extend the view. "
     "The top of the picture is still city all the way to the top edge: no sky, no horizon and no sea there. "
     "Every box in the render is a simplified stand-in for a real old Lisbon building: redraw it as the real building it stands for, with its exact footprint, height and roof outline, "
     "real terracotta roof tiles, chimneys, roof terraces, real windows with shutters and balconies, weathered plaster in real colours, real trees, cars and streets. "
     "Streets, squares, the shoreline and every landmark stay exactly where they are. The second image is the exact depth map and the third the exact outlines of every building, roof and street: follow them.")
json.dump([{'name': f'v{t:03d}_nb2', 'endpoint': 'fal-ai/nano-banana-2/edit', 'body': {'prompt': P, 'image_urls': [f'@k{t:03d}_render.jpg', f'@k{t:03d}_depth.png', f'@k{t:03d}_edges.png', f'@c{t:03d}_photo.jpg'], 'aspect_ratio': '16:9', 'resolution': '2K', 'output_format': 'jpeg', 'num_images': 1, 'seed': 6}}],
          open(f'/home/claude/iLisboa/vtest/jobsv{t}.json', 'w'), indent=1)
