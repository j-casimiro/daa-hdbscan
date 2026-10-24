"""Small dense HDBSCAN*: NumPy numerical operations, explicit clustering logic.

Semantics informed by hdbscan 0.8.40 (BSD-3-Clause); see docs/HDBSCAN-LICENSE.txt
and docs/report.md. No baseline engine or compiled clustering helpers are called.
Only Euclidean 3D, alpha=1, EOM, epsilon=0, and root exclusion are supported.
"""
from collections import deque
from dataclasses import dataclass
import numpy as np
from scipy.spatial.distance import cdist


def distances(x):
    return cdist(x, x, metric='euclidean')


def core_distances(d, min_samples):
    # Self occupies index zero. Match pinned generic path, including clipping.
    k = min(min_samples, len(d)-1)
    return np.partition(d, k, axis=1)[:, k].copy()


def mutual_reachability(d, core):
    # Reuse distance buffer; no full broadcast tensor (n,n,3).
    np.maximum(d, core[:, None], out=d)
    np.maximum(d, core[None, :], out=d)
    return d


def dense_prim(weights):
    n = len(weights)
    visited = np.zeros(n, dtype=bool)
    best = np.full(n, np.inf)
    parent = np.full(n, -1, dtype=int)
    edges = np.empty((n-1, 3))
    current = 0
    for step in range(n-1):
        visited[current] = True
        improve = (~visited) & (weights[current] < best)
        best[improve] = weights[current, improve]
        parent[improve] = current
        # Equal best weights select the lowest original row index.
        candidate = np.where(visited, np.inf, best)
        nxt = int(np.argmin(candidate))
        edges[step] = parent[nxt], nxt, best[nxt]
        current = nxt
    return edges


def single_linkage(edges):
    n = len(edges)+1
    parents = np.arange(2*n-1)
    sizes = np.ones(2*n-1, dtype=int)
    tree = np.empty((n-1, 4))

    def find(node):
        root = node
        while parents[root] != root:
            root = parents[root]
        while node != root:
            nxt = parents[node]; parents[node] = root; node = nxt
        return root

    # Stable tie ordering retains deterministic Prim insertion order.
    for i, (a, b, weight) in enumerate(edges[np.argsort(edges[:, 2], kind='stable')]):
        a, b = find(int(a)), find(int(b)); node = n+i
        sizes[node] = sizes[a]+sizes[b]
        tree[i] = a, b, weight, sizes[node]
        parents[a] = parents[b] = node
    return tree


CONDENSED = np.dtype([('parent', np.int64), ('child', np.int64),
                       ('lambda_val', np.float64), ('child_size', np.int64)])


def condense(tree, min_cluster_size):
    n = len(tree)+1
    queue = deque([(2*n-2, n)])
    next_cluster = n+1
    rows = []

    def size(node):
        return 1 if node < n else int(tree[node-n, 3])

    def fallout(node, cluster, lam):
        # Each pruned subtree is visited once; no stored descendant lists.
        stack = [node]
        while stack:
            child = stack.pop()
            if child < n:
                rows.append((cluster, child, lam, 1))
            else:
                stack.extend(map(int, tree[child-n, :2]))

    while queue:
        node, cluster = queue.popleft()
        a, b = map(int, tree[node-n, :2]); weight = tree[node-n, 2]
        lam = 1/weight if weight > 0 else np.inf
        sa, sb = size(a), size(b)
        if sa >= min_cluster_size and sb >= min_cluster_size:
            for child, count in ((a, sa), (b, sb)):
                rows.append((cluster, next_cluster, lam, count))
                queue.append((child, next_cluster)); next_cluster += 1
        else:
            for child, count in ((a, sa), (b, sb)):
                if count < min_cluster_size:
                    fallout(child, cluster, lam)
                else:
                    queue.append((child, cluster))
    return np.array(rows, dtype=CONDENSED)


def select_eom(tree, n):
    children = {n: []}; births = {n: 0.0}; outgoing = {}
    for row in tree:
        p, c, lam, count = int(row['parent']), int(row['child']), float(row['lambda_val']), int(row['child_size'])
        outgoing.setdefault(p, []).append((c, lam, count))
        if count > 1:
            births[c] = lam; children.setdefault(p, []).append(c); children[c] = []
    stability = {c: 0.0 for c in births}
    for p, rows in outgoing.items():
        for _, lam, count in rows:
            # Infinite birth and death means zero lifetime, not NaN.
            delta = 0.0 if np.isinf(lam) and np.isinf(births[p]) else lam-births[p]
            stability[p] += count*delta
    best = {}; choose = {}
    for c in sorted(births, reverse=True):
        descendants = sum(best[ch] for ch in children[c])
        choose[c] = c != n and stability[c] >= descendants
        best[c] = stability[c] if choose[c] else descendants
    labels = np.full(n, -1, dtype=int)
    selected = []; stack = [(n, -1)]
    while stack:
        c, label = stack.pop()
        if label == -1 and choose[c]:
            label = len(selected); selected.append(c)
        for child, _, count in outgoing.get(c, []):
            if count == 1:
                labels[child] = label
            else:
                stack.append((child, label))
    return labels, stability, selected


@dataclass
class Result:
    labels: np.ndarray
    core_distances: np.ndarray
    mst: np.ndarray
    hierarchy: np.ndarray
    condensed: np.ndarray
    stability: dict
    selected_clusters: list


def fit(x, min_cluster_size=10, min_samples=5):
    x = np.asarray(x, dtype=np.float64)
    if x.ndim != 2 or x.shape[1] != 3 or len(x) < 2 or not np.isfinite(x).all():
        raise ValueError('X must be finite (n,3), n>=2')
    for name, value, minimum in [('min_cluster_size', min_cluster_size, 2), ('min_samples', min_samples, 1)]:
        if isinstance(value, (bool, np.bool_)) or not isinstance(value, (int, np.integer)) or value < minimum:
            raise ValueError(f'{name} must be an integer >= {minimum}')
    d = distances(x)
    if not np.isfinite(d).all():
        raise ValueError('Euclidean distances overflowed; rescale input')
    core = core_distances(d, min_samples)
    weights = mutual_reachability(d, core)
    mst = dense_prim(weights)
    del weights, d
    hierarchy = single_linkage(mst)
    condensed = condense(hierarchy, min_cluster_size)
    labels, stability, selected = select_eom(condensed, len(x))
    return Result(labels, core, mst, hierarchy, condensed, stability, selected)
