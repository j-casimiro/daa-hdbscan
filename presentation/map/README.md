# Offline geographic display assets

Made with **Natural Earth**, 1:50m coastline and populated-place data, public domain.
These are orientation aids, not survey-grade coastlines or event locations.

- [Coastline dataset](https://www.naturalearthdata.com/downloads/50m-physical-vectors/50m-coastline/)
- [Public-domain terms](https://www.naturalearthdata.com/about/terms-of-use/)
- [Pinned repository release](https://github.com/nvkelso/natural-earth-vector/tree/v5.1.2)
- Exact download URLs, acquisition day, and SHA-256 hashes: `provenance.json`.

`ne_50m_coastline.geojson` and `ne_50m_populated_places_simple.geojson` are preserved as fetched.
The release identifier v5.1.2 describes the repository snapshot, not a claim that every
individual layer has that version number. GeoJSON uses CRS84 longitude/latitude ordering.

`presentation/map_geometry.py` clips the sourced coastline segments to the existing study
box, 118–124°E and 12–20°N. It joins only genuinely consecutive coast segments and does not
invent coastline along the clipping rectangle. City labels use the exact source features
and point coordinates for Manila, Baguio, and Laoag. No city positions or coastlines are drawn
from guessed coordinates. Clipped coast vertices are rounded to six decimal degrees; the
1:50m source itself is generalized and omits some small islands.

The generator embeds these derived lines and labels at **depth = 0 km**. Event longitude,
latitude, and catalog depth come directly from `data/events.csv`; saved metric coordinates
are retained unchanged. Positive depth increases downward. The 0 km plane is a schematic
surface reference; terrain, bathymetry, and an exact catalog depth datum are not supplied.

The manual plot aspect ratio corresponds to **2× vertical exaggeration** relative to
approximate equirectangular horizontal scales at 16°N, using the project's prototype sphere
radius 6371.0088 km: latitude km/degree = R*pi/180; longitude km/degree additionally multiplies
cos(16°). Horizontal ticks remain degrees; vertical ticks remain kilometers. This mixed-unit,
regionally approximated view must not be used to judge physical distances. It does not change
the Euclidean kilometer representation used by clustering.

Run `.venv/bin/python generate_results.py` from the project root to regenerate offline.
