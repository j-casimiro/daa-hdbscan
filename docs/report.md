# DAA architecture and complexity discussion

## Introduction

This project implements HDBSCAN* to group earthquakes by location and depth.
It builds a tree of possible groups based on how closely events are packed together,
selects groups using a stability score, and leaves some events unassigned [1,2].

The proposed implementation uses a full table of distances and clustering steps written in Python/NumPy. The baseline is the `generic` algorithm in Python `hdbscan==0.8.40` [3].
Both implement HDBSCAN*; the comparison concerns their design, storage, and computational
cost. The project does not propose a new clustering algorithm. Stewart and
Al-Khassaweneh [4] provide related implementation background.

The source code is in `hdbscan_small.py`, with the comparison runner in `run.py`.
This report describes the input, architecture, complexity, and evaluation metrics.
The growth tables are theoretical. Batch comparisons and tests check correctness;
runtime and process memory were not measured.

## Basic terms

Clustering means grouping similar records without starting with known group labels.
Here, each record is an earthquake and similarity is based on distance. A cluster is a
group of nearby events. Noise means an event was left outside the selected groups;
it does not mean the event is incorrect.

| Term | Meaning in this project |
|---|---|
| Baseline | The existing library implementation used for comparison |
| Architecture | The steps of the algorithm and how data passes between them |
| Input dimension | The number of values used to describe each event; here, three |
| X, Y, Z coordinates | Positions on three axes at right angles to each other |
| Straight-line distance | Distance directly between two points |
| Matrix | A table of values; the distance matrix has n rows and n columns |
| Density | How closely points are packed together |
| Core distance | Distance to a chosen nearby neighbor; a smaller value indicates a denser neighborhood |
| Mutual reachability | An adjusted distance: the largest of the straight-line distance and the two points' core distances |
| Graph | Points called vertices connected by edges; here, events are vertices and adjusted distances are edge weights |
| Minimum spanning tree (MST) | Edges connecting every vertex without cycles, with the smallest possible total weight |
| Hierarchy | A tree recording how groups merge as the distance threshold increases |
| Remove small branches | Removing branches that are too small to count as clusters |
| Stability | A score based on how many points remain in a cluster and how long they remain as the density threshold changes |
| EOM (Excess of Mass) | The rule that chooses between a cluster's stability and the combined scores of its child clusters |
| Parameter | A setting chosen before running the algorithm, such as the minimum cluster size |
| Metric | In evaluation, a number used to assess results; in the code's `metric` setting, the distance rule |

For points A=(x₁,y₁,z₁) and B=(x₂,y₂,z₂), straight-line distance is
`sqrt((x₁−x₂)² + (y₁−y₂)² + (z₁−z₂)²)`.
For example, A=(0,0,0) and B=(3,4,0) are 5 km apart. The coordinate conversion below
puts the earthquake locations into this three-axis format before distances are calculated.

## Reading the Big-O values

Here n is the number of earthquake events. Time complexity describes how the work grows;
space complexity describes how the required storage grows. The same notation is used
for both, but they describe different quantities.

| Big-O | Name | Example in this project | Growth when n doubles |
|---|---|---|---|
| O(1) | Constant | Number of fixed algorithm settings | Stays the same |
| O(n) | Linear | Number of output labels; one per event | 2× |
| O(n log n) | Linearithmic | Sorting the n−1 MST edges | Slightly more than 2× for the n log n model |
| O(n²) | Quadratic | Full distance table and Prim's connection search | 4× |
| O(n³) | Cubic | Baseline upper bound when the number of remaining groups grows with n | 8× for the n³ model |

The custom implementation has an overall O(n²) time bound and O(n²) space usage.
Its sorting step is O(n log n), but the quadratic steps dominate as n grows.
The baseline's full distance and graph calculations is also quadratic. Its conservative full time bound
is O(n²+c³), where c is the number of groups in the pruned tree; the baseline comparison
below explains this separately. A cubic upper bound does not mean every run takes
cubic work.

For example, increasing n from 100 to 200 increases the distance table from 10,000
to 40,000 entries. At n=1,000, it has 1,000,000 entries. The input still has three
coordinates per event, so d=3 stays fixed. These counts explain the quadratic growth;
they do not predict an exact runtime in seconds. Big-O is an upper bound on growth,
and the doubling factors above describe the listed growth models.

The EOM decision can be written as `best(C)=max(S(C), sum(best(child)))` for a nonroot
cluster C, where S(C) is its stability. This is a dynamic programming recurrence:
solve the child subtrees first, then reuse their scores. The root is excluded from
selection, so its score comes from its children. This decision does not change the
quadratic cost of building the full distance table.

## Input data

Source: [PHIVOLCS earthquake catalog](https://earthquake.phivolcs.dost.gov.ph/), acquired
16 October 2026 (Philippine time). Monthly pages linked from the index were retrieved for
January, February, and March 2026; the script stops after the first complete month reaching
1,000 eligible events. It parsed 4,699 numeric/date-valid rows, removed three exact repeated
bulletin rows, and retained 4,696 distinct bulletin identities across the catalog pages.
No numeric/date rows were rejected. The inclusive box 12–20°N, 118–124°E contains 1,245 events,
with observed Philippine timestamps from 1 January 2026 02:17 to 31 March 2026 21:30.
The selected area covers the Luzon region, including offshore areas and nearby islands.
It does not follow administrative or tectonic boundaries. Counts refer to the saved catalog.

The monthly tables contain Philippine time (UTC+08:00), latitude (degrees north), longitude
(degrees east), depth (km), magnitude, location text, and bulletin links. Magnitude scale is
not normalized: the inspected bulletin identifies Ms, while summary rows simply say Mag.
Time and magnitude are retained for description only. Table timestamps have minute precision;
the inspected bulletin supplies seconds, so no second-level precision is invented in the CSV.

Records are identified by full bulletin filenames. Using only the minute portion would
merge separate events. For example, `2026_0128_0154_B2F` and `2026_0128_0154_B2` describe distant earthquakes near
6.56°N/123.72°E and 17.82°N/120.34°E. The latter bulletin independently confirms the Ilocos Sur
location. Another minute collision is likewise distant and outside the chosen box. These
collisions and all exact duplicates are recorded in `data/audit.json`. There are no ambiguous
same-prefix multiple bulletins within the selected subset. A future conflicting row for the
same full identity stops acquisition rather than silently selecting a revision. We do not
merge distinct nearby events by coordinate equality. Bulletin identity is the best available
identifier for this dataset.

Raw HTML, source URLs, acquisition-day records, and SHA-256 hashes are preserved. Manifest
`recorded_at_utc` records when the source details were saved; initial index/January/sample-bulletin
requests were fetched shortly before registration on the same day. No individual-bulletin
crawl was needed. All PHIVOLCS requests were sequential, separated by at least two seconds;
the reusable fetcher enforces the interval and caches successful responses.

### Coordinates

The source does not state the exact reference system used for locations and depths.
This project treats Earth as a sphere with radius R=6371.0088 km. For latitude phi,
longitude theta (both in radians), and depth h in kilometers:

```
r = R - h
q = [r*cos(phi)*cos(theta), r*cos(phi)*sin(theta), r*sin(phi)]
X = q - mean(q)
```

The first two lines convert location and depth into X, Y, and Z positions. The last line
subtracts the average position to center the data. Moving every point by the same amount
preserves the distances between points. Each event becomes one row of three numbers,
so the input shape is `(n,3)`. Values use `float64`, meaning eight bytes per number.

Distances are measured directly between points in three dimensions, rather than along
Earth's surface. The conversion accounts for Earth's curvature but leaves out its exact
shape, terrain, and errors in the catalog. Depth is treated as distance below the chosen
sphere. These approximations limit the physical meaning of the results; the groups do
not establish fault relationships. The three axes keep the same kilometer scale.

Events are sorted by timestamp/identity, shuffled once by NumPy `default_rng(2026)`, then
the first 100, 200, 500, and 1,000 rows are used. Both engines receive exactly the same coordinate rows in that order.
The full 1,245-event shuffled population is retained for reproducibility; no events are copied
to fill batches. Adding events can change which groups are found.

## Architecture

Both implementations use the same main settings: minimum group size 10 and neighbor
count 5. Distance is measured in a straight line. Alpha is fixed at 1, so the distance
is not rescaled. EOM selects groups by stability. Epsilon is fixed at 0, so no additional
distance-based merging is applied. The root, which represents the whole dataset, cannot
be selected as one group. These settings are examples, not tuned geological values.

The baseline uses its `generic` path with caching, prediction data, and returned MST
output disabled. It builds an exact MST. It still calculates membership strengths
internally, which describe how strongly points belong to their groups.

The custom implementation follows these steps in `hdbscan_small.py`:

1. **Build the distance table — `distances()`.** Use SciPy `cdist` to calculate the
   straight-line distance between every pair of events. Store an n-by-n table.
2. **Find neighbor distances — `core_distances()`.** For each event, find the distance
   to its fifth other neighbor. `np.partition` selects this value without fully sorting
   the row. The event itself occupies the zero-distance position. For small inputs,
   the index is limited to n−1. This follows the baseline source [3]. Equal distances
   are kept unchanged.
3. **Adjust the distances — `mutual_reachability()`.** For events i and j, use
   `max(core[i], core[j], distance[i,j])`. Here `core` contains the neighbor distances
   from step 2. This prevents a point in a sparse area from having a small connection
   weight solely because it is close to one other point. The existing table is reused.
4. **Connect the events — `dense_prim()`.** Prim's greedy algorithm repeatedly adds the
   cheapest connection to an unvisited event. The result is an MST: all events are
   connected, there are no cycles, and the total edge weight is minimum. Equal choices
   use the lowest input row index. The code stores each chosen edge's actual endpoints.
5. **Build the group tree — `single_linkage()`.** Sort the n−1 MST edges by weight and
   merge the connected groups in that order. Store the two child groups, merge weight,
   and group size. Equal-weight edges keep their original order. Each merge joins two
   groups; the baseline may order tied merges differently.
6. **Remove small branches — `condense()`.** If both children meet the minimum size,
   keep both as new groups. If only one meets it, keep that branch under the existing
   group ID and remove the smaller branch. If neither meets it, remove both. Removed
   points are recorded so labels can be assigned later.
7. **Choose groups — `select_eom()`.** Let `lambda=1/weight`. A group appears at one
   lambda value and loses points as lambda increases. Its stability is
   `S(C)=sum((lambda_exit - lambda_birth(C))*child_size)` over its outgoing tree records.
   Here `child_size` is the number of points leaving together. Dynamic programming
   compares a group's score with the combined best scores of its children, starting
   from the bottom of the tree. Equality favors the parent; the root is excluded.
   Zero weight gives infinite lambda. If both birth and exit are infinite, the code
   assigns zero lifetime to avoid an undefined subtraction. This special case may
   differ from the baseline on some inputs.
8. **Assign labels.** Selected groups receive integer IDs; unassigned events receive −1.
   The IDs only identify groups and have no numerical ranking.

The custom module does not call the baseline clustering engine. It supports only the
settings described here. Invalid input shapes, missing or infinite values, fewer than
two points, invalid integer settings, and distances too large to store cause an error.

## Validation

Tests check distance calculations, neighbor selection, MST weight, tree sizes,
small-branch removal, group selection, ties, zero distances, and invalid inputs.
Data tests check event IDs, coordinate conversion, parsing, and saved file checksums.
`diagnose.py` uses baseline helper functions for comparison; the custom algorithm does not.
ARI measures agreement between the two sets of labels and is defined in the metrics section.

| n | Custom / reference clusters | ARI | Noise membership differences | Custom / reference noise fraction |
|---:|---:|---:|---:|---:|
| 100 | 3 / 3 | 1.000000 | 0 | .120 / .120 |
| 200 | 4 / 5 | .834612 | 16 | .095 / .175 |
| 500 | 6 / 7 | .899578 | 12 | .212 / .236 |
| 1,000 | 17 / 19 | .949841 | 23 | .273 / .252 |

The implementations give different group assignments for n greater than 100.
However, for every pair of events, the distance level where they first join the same
group agrees within 1e−9 km (largest observed difference below 4e−12 km).
The MSTs contain 8, 28, 47, and 119 repeated edge weights across the four batches.
Tied edges can be processed in different orders, changing branch sizes and which groups
survive the minimum-size rule.

For example, at n=200, one split gives sizes 95/11 in the custom tree and 94/12 in the
baseline tree. When both group-selection procedures receive the same tree, their labels
and noise assignments match for every batch. `results/diagnostics.json` records these
checks. The difference therefore comes from tied merge order in these cases.
Distances were not changed to force matching results.

### MST and stability checks

`correctness.py` checks MST connectivity, minimum weight, and cluster lifetimes.
It is used by `diagnose.py` and `tests/test_correctness.py`. All 26 tests pass.

| n | Connected components / edges | Custom and independent MST total (km) | Positive intervals checked |
|---:|---:|---:|---:|
| 100 | 1 / 99 | 6435.937830279320 | 56 |
| 200 | 1 / 199 | 8979.739408977857 | 102 |
| 500 | 1 / 499 | 15899.101839846198 | 325 |
| 1,000 | 1 / 999 | 24074.608448582483 | 650 |

The MST checks cover valid endpoints, edge weights, cycles, and connectivity of all n
vertices. Total weights match an independent SciPy Kruskal MST in all four batches.
The validation graph adds one to each weight between different vertices so SciPy
retains connections whose original weight is zero. Since every spanning tree has n−1 edges, this preserves the minimum-weight tree.
Totals are calculated from the original weights using `math.fsum`.

The stability check independently adds the number of remaining points multiplied by
the width of each lambda interval. For every interval with positive width, those points
must form one connected group in the MST. All 1,133 checked intervals pass. The two
ways of calculating stability differ by at most 3.56e−15. No selected cluster in the four full batches has zero stability.

A smaller test case in `tests/fixtures/earthquake_tie.json` contains 21 original
rows from the n=200 batch. At lambda approximately .00553459, the custom hierarchy splits
into two size-ten branches. One dissolves immediately and has zero stability; the other
persists to approximately .00591612 and has stability .003815258431419683. The custom
implementation selects both. The baseline's hierarchy retains the surviving component
as the excluded root and labels all 21 points as noise.

The zero-stability selection follows the EOM rule: select a nonroot cluster when its
stability is greater than or equal to the combined child score. A zero-stability leaf
ties at zero and can therefore be selected. The baseline selector produces the same
labels when given the custom hierarchy. This case shows how tied merge order and root
exclusion can change the final labels.

These checks support MST and stability correctness on the supplied cases. They do not
establish identical group assignments for all inputs. Remaining limitations include tied merge
order, rounding in decimal calculations, and the infinite-lambda rule described above.

## Time, space, and parameter size

Let n be the number of earthquake events passed to the algorithm and d=3 the number of
input features. HDBSCAN* has no learned weights. Both implementations use the settings below.

| Setting | Value in both implementations | Role |
|---|---|---|
| Input dimension d | 3 | Centered X, Y, Z positions in kilometers |
| `min_samples` | 5 | Core-distance neighbor order |
| `min_cluster_size` | 10 | Minimum retained branch size |
| Distance rule / alpha | Straight-line / 1.0 | Use distances without rescaling |
| Group selection / epsilon | EOM / 0.0 | Use stability, with no extra distance-based merging |
| `allow_single_cluster` | False | Exclude selection of the root |

The settings take O(1) space. The input contains 3n float64 values, or 24n bytes.
Neighbor distances and labels each contain n values. The MST, merge tree, and pruned tree
have O(n) rows, while temporary full distance tables require O(n²) space. The baseline also
stores membership strengths and other fitted attributes [3].

| Custom stage | Time bound | Additional storage |
|---|---|---|
| Straight-line distances | O(n²d) | O(n²) |
| Select neighbor distance in each row | O(n²), using NumPy selection [7] | O(n²) temporary table copy |
| Adjust distances in the existing table | O(n²) | O(n) neighbor distances |
| Prim connection search | O(n²) | O(n) vertex and edge lists |
| Sorted MST hierarchy | O(n log n) sorting; O(n²) upper bound for finding group roots | O(n) |
| Remove small branches | O(n) | O(n) |
| EOM and labels | O(n log n) ID sorting, O(n) traversals with expected O(1) dictionary lookups | O(n) |
| Overall, fixed d=3 | O(n²) | O(n²) |

Full sorting of every distance row would add O(n² log n); the implementation does not do
that. Hierarchy construction performs only O(n) finds and each is at most O(n), so its
quadratic upper bound keeps the total within O(n²). This does not establish a speed advantage.

### Baseline comparison

The baseline's `generic` path [3] builds a full distance table, selects neighbor
distances, adjusts the table, builds an MST, and sorts its n−1 edges. These distance
and graph steps take O(n²) time for three input values per event and O(n²) space.
The baseline uses compiled routines for clustering; the custom version uses Python
loops with NumPy operations. Big-O does not show which runs faster in practice.
The custom MST stores actual edge endpoints. The baseline records merge-order edges
and reconstructs endpoints only when MST output is requested.

Some baseline tree operations repeat searches. `_hdbscan_tree.get_clusters` scans the
cluster edge list for each group and can repeatedly call `bfs_from_cluster_tree`, a
breadth-first search that scans the edge list at each tree level. With c groups in the
pruned tree, a conservative bound for those repeated searches is O(c³), assuming
`np.isin` checks the integer IDs in linear time. Other tree operations take at most
O(n²), apart from sorting costs.

The resulting upper bound is O(n²+c³) time and O(n²) space. Since c=O(n), O(n³) is a
conservative time ceiling when c grows with n. This is an upper bound from the loops,
not a measured growth rate or a claim that every input reaches it. This comparison
applies only to version 0.8.40's `generic` path.

### Theoretical growth simulation

`run.py` generates the following **model**, not elapsed seconds or measured process memory.
A single float64 matrix stores 8n² bytes; input stores 24n bytes. Growth is normalized to
n=100. Pair counts are n(n−1)/2, while our full distance matrix evaluates both directions.

| n | n² growth | Unique pairs | Input bytes | One matrix bytes | Two matrix buffers bytes |
|---:|---:|---:|---:|---:|---:|
| 100 | 1× | 4,950 | 2,400 | 80,000 | 160,000 |
| 200 | 4× | 19,900 | 4,800 | 320,000 | 640,000 |
| 500 | 25× | 124,750 | 12,000 | 2,000,000 | 4,000,000 |
| 1,000 | 100× | 499,500 | 24,000 | 8,000,000 | 16,000,000 |

The following table compares the main temporary tables. The custom estimate uses two
float64 matrices. The baseline estimate uses three float64 matrices and one true/false table
during distance adjustment [3]. Float64 values take eight bytes and booleans take
one byte. These estimates exclude other arrays and process overhead.

| n | Custom: two number tables, 16n² bytes | Baseline: three number tables + true/false table, approximately 25n² bytes |
|---:|---:|---:|
| 100 | 160,000 | 250,000 |
| 200 | 640,000 | 1,000,000 |
| 500 | 4,000,000 | 6,250,000 |
| 1,000 | 16,000,000 | 25,000,000 |

Doubling n multiplies both buffer estimates by four. The table compares storage
allocations, not measured memory use or speed. The n² growth factor also describes the
baseline's distance and graph calculations; its tree traversal cost depends on c.

Selecting neighbor distances temporarily holds the original table and a copy, using
about 16n² bytes for these two tables. The check for invalid distances uses an n² table
of true/false values. Distance adjustment reuses the original table. That table is freed
before the later tree steps.

Saved numerical outputs use 24(n−1) bytes for MST edges, 32(n−1) for merge records,
8n each for neighbor distances and labels, and 32 bytes per pruned-tree record.
The number of pruned-tree records is O(n). Python dictionaries, queues, and other
objects add O(n) storage.

During baseline distance adjustment, the original table, an intermediate table, and the
result can exist together, along with a true/false comparison table [3]. This gives the
approximate 25n²-byte estimate above. Neither estimate includes total process memory.
The comparison runner also keeps the population and custom results while the baseline
runs, so its memory use is different from running one algorithm alone.

### Basis of the complexity bounds

The full distance calculations, neighbor selection, distance adjustment, and Prim search
are quadratic. Branch removal visits each kept node and each removed subtree once.
Group selection builds child lists once, sorts group IDs, and visits the tree records
once per pass. Finding group roots during merging involves O(n) searches, each taking
at most O(n) steps. Together, these operations give an O(n²) time upper bound.
The full tables require O(n²) space; the tree structures require O(n).

Validation has separate costs. `correctness.audit_mst` builds a full graph and uses SciPy
Kruskal to sort O(n²) edges, taking O(n² log n) time and O(n²) storage. Checking group
lifetimes can take O(n²) time and storage, and comparing pairwise merge levels uses
O(n²) storage. These checks are excluded from the algorithm's fitting complexity.

## Performance metrics

- **Runtime:** `T=t_end−t_start`, measured with `time.perf_counter` [8]. It shows how
  processing time changes as the catalog grows. A timing comparison should measure only
  fitting, repeat each run, and report the median with hardware and thread settings.
  Runtime was not measured in this project.
- **Peak additional process memory:** `max_t RSS(t)−RSS_before`, measured in a separate
  process for each fit. This shows how much RAM is needed as n grows, which matters for
  the full distance tables used by both implementations [3]. RSS means the process memory currently held in RAM. It includes memory used by
  compiled libraries, which Python-only tracking can miss. Sampling can miss brief peaks.
  Process memory was not measured; the growth tables estimate array storage only.
- **Adjusted Rand index:** make a table where n_ij counts events placed in custom group i and baseline group j.
  Let a_i and b_j be its row and column totals, and choose(k,2)=k(k−1)/2. Then
  let A=sum_ij choose(n_ij,2), B=sum_i choose(a_i,2), C=sum_j choose(b_j,2), N=choose(n,2).
  `ARI=(A−BC/N)/(0.5*(B+C)−BC/N)`, with identical groupings assigned one in special cases where the formula is undefined [5].
  Renaming group IDs does not change ARI. A value of 1 means matching group assignments.
  Here −1 counts as one category, so which events are noise is also checked separately. This measures reference agreement, not geological accuracy;
  all-noise agreement alone is insufficient.
- **Noise proportion:** `p_noise=sum_i 1[label_i=−1]/n`. HDBSCAN* allows points to
  remain unassigned [1–3]. This metric reports how much of the catalog is treated as
  noise and helps explain differences in ARI. A lower noise proportion is not necessarily
  better, since the result depends on density and parameter settings.
- **DBCV:** a density-based cluster quality metric [6]. It assesses how well points connect within groups and how clearly groups are separated, supports arbitrary cluster shapes, and does not require known labels.
  This makes it suitable for earthquake clusters whose geological classes are unknown.
  For nonnoise clusters,
  `DBCV=sum_C (|C|/n)*V(C)`, where
  `V(C)=(min_D DSPC(C,D)−DSC(C))/max(min_D DSPC(C,D),DSC(C))`.
  Here DSC measures the weakest density connection within a group, while DSPC measures
  density separation between groups. Both are calculated using the
  density-adjusted distances defined in [6]. These use distances to all other points in
  a group, unlike the fifth-neighbor rule used for clustering. ARI measures baseline agreement;
  DBCV assesses density quality. Neither establishes a tectonic relationship.
  DBCV is proposed for future evaluation and was not computed. Inputs with fewer than two groups or undefined scores need a stated handling rule. The library's `relative_validity_` is not exact DBCV.

## References and attribution

1. Campello, Moulavi & Sander (2013), *Density-Based Clustering Based on Hierarchical Density
   Estimates*. [DOI](https://doi.org/10.1007/978-3-642-37456-2_14). Only the publisher abstract was available.
2. Campello, Moulavi, Zimek & Sander (2015), *Hierarchical Density Estimates for Data Clustering,
   Visualization, and Outlier Detection*. [DOI](https://doi.org/10.1145/2733381).
   Full text was unavailable; implementation details follow source [3].
3. McInnes and contributors, `hdbscan` 0.8.40:
   [exact source distribution](https://files.pythonhosted.org/packages/source/h/hdbscan/hdbscan-0.8.40.tar.gz),
   specifically `hdbscan_.py`, `_hdbscan_reachability.pyx`, `_hdbscan_linkage.pyx`,
   `_hdbscan_tree.pyx`. [API](https://hdbscan.readthedocs.io/en/latest/api.html) and
   [algorithm explanation](https://hdbscan.readthedocs.io/en/latest/how_hdbscan_works.html).
   Source conventions take precedence over evolving API prose for this project.
4. Stewart & Al-Khassaweneh (2022), *An Implementation of the HDBSCAN* Clustering Algorithm*.
   [DOI](https://doi.org/10.3390/app12052405). Bibliographic context only; no complexity bound
   is borrowed from it. Full text was unavailable.
5. Hubert & Arabie (1985), *Comparing partitions*,
   [DOI](https://doi.org/10.1007/BF01908075);
   [scikit-learn ARI documentation](https://scikit-learn.org/1.6/modules/generated/sklearn.metrics.adjusted_rand_score.html).
6. Moulavi et al. (2014), *Density-Based Clustering Validation*,
   [DOI](https://doi.org/10.1137/1.9781611973440.96). Optional metric; no DBCV result is claimed.
7. [NumPy partition documentation](https://numpy.org/doc/1.26/reference/generated/numpy.partition.html).
8. [Python perf_counter](https://docs.python.org/3.9/library/time.html#time.perf_counter).

The implementation was developed with AI assistance. Core-distance, condensation, stability,
and selection rules follow the reference source [3]. The BSD-3-Clause notice is included
in `HDBSCAN-LICENSE.txt`. Earthquake data are attributed to PHIVOLCS.
