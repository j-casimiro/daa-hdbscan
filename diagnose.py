"""Explain agreement differences using pinned reference helpers OUTSIDE custom engine."""
import json
from pathlib import Path
import numpy as np
from scipy.cluster.hierarchy import cophenet
from sklearn.metrics import adjusted_rand_score
from hdbscan._hdbscan_tree import condense_tree, compute_stability, get_clusters
from hdbscan_small import fit, condense, select_eom, distances, mutual_reachability
from correctness import audit_mst, audit_lifetimes
from run import SIZES, SETTINGS, baseline


def main():
    x = np.load('data/coordinates.npy'); reports = []
    for n in SIZES:
        a = fit(x[:n], SETTINGS['min_cluster_size'], SETTINGS['min_samples'])
        b = baseline().fit(x[:n])
        # Hold hierarchy constant to isolate downstream correctness from tie ordering.
        ours_on_reference = select_eom(condense(b.single_linkage_tree_.to_numpy(),10), n)[0]
        ref_tree = condense_tree(a.hierarchy, 10)
        reference_on_ours = get_clusters(ref_tree, compute_stability(ref_tree))[0]
        ca, cb = cophenet(a.hierarchy), cophenet(b.single_linkage_tree_.to_numpy())
        report = dict(n=n,
            reference_hierarchy_noise_equal=bool(np.array_equal(b.labels_==-1,ours_on_reference==-1)),
            custom_hierarchy_noise_equal=bool(np.array_equal(a.labels==-1,reference_on_ours==-1)),
            reference_hierarchy_our_stages_ari=adjusted_rand_score(b.labels_,ours_on_reference),
            custom_hierarchy_reference_stages_ari=adjusted_rand_score(a.labels,reference_on_ours),
            cophenetic_max_abs_difference=float(np.max(np.abs(ca-cb))),
            cophenetic_equal_within_1e_9=bool(np.allclose(ca,cb,atol=1e-9,rtol=0)),
            repeated_mst_weights=int(len(a.mst)-len(np.unique(a.mst[:,2]))),
            selected_cluster_stabilities=[dict(cluster_id=c, stability=a.stability[c]) for c in a.selected_clusters],
            zero_stability_selected_clusters=[c for c in a.selected_clusters if a.stability[c] == 0],
            mst_audit=audit_mst(mutual_reachability(distances(x[:n]),a.core_distances),a.mst),
            lifetime_audit=audit_lifetimes(a))
        assert report['reference_hierarchy_our_stages_ari'] == 1
        assert report['custom_hierarchy_reference_stages_ari'] == 1
        assert report['reference_hierarchy_noise_equal'] and report['custom_hierarchy_noise_equal']
        assert report['cophenetic_equal_within_1e_9']
        reports.append(report); print(json.dumps(report), flush=True)
    Path('results/diagnostics.json').write_text(json.dumps(reports,indent=2)+'\n')

if __name__ == '__main__':
    main()
