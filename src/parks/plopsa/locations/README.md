# Plopsaland De Panne — POI location snapshot

`plopsaland-de-panne.json` maps each POI **title** (exactly as the middleware
feed emits it in `contains[].title`) to a hand-verified `{latitude, longitude}`.

## Why a static snapshot

The Plopsa middleware feed (`/api/points-of-interest`) exposes only
`map_coordinates` — pixel coordinates on the park-map image — not lat/lng. De
Panne, unlike Deutschland, has no pixel→geo transform (`mapCoordinates()`
returns `undefined`), so without this snapshot its rides and restaurants have no
location. The base class prefers this per-title lookup and falls back to the
pixel transform (Deutschland only).

## How the coordinates were derived

1. **Titles** came from the live `points-of-interest` feed (attraction +
   `foods_and_drinks` items).
2. **Seed coordinates** came from Google Places (New) Text Search and the Apple
   Maps Server API, biased to the park and filtered to an in-park bounding box.
   Only name-verified matches were trusted; generic "Plopsaland Belgium" park
   pins were rejected.
3. **Manual pinning** — the remaining rides (kids' rides, food stalls that no
   API indexes precisely) were placed by hand on a satellite basemap, cross-
   referenced against the official parkplan. The website's own marker
   coordinates (`point_x/point_y`, authored against `PLB_Parkplan2026_0.jpg` via
   a Leaflet `imageOverlay`) were used as a visual reference.

## Coverage / maintenance

- 86 of 87 POIs are located. **Merry-go-Round** is intentionally absent — it is
  not shown on the park map.
- Matching folds curly/straight apostrophes and is case-insensitive
  (`lookupPoiLocation` in `../plopsa.ts`).
- POIs Plopsa adds later will land without a location until this file is
  refreshed. To add one, append a `"<exact feed title>": {latitude, longitude}`
  entry.

## Regenerating / refreshing the snapshot

This file was produced with the **[plopsa-pinning-tool](https://github.com/TimBroddin/plopsa-pinning-tool)**
— a three-pane tool (ride list · Apple satellite map · official parkplan
overlay) that seeds coordinates from Google Places + Apple Maps and lets you
place the rest by hand. Use it to refresh this snapshot for a new season or to
add newly-opened POIs, then copy its `data/plopsaland-de-panne.json` output
here.
