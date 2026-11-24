# iLisboa

Lisbon as a real-scale, low-poly diorama — built procedurally from open data, rendered with three.js.

**Why not Google 3D tiles / AI meshes?** Google's terms forbid deriving 3D from its tiles, and image→mesh AI has no real scale and invents detail. Here every building sits on its real footprint at its real (or estimated) height, so the whole city is consistent, crisp and reproducible.

## How it works

```
Geofabrik OSM extract ──► data/raw/<area>.osm.json.gz      (GitHub Action: fetch-data)
Copernicus GLO-30 DEM ──► data/cache (auto-download)
            │
            ▼  node pipeline/build.mjs <area>
public/tiles/<area>/  manifest.json · t_i_j.glb (1 km tiles, meshopt) · base.glb · water.png · trees.bin
            │
            ▼  Vite + three.js (src/)
```

| Layer | Source | How |
|---|---|---|
| Buildings | OSM footprints, `height` / `building:levels`, `building:part` | Extruded walls; hipped / pyramidal / dome roofs from a straight skeleton (CGAL via wasm); estimated heights where untagged |
| Terrain | Copernicus DEM GLO-30 (DSM) | 3×3 min-filter + blur to strip buildings, 8 m mesh |
| Ground | OSM roads, squares, parks, tram rails | Rasterised 0.5 m → 1 m texture per tile, baked contact AO |
| River | OSM coastline | Flood-fill from the water side of the coastline (cross-checked against the DEM), crisp shared mask for terrain + water |
| Trees | OSM `natural=tree` / `tree_row` + parks | One instanced draw call |

Windows, plinths and eaves are drawn in the building shader from per-wall coordinates — zero extra geometry.

## Commands

```bash
npm i
npm run tiles            # rebuild tiles for baixa-alfama (needs data/raw/*.osm.json.gz)
npm run dev              # http://localhost:5173  (?stats shows fps, #x,y,z,tx,ty,tz = shared view)
npm run build            # static site in dist/ (what Vercel serves)
```

Add an area: append a line to `pipeline/areas.txt`, run the **fetch-data** workflow, then `npm run tiles -- <area>` and open `/?area=<area>`.

Data © OpenStreetMap contributors (ODbL) · Copernicus DEM GLO-30 © DLR/Airbus, provided under COPERNICUS by the European Union and ESA.
