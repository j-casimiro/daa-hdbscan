"""Run identical earthquake prefixes and reproducible theoretical growth tables."""
import csv
import json
import platform
import sys
from importlib.metadata import version
from pathlib import Path
import numpy as np
from hdbscan import HDBSCAN
from joblib import Memory
from sklearn.metrics import adjusted_rand_score
from hdbscan_small import fit

SIZES = (100, 200, 500, 1000)
SETTINGS = dict(min_cluster_size=10, min_samples=5, metric='euclidean', alpha=1.0,
                cluster_selection_method='eom', allow_single_cluster=False,
                cluster_selection_epsilon=0.0, match_reference_implementation=False)

def baseline():
    return HDBSCAN(**SETTINGS, algorithm='generic', memory=Memory(location=None),
                   gen_min_span_tree=False, prediction_data=False, approx_min_span_tree=False,
                   core_dist_n_jobs=1)

def main():
    if version('hdbscan') != '0.8.40':
        raise RuntimeError('Reference semantics require hdbscan==0.8.40')
    out = Path('results'); out.mkdir(exist_ok=True)
    x = np.load('data/coordinates.npy')
    events = list(csv.DictReader(open('data/events.csv')))
    if len(x) != len(events) or len(x) < max(SIZES):
        raise ValueError('Need >=1000 matching real event rows')
    reports = []; growth = []
    for n in SIZES:
        batch = x[:n]
        custom = fit(batch, SETTINGS['min_cluster_size'], SETTINGS['min_samples'])
        reference = baseline().fit_predict(batch)
        ari = adjusted_rand_score(custom.labels, reference)
        mismatch = int(np.count_nonzero((custom.labels == -1) != (reference == -1)))
        report = dict(n=n, ari=ari, noise_membership_disagreements=mismatch,
                      custom_clusters=len(set(custom.labels)-{-1}), reference_clusters=len(set(reference)-{-1}),
                      custom_noise_fraction=float(np.mean(custom.labels == -1)),
                      reference_noise_fraction=float(np.mean(reference == -1)),
                      exact_partition_and_noise=bool(ari == 1 and mismatch == 0))
        reports.append(report); print(json.dumps(report), flush=True)
        np.savez(out/f'batch_{n}.npz', event_ids=np.array([r['event_id'] for r in events[:n]]),
                 custom_labels=custom.labels, reference_labels=reference,
                 mst=custom.mst, hierarchy=custom.hierarchy, condensed=custom.condensed)
        growth.append(dict(n=n, input_bytes=24*n, matrix_bytes=8*n*n,
                           two_matrix_buffers_bytes=16*n*n, quadratic_growth_vs_100=(n/100)**2,
                           pair_distances=n*(n-1)//2, prim_candidate_slots=n*(n-1)))
    with open(out/'growth.csv', 'w', newline='') as f:
        w=csv.DictWriter(f, fieldnames=list(growth[0])); w.writeheader(); w.writerows(growth)
    payload=dict(settings=SETTINGS, baseline_algorithm='generic', baseline_version=version('hdbscan'),
                 python=sys.version, platform=platform.platform(), batches=reports,
                 note='Correctness comparisons only; no runtime or RSS measurements.')
    (out/'comparison.json').write_text(json.dumps(payload, indent=2)+'\n')

if __name__ == '__main__':
    main()
