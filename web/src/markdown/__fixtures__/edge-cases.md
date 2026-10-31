# Edge cases

A paragraph before the setext heading.

Setext heading in flight
========================

The setext heading above is complete; this paragraph arrived after it.

## Wide table in flight

| zone | node | pods | cpu | mem | p99 | errors | age |
| --- | --- | --- | --- | --- | --- | --- | --- |
| eu-west-1a | worker-01 | 42 | 61% | 74% | 0.21s | 0 | 42d |
| eu-west-1b | worker-02 | 38 | 58% | 69% | 0.19s | 1 | 42d |
| eu-west-1c | worker-03 | 51 | 77% | 81% | 1.94s | 14 | 11d |
| us-east-1a | worker-04 | 33 | 44% | 52% | 0.12s | 0 | 42d |
| us-east-1b | worker-05 | 29 | 39% | 47% | 0.11s | 0 | 42d |
| us-east-1c | worker-06 | 31 | 41% | 49% | 0.13s | 0 | 42d |

## Unterminated fence in flight

The next block keeps streaming while the fence is still open.

```bash
kubectl -n prod get pods --field-selector spec.nodeName=worker-02 -o wide | head -1
kubectl -n prod get pods --field-selector spec.nodeName=worker-03 -o wide | head -2
kubectl -n prod get pods --field-selector spec.nodeName=worker-01 -o wide | head -3
kubectl -n prod get pods --field-selector spec.nodeName=worker-02 -o wide | head -4
kubectl -n prod get pods --field-selector spec.nodeName=worker-03 -o wide | head -5
kubectl -n prod get pods --field-selector spec.nodeName=worker-01 -o wide | head -6
kubectl -n prod get pods --field-selector spec.nodeName=worker-02 -o wide | head -7
kubectl -n prod get pods --field-selector spec.nodeName=worker-03 -o wide | head -8
kubectl -n prod get pods --field-selector spec.nodeName=worker-01 -o wide | head -9
kubectl -n prod get pods --field-selector spec.nodeName=worker-02 -o wide | head -10
kubectl -n prod get pods --field-selector spec.nodeName=worker-03 -o wide | head -11
kubectl -n prod get pods --field-selector spec.nodeName=worker-01 -o wide | head -12
kubectl -n prod get pods --field-selector spec.nodeName=worker-02 -o wide | head -13
kubectl -n prod get pods --field-selector spec.nodeName=worker-03 -o wide | head -14
kubectl -n prod get pods --field-selector spec.nodeName=worker-01 -o wide | head -15
kubectl -n prod get pods --field-selector spec.nodeName=worker-02 -o wide | head -16
kubectl -n prod get pods --field-selector spec.nodeName=worker-03 -o wide | head -17
kubectl -n prod get pods --field-selector spec.nodeName=worker-01 -o wide | head -18
```

## Late reference definitions

This paragraph points at [a late reference][late-ref] and [another one][late-ref-2].

[late-ref]: https://example.com/late-reference
[late-ref-2]: https://example.com/another-late-reference
