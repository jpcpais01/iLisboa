#!/usr/bin/env bash
# Downloads for the river (run by .github/workflows/fetch-water.yml). Every step logs to probe/ and never fails the job.
cd "$(dirname "$0")"; mkdir -p raw probe
UA='iLisboa diorama (open data)'
# 1. EMODnet bathymetry DTM (~115 m), Tagus estuary + bar. WCS 2.0.1, Lat/Long subsets.
W=https://ows.emodnet-bathymetry.eu/wcs
for cov in emodnet__mean emodnet__mean_2022 emodnet:mean; do
  u="$W?SERVICE=WCS&VERSION=2.0.1&REQUEST=GetCoverage&CoverageId=$cov&SUBSET=Lat(38.55,38.90)&SUBSET=Long(-9.50,-8.85)&FORMAT=image%2Ftiff"
  code=$(curl -s -m 120 -A "$UA" -o raw/bathy.tif -w '%{http_code}' "$u"); echo "$cov $code $(stat -c %s raw/bathy.tif 2>/dev/null) $(file -b raw/bathy.tif)" | tee -a probe/bathy.txt
  if [ "$code" = 200 ] && file -b raw/bathy.tif | grep -qi tiff; then echo "ok $cov" >> probe/bathy.txt; break; fi
  head -c 600 raw/bathy.tif >> probe/bathy.txt; echo >> probe/bathy.txt; rm -f raw/bathy.tif
done
curl -s -m 60 -A "$UA" "$W?SERVICE=WCS&VERSION=2.0.1&REQUEST=DescribeCoverage&CoverageId=emodnet__mean" | head -c 4000 > probe/bathy-describe.xml || true

# 2. Transtejo/Soflusa GTFS: look the feed up in the Mobility Database catalogue (and the national access point)
curl -sfL -m 120 -A "$UA" -o /tmp/feeds.csv https://files.mobilitydatabase.org/feeds_v2.csv || curl -sfL -m 120 -o /tmp/feeds.csv https://bit.ly/catalogs-csv
head -1 /tmp/feeds.csv > probe/gtfs-catalogue.csv
grep -iE 'transtejo|soflusa|ttsl|ferry.*portugal|portugal.*ferr|navegante|tml|transportes metropolitanos' /tmp/feeds.csv >> probe/gtfs-catalogue.csv || true
grep -i ',PT,' /tmp/feeds.csv | cut -c1-300 > probe/gtfs-pt.csv || true
ok=0
for u in $(grep -iE 'transtejo|soflusa|ttsl' /tmp/feeds.csv | grep -oE 'https://[^,"]+\.zip[^,"]*' | sort -u); do
  echo "try $u" >> probe/gtfs.txt
  if curl -sfL -m 120 -A "$UA" -o /tmp/tt.zip "$u" && unzip -l /tmp/tt.zip | grep -q stop_times.txt; then
    mkdir -p raw/ferry && unzip -o -q -j /tmp/tt.zip -d raw/ferry && ok=1; echo "ok $u" >> probe/gtfs.txt; ls -la raw/ferry >> probe/gtfs.txt; break
  fi
done
[ $ok = 0 ] && echo "no Transtejo GTFS found in the catalogue" >> probe/gtfs.txt
true
