import numpy as np
import pytest
from scipy.sparse.csgraph import minimum_spanning_tree
from sklearn.metrics import adjusted_rand_score
from hdbscan._hdbscan_tree import condense_tree, compute_stability, get_clusters
from hdbscan_small import (distances, core_distances, mutual_reachability,
                           dense_prim, single_linkage, condense, select_eom, fit)
from run import baseline


def groups(seed=0):
    rng = np.random.default_rng(seed)
    return np.r_[rng.normal(0,.2,(30,3)),rng.normal(5,.2,(30,3)),rng.uniform(-10,10,(10,3))]


def test_distance_core_and_reachability():
    x = np.array([[0.,0,0],[3,4,0],[0,0,12]])
    expected = np.array([[0,5,12],[5,0,13],[12,13,0.]])
    np.testing.assert_allclose(distances(x), expected)
    np.testing.assert_array_equal(core_distances(expected,1),[5,5,12])
    np.testing.assert_array_equal(core_distances(expected,99),[12,13,13])
    actual=mutual_reachability(expected.copy(),np.array([5,5,12]))
    np.testing.assert_array_equal(actual,[[5,5,12],[5,5,13],[12,13,12]])


def test_mst_against_independent_scipy():
    d=distances(groups()); w=mutual_reachability(d,core_distances(d,5))
    edges=dense_prim(w)
    assert len(edges)==len(w)-1
    assert np.isclose(edges[:,2].sum(),minimum_spanning_tree(w).sum())
    for a,b,weight in edges:
        assert w[int(a),int(b)]==weight
    hierarchy=single_linkage(edges)
    assert hierarchy[-1,3]==len(w)
    assert np.all(np.diff(hierarchy[:,2])>=0)


def test_small_branch_falls_out_without_new_cluster():
    # Four points: first three merge at 1/2, fourth joins at 10.
    h=np.array([[0,1,1,2],[4,2,2,3],[5,3,10,4.]])
    c=condense(h,2)
    assert set(c['parent'])=={4}
    assert c[c['child']==3]['lambda_val'][0]==.1
    assert c[c['child']==2]['lambda_val'][0]==.5
    np.testing.assert_array_equal(select_eom(c,4)[0],[-1]*4)


def test_two_groups_and_noise_match():
    x=groups();a=fit(x).labels;b=baseline().fit_predict(x)
    assert len(set(a)-{-1})==2
    assert np.any(a==-1)
    assert adjusted_rand_score(a,b)==1
    np.testing.assert_array_equal(a==-1,b==-1)


@pytest.mark.parametrize('x',[np.zeros((20,3)), np.array([[i,j,0] for i in range(5) for j in range(5)]),
                             np.r_[np.zeros((10,3)),np.full((10,3),10.)]])
def test_ties_zero_distances_deterministic(x):
    a=fit(x,5,2); b=fit(x,5,2)
    np.testing.assert_array_equal(a.labels,b.labels)
    assert not any(np.isnan(list(a.stability.values())))
    # Same binary hierarchy must condense/select like reference, except deliberate inf-inf=0 policy.
    if np.all(a.hierarchy[:,2]>0):
        c=condense_tree(a.hierarchy,5)
        labels=get_clusters(c,compute_stability(c))[0]
        assert adjusted_rand_score(labels,a.labels)==1
    if np.all(x==x[0]):
        assert np.all(a.labels==-1)  # excluded root
    if len(np.unique(x,axis=0))==2:
        assert len(set(a.labels))==2


@pytest.mark.parametrize('seed',range(5))
def test_condensation_and_selection_with_shared_hierarchy(seed):
    a=fit(groups(seed)); c=condense_tree(a.hierarchy,10)
    labels=get_clusters(c,compute_stability(c))[0]
    assert adjusted_rand_score(labels,a.labels)==1
    np.testing.assert_array_equal(labels==-1,a.labels==-1)
    # Compare edge sets independent of traversal order/cluster ID assignment.
    assert len(c)==len(a.condensed)
    assert np.isclose(sum(compute_stability(c).values()),sum(a.stability.values()))


def test_eom_prefers_parent_or_children_by_stability():
    from hdbscan_small import CONDENSED
    # Root -> A (4 points), B (2); A -> two groups (2 each).
    def tree(split):
        return np.array([(6,7,1,4),(6,8,1,2),(7,9,split,2),(7,10,split,2),
                         (8,4,2,1),(8,5,2,1),(9,0,4,1),(9,1,4,1),
                         (10,2,4,1),(10,3,4,1)],dtype=CONDENSED)
    assert set(select_eom(tree(3),6)[2])=={7,8}
    assert set(select_eom(tree(1.5),6)[2])=={8,9,10}
    assert set(select_eom(tree(2.5),6)[2])=={7,8}  # equal stability favors parent


def test_no_selected_cluster_and_invalid_input():
    assert np.all(fit(groups(),1000,5).labels==-1)
    for x in [np.zeros((3,2)),np.zeros((1,3)),np.full((3,3),np.nan)]:
        with pytest.raises(ValueError):fit(x)
    for value in [0,-1,True,1.5]:
        with pytest.raises(ValueError):fit(groups(),min_samples=value)
