"""Generate the offline presentation from saved artifacts; never refit or edit results.

Run: .venv/bin/python generate_results.py
Plotly 2.35.2 is vendored so generation and viewing require no network.
"""
import csv
import hashlib
import html
import json
from pathlib import Path
import re
import numpy as np
from scipy.optimize import linear_sum_assignment
from sklearn.metrics import adjusted_rand_score
from presentation.map_geometry import build_map

ROOT = Path(__file__).resolve().parent
SIZES = (100, 200, 500, 1000)


def read_json(path):
    return json.loads((ROOT/path).read_text())


def align_colors(custom, reference):
    """Maximum-overlap one-to-one assignment, excluding noise; zero matches omitted.

    Raw cluster numbers never determine correspondence. Unmatched reference
    clusters receive new color indices. Colors are local to a batch, not a claim
    that clusters persist across changing sample densities.
    """
    left = sorted(set(custom)-{-1})
    right = sorted(set(reference)-{-1})
    overlap = np.array([[np.count_nonzero((custom == a) & (reference == b))
                         for b in right] for a in left], dtype=int).reshape(len(left), len(right))
    custom_colors = {int(label): i for i, label in enumerate(left)}
    ref_colors = {}
    matches = []
    rows, cols = linear_sum_assignment(-overlap)
    for i, j in zip(rows, cols):
        if overlap[i, j] > 0:
            ref_colors[int(right[j])] = int(i)
            matches.append(dict(custom=int(left[i]), reference=int(right[j]),
                                shared_events=int(overlap[i, j])))
    next_color = len(left)
    for label in right:
        if int(label) not in ref_colors:
            ref_colors[int(label)] = next_color
            next_color += 1
    return dict(custom=custom_colors, reference=ref_colors, matches=matches)


def build_payload():
    report = (ROOT/'docs/report.md').read_text()
    comparison = read_json('results/comparison.json')
    diagnostics = read_json('results/diagnostics.json')
    audit = read_json('data/audit.json')
    with (ROOT/'data/events.csv').open(newline='') as stream:
        events = list(csv.DictReader(stream))
    with (ROOT/'results/growth.csv').open(newline='') as stream:
        growth = [{k: float(v) if k == 'quadratic_growth_vs_100' else int(v)
                   for k, v in row.items()} for row in csv.DictReader(stream)]
    x = np.load(ROOT/'data/coordinates.npy', allow_pickle=False)
    assert len(events) == len(x) == audit['subset_unique']
    assert x.shape[1] == 3 and np.isfinite(x).all()
    assert [r['n'] for r in comparison['batches']] == list(SIZES)
    assert [r['n'] for r in growth] == list(SIZES)
    assert [r['n'] for r in diagnostics] == list(SIZES)
    batches = {}
    for summary, diagnostic, g in zip(comparison['batches'], diagnostics, growth):
        n = summary['n']
        with np.load(ROOT/f'results/batch_{n}.npz', allow_pickle=False) as saved:
            assert np.array_equal(saved['event_ids'], [r['event_id'] for r in events[:n]])
            a, b = saved['custom_labels'], saved['reference_labels']
            assert a.shape == b.shape == (n,)
            assert len(set(a)-{-1}) == summary['custom_clusters']
            assert len(set(b)-{-1}) == summary['reference_clusters']
            assert np.mean(a == -1) == summary['custom_noise_fraction']
            assert np.mean(b == -1) == summary['reference_noise_fraction']
            assert adjusted_rand_score(a, b) == summary['ari']
            mask_diff = int(np.count_nonzero((a == -1) != (b == -1)))
            assert mask_diff == summary['noise_membership_disagreements']
            assert summary['exact_partition_and_noise'] == (summary['ari'] == 1 and mask_diff == 0)
            assert diagnostic['mst_audit']['edges'] == n-1 == len(saved['mst'])
            assert diagnostic['mst_audit']['spanning_components'] == 1
            assert diagnostic['mst_audit']['absolute_weight_difference'] == 0
            assert not diagnostic['zero_stability_selected_clusters']
            assert g['matrix_bytes'] == 8*n*n and g['input_bytes'] == 24*n
            assert g['two_matrix_buffers_bytes'] == 16*n*n
            assert g['quadratic_growth_vs_100'] == (n/SIZES[0])**2
            batches[str(n)] = dict(custom=a.tolist(), reference=b.tolist(),
                                   colors=align_colors(a, b), summary=summary)
    count = re.search(r'All (\d+) tests pass', report)
    assert count, 'Core test count must be recorded in the existing report'
    sources = ['docs/report.md', 'results/comparison.json', 'results/diagnostics.json',
               'results/growth.csv', 'data/audit.json', 'data/events.csv', 'data/coordinates.npy']
    sources += [f'results/batch_{n}.npz' for n in SIZES]
    sources += ['presentation/map/ne_50m_coastline.geojson',
                'presentation/map/ne_50m_populated_places_simple.geojson',
                'presentation/map/provenance.json']
    geography = [[float(r['longitude']),float(r['latitude']),float(r['depth_km'])]
                 for r in events[:max(SIZES)]]
    assert np.isfinite(geography).all() and all(r[2]>=0 for r in geography)
    provenance = read_json('presentation/map/provenance.json')
    for name, entry in provenance['files'].items():
        assert hashlib.sha256((ROOT/'presentation/map'/name).read_bytes()).hexdigest() == entry['sha256']
    return dict(total_events=len(events), baseline_version=comparison['baseline_version'],
                baseline_algorithm=comparison['baseline_algorithm'], settings=comparison['settings'],
                events=[[r['event_id'], float(r['depth_km']), float(r['magnitude']), r['location']]
                        for r in events[:max(SIZES)]], coordinates=x[:max(SIZES)].tolist(),
                period=[audit['first_time'], audit['last_time']], bounds=audit['bounds'],
                batches=batches, growth=growth, diagnostics=diagnostics,
                geographic_coordinates=geography, map=build_map(ROOT,audit['bounds']),
                display=dict(vertical_exaggeration=2, reference_latitude_deg=sum(audit['bounds']['latitude'])/2,
                             sphere_radius_km=6371.0088),
                tests_reported=int(count.group(1)),
                sources={p: hashlib.sha256((ROOT/p).read_bytes()).hexdigest() for p in sources})


def main():
    data = build_payload()
    template = (ROOT/'presentation/results.html.in').read_text()
    bundle = (ROOT/'presentation/vendor/plotly-gl3d-2.35.2.min.js').read_text()
    assert 'v2.35.2' in bundle[:100]
    licenses = '\n\n'.join((ROOT/'presentation/vendor'/name).read_text()
                           for name in ['plotly-LICENSE.txt', 'plotly-third-party-LICENSE.txt'])
    serialized = json.dumps(data, separators=(',', ':'), allow_nan=False).replace('<', '\\u003c')
    replacements = {'__PLOTLY__': bundle.replace('</script', '<\\/script'),
                    '__PAYLOAD__': serialized,
                    '__APP__': (ROOT/'presentation/results.js').read_text(),
                    '__LICENSES__': html.escape(licenses)}
    for key, value in replacements.items():
        assert template.count(key) == 1
        template = template.replace(key, value)
    (ROOT/'results.html').write_text(template)
    print(f'Generated results.html ({len(template.encode()):,} bytes); all four batches checked against saved outputs.')


if __name__ == '__main__':
    main()
