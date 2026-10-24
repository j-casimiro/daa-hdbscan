# HDBSCAN* for earthquake clustering

This DAA project compares a custom HDBSCAN* implementation with the `generic` algorithm
in `hdbscan==0.8.40`. Both use earthquake locations and depths from PHIVOLCS, converted
to three position values (X, Y, and Z) in kilometers.

Start with [the report](docs/report.md) for the discussion or
[results.html](results.html) for the interactive plots. The project includes source code,
complexity estimates, and correctness checks. Runtime and process memory were not measured.

## Start here

The report explains [basic terms](docs/report.md#basic-terms), including Euclidean
(straight-line) distance, clusters, and minimum spanning trees.

For the complexity discussion, start with [Reading the Big-O values](docs/report.md#reading-the-big-o-values).
The custom algorithm is **O(n²), or quadratic**, in both time and space. For example,
doubling the number of events makes its distance table four times larger. Individual
steps also use O(n) (linear) storage and O(n log n) (linearithmic) sorting.

## Where to find each requirement

| Requirement | Documentation | Code and supporting files |
|---|---|---|
| Tentative implementation | [Architecture](docs/report.md#architecture) | [hdbscan_small.py](hdbscan_small.py): custom algorithm; [run.py](run.py): baseline and comparison runner |
| Introduction to the proposed and baseline algorithms | [Introduction](docs/report.md#introduction), [baseline comparison](docs/report.md#baseline-comparison) | `fit()` in [hdbscan_small.py](hdbscan_small.py); `baseline()` in [run.py](run.py) |
| Input dimensions and attribute definitions | [Input data](docs/report.md#input-data), [coordinates](docs/report.md#coordinates) | [events.csv](data/events.csv): catalog attributes; `transform()` in [acquire.py](acquire.py): coordinate conversion; `data/coordinates.npy`: `(n,3)` input |
| Design comparison | [Architecture](docs/report.md#architecture), [baseline comparison](docs/report.md#baseline-comparison) | Stage functions in [hdbscan_small.py](hdbscan_small.py); baseline settings in [run.py](run.py) |
| Time, space, and parameter size | [Complexity and settings](docs/report.md#time-space-and-parameter-size) | Allocations and loops in [hdbscan_small.py](hdbscan_small.py); `SETTINGS` in [run.py](run.py) |
| Simulation as n grows | [Theoretical growth simulation](docs/report.md#theoretical-growth-simulation) | [growth.csv](results/growth.csv); growth calculations in `main()` in [run.py](run.py) |
| Metrics, formulas, suitability, and references | [Performance metrics](docs/report.md#performance-metrics), [references](docs/report.md#references-and-attribution) | ARI and noise calculations in [run.py](run.py); saved values in [comparison.json](results/comparison.json) |

The growth simulation estimates operations and storage for n = 100, 200, 500, and 1,000.
Runtime, peak process memory, and DBCV are described as possible evaluation metrics.
They do not need to be measured for the stated requirements.

## Reading the implementation

In [hdbscan_small.py](hdbscan_small.py), `fit()` calls these stages in order:

1. `distances()` makes a table of straight-line distances between all events.
2. `core_distances()` finds the distance to a chosen neighbor for each event. This helps
   estimate how closely nearby events are packed.
3. `mutual_reachability()` adjusts each pair's distance using those neighbor distances.
4. `dense_prim()` uses a greedy algorithm to connect all events with the smallest total
   adjusted edge weight and no cycles. This is the minimum spanning tree (MST).
5. `single_linkage()` sorts the tree's edges and records how groups merge.
6. `condense()` removes branches below the minimum cluster size.
7. `select_eom()` uses dynamic programming to choose groups based on stability: how many
   points stay in a group and how long they stay as the density threshold changes.
   Unassigned events receive the noise label −1.

The custom module uses NumPy and SciPy for numerical operations. It does not call the
baseline clustering engine. [run.py](run.py) sends the same input rows and settings to
both implementations, then saves their labels and comparison statistics.

## Run locally

Python 3.9 was used for this project (tested with 3.9.6). Install the dependencies first.
A C compiler may be needed if a prebuilt `hdbscan` wheel is unavailable.

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m pytest -q
```

The repository includes the processed data and saved results. To rebuild them from the
cached catalog and rerun the comparisons:

```sh
.venv/bin/python acquire.py --offline
.venv/bin/python run.py
.venv/bin/python diagnose.py
.venv/bin/python generate_results.py
```

`acquire.py --offline` uses the saved PHIVOLCS pages. Without `--offline`, it downloads
missing monthly pages using `curl`, with at least two seconds between requests. Existing
cached pages are reused. `generate_results.py` builds the presentation from saved outputs
without refitting the models.

## Data and validation

The dataset contains 1,245 events within 12–20°N and 118–124°E from January–March 2026.
Only the converted location and depth coordinates are used for clustering. Time, magnitude,
and location text are retained for description.

| Location | Contents |
|---|---|
| [data/raw/](data/raw/) | Cached catalog pages, sample bulletin, and source hashes |
| [data/events.csv](data/events.csv) | Event IDs and catalog attributes |
| `data/coordinates.npy` | Centered float64 coordinates in kilometers |
| [data/audit.json](data/audit.json) | Cleaning counts, bounds, dates, and coordinate assumptions |
| [results/comparison.json](results/comparison.json) | Settings, cluster counts, ARI, and noise proportions |
| `results/batch_*.npz` | Event IDs, labels, and custom trees for each batch |
| [results/diagnostics.json](results/diagnostics.json) | MST, hierarchy, and stability checks |
| [tests/](tests/) | Algorithm, data, and regression tests |
| [correctness.py](correctness.py), [diagnose.py](diagnose.py) | Independent MST and cluster-lifetime checks |

The labels match at n=100. For larger batches, ARI ranges from about 0.835 to 0.950.
Equal-weight merges can produce different binary hierarchies and change cluster selection.
The [validation section](docs/report.md#validation) explains these differences, including
a 21-event regression case with a zero-stability selection.

## View the results

Open [results.html](results.html) in a browser with WebGL enabled. It works offline without
a server. Use **Custom**, **Reference**, or **Comparison** to choose the results, then
select a batch size.

- **Clustering view** shows the coordinates used for fitting, with equal kilometer scales.
  Its Zc axis is a Cartesian coordinate, not catalog depth.
- **Top view** and **3D depth view** show longitude, latitude, and catalog depth. These
  views use 2× vertical exaggeration and mixed units, so use Clustering view to judge distances.
- Drag to rotate or pan, scroll to zoom, and hover over a point for its event details.
  Colors are matched between implementations within each batch; they do not track clusters
  across batch sizes.

The coastline and city labels are a schematic reference at zero depth, without terrain or
bathymetry. Sources are listed in [the map notes](presentation/map/README.md).

Presentation files are in [presentation/](presentation/): `results.html.in` is the template,
`results.js` contains the controls, and `map_geometry.py` prepares the map. Open the generated
root-level `results.html` to view the page.

Optional browser checks require Playwright and Chromium:

```sh
node presentation/check_results.cjs
node presentation/check_hover.cjs
```

Set `RESULTS_CHROME_PATH` to a Chrome executable to use an installed Chrome instead.
These tools are only needed for browser checks.

## Attribution

The implementation was developed with AI assistance. HDBSCAN* rules follow the reference
source listed in [the report](docs/report.md#references-and-attribution); its BSD notice is
included in [docs/HDBSCAN-LICENSE.txt](docs/HDBSCAN-LICENSE.txt). Earthquake data are from
PHIVOLCS. The clusters have not been validated as geological faults or used for forecasting.
