# jsproxy Benchmark Report

**Date:** 2026-04-25_10-19-43  
**Platform:** v2202410233941289239 (Linux x86_64)  
**CPUs:** 8  
**wrk config:** duration=15s, connections=100, threads=4

## Summary

| Scenario | JS req/s | Rust req/s | Rust/JS ratio |
|----------|----------|------------|----------------|
| Simple passthrough (no URI rewrite) | SKIP | SKIP | N/A |
| Health endpoint (no backend hit) | 184803 | 148179 | 0.80x ⚠️ |

## Detailed Results

Header: `req/s | avg latency | p50 | p90 | p99 | errors`

### Simple passthrough (no URI rewrite)

| Impl | req/s | avg lat | p50 | p90 | p99 | errors |
|------|-------|---------|-----|-----|-----|--------|
| **JS**   | N/A | N/A | N/A | N/A | N/A | N/A |
| **Rust** | N/A | N/A | N/A | N/A | N/A | N/A |

### Health endpoint (no backend hit)

| Impl | req/s | avg lat | p50 | p90 | p99 | errors |
|------|-------|---------|-----|-----|-----|--------|
| **JS**   |  184803.34 |   666.33us | 479.00us |   0.88ms |   5.13ms |      0 |
| **Rust** |   148179.4 |   684.82us | 502.00us |   1.43ms |   2.04ms |      0 |

<details><summary>JS wrk output</summary>

```
Running 15s test @ http://127.0.0.1:22000/health
  4 threads and 100 connections
  Thread Stats   Avg      Stdev     Max   +/- Stdev
    Latency   666.33us    1.05ms  47.43ms   95.84%
    Req/Sec    46.53k     8.11k   61.14k    65.17%
  Latency Distribution
     50%  479.00us
     75%  600.00us
     90%    0.88ms
     99%    5.13ms
  2780259 requests in 15.04s, 448.10MB read
Requests/sec: 184803.34
Transfer/sec:     29.78MB

```
</details>

<details><summary>Rust wrk output</summary>

```
Running 15s test @ http://127.0.0.1:23001/health
  4 threads and 100 connections
  Thread Stats   Avg      Stdev     Max   +/- Stdev
    Latency   684.82us  543.71us  15.48ms   78.94%
    Req/Sec    37.32k     3.15k   47.19k    68.17%
  Latency Distribution
     50%  502.00us
     75%    0.94ms
     90%    1.43ms
     99%    2.04ms
  2228104 requests in 15.04s, 218.86MB read
Requests/sec: 148179.40
Transfer/sec:     14.56MB

```
</details>

## Notes

- Rust uses Hyper 1.1 + Tokio async runtime (single process)
- JS uses Node.js http-proxy + cluster mode (worker processes)
- Both proxies forward to the same in-process echo backend
- Benchmarks measure end-to-end proxy latency, not just HTTP throughput
- If Rust is slower: something is wrong — file an issue!