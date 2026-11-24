"""Convert a (small, bbox-extracted) .osm.pbf into Overpass "out body geom" JSON.
Fallback for when Overpass is down: geofabrik extract -> osmium extract -> this.
usage: python pbf_to_overpass.py in.osm.pbf out.json.gz
"""
import gzip, json, sys
import osmium

src, dst = sys.argv[1], sys.argv[2]
nodes, ways, rels = [], {}, []

class H(osmium.SimpleHandler):
    def node(self, n):
        if len(n.tags):
            nodes.append({"type": "node", "id": n.id, "lat": n.location.lat, "lon": n.location.lon, "tags": dict(n.tags)})
    def way(self, w):
        try:
            geom = [{"lat": nd.lat, "lon": nd.lon} for nd in w.nodes]
        except osmium.InvalidLocationError:
            return
        ways[w.id] = {"type": "way", "id": w.id, "nodes": [nd.ref for nd in w.nodes], "geometry": geom, "tags": dict(w.tags)}
    def relation(self, r):
        if len(r.tags):
            rels.append({"type": "relation", "id": r.id, "tags": dict(r.tags),
                         "members": [{"type": {"n": "node", "w": "way", "r": "relation"}[m.type], "ref": m.ref, "role": m.role} for m in r.members]})

H().apply_file(src, locations=True)
for r in rels:
    for m in r["members"]:
        if m["type"] == "way" and m["ref"] in ways:
            m["geometry"] = ways[m["ref"]]["geometry"]
els = nodes + [w for w in ways.values() if w["tags"]] + rels
with gzip.open(dst, "wt") as f:
    json.dump({"elements": els}, f)
print(f"{len(nodes)} nodes, {len(ways)} ways, {len(rels)} relations -> {dst}")
