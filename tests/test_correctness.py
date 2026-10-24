"""Regression coverage for MST invariants and the observed tied plateau."""
import csv
import json
from pathlib import Path
import numpy as np
import pytest
from scipy.cluster.hierarchy import cophenet
from sklearn.metrics import adjusted_rand_score
from hdbscan._hdbscan_tree import condense_tree, compute_stability, get_clusters
from hdbscan_small import (fit, distances, mutual_reachability, condense, select_eom)
from correctness import audit_mst, audit_lifetimes
from run import baseline


@pytest.mark.parametrize('n',[100,200,500,1000])
def test_real_mst_spans_and_has_independent_minimum_weight(n):
    x=np.load('data/coordinates.npy')[:n]
    result=fit(x)
    assert all(result.stability[c] > 0 for c in result.selected_clusters)
    weights=mutual_reachability(distances(x),result.core_distances)
    check=audit_mst(weights,result.mst)
    assert check['spanning_components']==1
    audit_lifetimes(result)


@pytest.mark.parametrize('x',[np.zeros((20,3)),
                              np.r_[np.zeros((10,3)),np.full((10,3),10.)]])
def test_independent_mst_keeps_true_zero_edges(x):
    result=fit(x,5,2)
    audit_mst(mutual_reachability(distances(x),result.core_distances),result.mst)
    audit_lifetimes(result)


@pytest.mark.parametrize('last_pair',[1,2])
def test_same_level_binary_branches_have_zero_stability(last_pair):
    # Three genuine 2-point components, all joining at distance ten. The binary
    # intermediate cluster dies at its birth lambda and must have zero area.
    pair_roots=[6,7,8]
    last=pair_roots.pop(last_pair)
    h=np.array([[0,1,1,2],[2,3,1,2],[4,5,1,2],
                [pair_roots[0],pair_roots[1],10,4],[9,last,10,6.]])
    c=condense(h,2)
    labels,stability,selected=select_eom(c,6)
    assert stability[7]==0
    assert 7 not in selected
    np.testing.assert_allclose(sorted(stability.values()),[0,.6,1.8,1.8,1.8])
    assert adjusted_rand_score(labels,[0,0,1,1,2,2])==1
    # Deliberately check the exact tied exit, not an arbitrary epsilon interval.
    outgoing=c[c['parent']==7]
    assert np.all(outgoing['lambda_val']==.1)


def test_minimized_earthquake_tied_disagreement():
    fixture=json.loads(Path('tests/fixtures/earthquake_tie.json').read_text())
    ids=fixture['population_indices']
    events=list(csv.DictReader(open('data/events.csv')))
    assert [events[i]['event_id'] for i in ids]==fixture['event_ids']
    x=np.load('data/coordinates.npy')[ids]
    result=fit(x); reference=baseline().fit(x)
    assert len(set(result.labels)-{-1})==fixture['expected_custom_clusters']
    assert np.all(reference.labels_==-1)
    np.testing.assert_allclose(cophenet(result.hierarchy),
                               cophenet(reference.single_linkage_tree_.to_numpy()),atol=1e-9,rtol=0)
    checks=audit_lifetimes(result)
    assert checks['zero_lifetime_branches']==1
    assert checks['positive_intervals_checked']>0
    # The artifact may receive labels under the established >= EOM rule, but
    # cannot manufacture positive lifetime or stability. The other branch has
    # independently verified positive component support after the tied split.
    assert result.stability[22]==0 and 22 in result.selected_clusters
    assert result.stability[23]>0
    c=condense_tree(result.hierarchy,10)
    np.testing.assert_allclose([result.stability[int(k)] for k in compute_stability(c)],
                               list(compute_stability(c).values()))
    reference_on_custom=get_clusters(c,compute_stability(c))[0]
    assert adjusted_rand_score(result.labels,reference_on_custom)==1
    zero_label=result.selected_clusters.index(22)
    assert np.all(reference_on_custom[result.labels==zero_label]>=0)
    ours_on_reference=select_eom(condense(reference.single_linkage_tree_.to_numpy(),10),len(x))[0]
    np.testing.assert_array_equal(ours_on_reference,reference.labels_)
