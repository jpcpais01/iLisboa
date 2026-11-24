#!/usr/bin/env bash
# Fetch OSM data for a bbox via Overpass (tries several mirrors).
# Usage: pipeline/fetch_osm.sh S W N E out.json.gz
set -euo pipefail
S=$1 W=$2 N=$3 E=$4 OUT=$5
Q="[out:json][timeout:300];
(
  nwr[\"building\"]($S,$W,$N,$E);
  nwr[\"building:part\"]($S,$W,$N,$E);
  way[\"highway\"]($S,$W,$N,$E);
  way[\"railway\"]($S,$W,$N,$E);
  nwr[\"natural\"]($S,$W,$N,$E);
  nwr[\"landuse\"]($S,$W,$N,$E);
  nwr[\"leisure\"]($S,$W,$N,$E);
  nwr[\"place\"]($S,$W,$N,$E);
  nwr[\"waterway\"]($S,$W,$N,$E);
  nwr[\"man_made\"]($S,$W,$N,$E);
  nwr[\"amenity\"]($S,$W,$N,$E);
  nwr[\"historic\"]($S,$W,$N,$E);
  nwr[\"tourism\"]($S,$W,$N,$E);
  way[\"area:highway\"]($S,$W,$N,$E);
);
out body geom;"
for M in https://overpass-api.de/api/interpreter https://overpass.private.coffee/api/interpreter https://maps.mail.ru/osm/tools/overpass/api/interpreter https://overpass.kumi.systems/api/interpreter; do
  echo "trying $M"
  if curl -sf -m 180 --data-urlencode "data=$Q" "$M" -o /tmp/osm.json && head -c 200 /tmp/osm.json | grep -q '"elements"'; then
    gzip -9c /tmp/osm.json > "$OUT"; ls -la "$OUT"; exit 0
  fi
  sleep 5
done
echo "all mirrors failed"; exit 1
