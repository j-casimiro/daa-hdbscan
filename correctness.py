"""Independent correctness audits; never imported by the custom fitting engine."""
import math
import numpy as np
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import minimum_spanning_tree


def audit_mst(weights, edges):
    """Check connectivity/acyclicity and independent SciPy Kruskal objective.

    Add a constant to every off-diagonal edge so true zero edges are not treated
    as absent by SciPy. Every spanning tree has n-1 edges, so the minimizer is
    unchanged mathematically. Sum the chosen ORIGINAL weights, not shifted ones.
    Intended for these finite kilometer-scale inputs, not extreme float ranges.
    """
    n = len(weights)
    assert edges.shape == (n-1, 3)
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for a, b, w in edges:
        assert a == int(a) and b == int(b)
        a, b = int(a), int(b)
        assert 0 <= a < n and 0 <= b < n and a != b
        assert w == weights[a, b]
        ra, rb = find(a), find(b)
        assert ra != rb, 'MST contains a cycle'
        parent[ra] = rb
    components = len({find(i) for i in range(n)})
    assert components == 1
    shifted = weights + 1.0
    np.fill_diagonal(shifted, 0)
    independent = minimum_spanning_tree(csr_matrix(shifted)).tocoo()
    assert independent.nnz == n-1
    reference = math.fsum(float(weights[i, j]) for i, j in zip(independent.row, independent.col))
    actual = math.fsum(float(w) for w in edges[:, 2])
    assert math.isclose(actual, reference, rel_tol=1e-12, abs_tol=1e-9)
    return dict(spanning_components=components, edges=len(edges), custom_total_weight=actual,
                scipy_kruskal_total_weight=reference, absolute_weight_difference=abs(actual-reference))


def audit_lifetimes(result):
    """Integrate stability independently over distinct lambda intervals.

    At an interior point of EVERY positive interval, active members must be one
    actual MST threshold component. Same-level binary refinements cannot create
    an interval or add area. Set materialization is diagnostic-only O(n²) storage
    in the worst case, unlike the production engine's linear tree traversals.
    """
    n = len(result.labels)
    births = {n: 0.0}
    outgoing = {}
    for row in result.condensed:
        p, c, lam, count = (int(row['parent']), int(row['child']),
                             float(row['lambda_val']), int(row['child_size']))
        outgoing.setdefault(p, []).append((c, lam, count))
        if count > 1:
            births[c] = lam
    leaves = {}
    for c in sorted(births, reverse=True):
        leaves[c] = set()
        for child, _, count in outgoing[c]:
            leaves[c].update({child} if count == 1 else leaves[child])
    adjacency = [[] for _ in range(n)]
    for a, b, weight in result.mst:
        a, b = int(a), int(b)
        adjacency[a].append((b, weight)); adjacency[b].append((a, weight))
    zero_rows = zero_branches = checked = 0
    max_error = 0.0
    for c, rows in outgoing.items():
        by_exit = {}
        for child, lam, count in rows:
            assert lam >= births[c], 'negative lifetime'
            zero_rows += int(lam == births[c])
            by_exit.setdefault(lam, set()).update({child} if count == 1 else leaves[child])
        active = leaves[c].copy()
        previous = births[c]
        areas = []
        has_interval = False
        for end in sorted(by_exit):
            if end > previous:
                # Validate support against the graph, not the binary linkage IDs.
                middle = (previous+end)/2 if np.isfinite(end) else previous+max(1.0, previous)
                threshold = 1/middle
                start = next(iter(active)); component = {start}; stack = [start]
                while stack:
                    for other, weight in adjacency[stack.pop()]:
                        if weight < threshold and other not in component:
                            component.add(other); stack.append(other)
                assert component == active, 'positive interval is not a true graph component'
                areas.append(len(active)*(end-previous)); checked += 1; has_interval = True
            active.difference_update(by_exit[end]); previous = end
        expected = math.fsum(areas)
        actual = result.stability[c]
        assert math.isclose(actual, expected, rel_tol=1e-12, abs_tol=1e-10)
        error = 0.0 if actual == expected else abs(actual-expected)
        max_error = max(max_error, error)
        if not has_interval:
            zero_branches += 1
            assert actual == 0, 'zero-lifetime branch has artificial stability'
    return dict(positive_intervals_checked=checked, zero_lifetime_rows=zero_rows,
                zero_lifetime_branches=zero_branches, max_stability_integral_error=max_error)
