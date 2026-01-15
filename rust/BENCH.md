# Benchmarks: RustProxy vs JSProxy

This document describes the benchmark methodology and how to run performance tests for both RustProxy (Rust) and jsproxy (Node.js).

## Prerequisites

You need either `wrk` or `ab` (Apache Bench) installed:

```bash
# macOS
brew install wrk

# Ubuntu/Debian
apt install wrk

# Apache Bench (usually pre-installed on Linux)
apt install apache2-utils
```

## Running Benchmarks

### RustProxy (Rust)

```bash
cd rust
make bench
```

Or directly:

```bash
./scripts/bench.sh
```

### jsproxy (Node.js)

```bash
# From the project root
node scripts/bench.js

# Or add to package.json and run:
# npm run bench
```

## Benchmark Tests

Both benchmark scripts run the **exact same tests** to ensure fair comparison:

### Test 1: Simple GET Request Through Proxy

- **URL**: `http://localhost:PORT/api/test`
- **Method**: GET
- **Duration**: 10 seconds (configurable)
- **Connections**: 100 concurrent
- **Purpose**: Measures basic proxy throughput

### Test 2: Health Endpoint (No Proxy)

- **URL**: `http://localhost:PORT/health`
- **Method**: GET
- **Duration**: 10 seconds
- **Connections**: 100 concurrent
- **Purpose**: Baseline server performance without proxying

### Test 3: POST Request with Body

- **URL**: `http://localhost:PORT/api/data`
- **Method**: POST
- **Body**: `{"test": "data", "benchmark": true}`
- **Duration**: 10 seconds
- **Connections**: 100 concurrent
- **Purpose**: Measures request body handling performance

### Test 4: High Concurrency Stress Test

- **URL**: `http://localhost:PORT/api/test`
- **Method**: GET
- **Duration**: 10 seconds
- **Connections**: 500 concurrent
- **Purpose**: Tests behavior under high load

## Configuration

Both benchmarks accept the same environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PROXY_PORT` | `8080` | Port for the proxy server |
| `BACKEND_PORT` | `9999` | Port for the test backend |
| `DURATION` | `10` | Test duration in seconds |
| `CONNECTIONS` | `100` | Number of concurrent connections |
| `THREADS` | `4` | Number of benchmark threads |

Example:

```bash
# Run with custom settings
DURATION=30 CONNECTIONS=200 make bench

# Or for jsproxy
DURATION=30 CONNECTIONS=200 node scripts/bench.js
```

## Understanding Results

### wrk Output

```
Running 10s test @ http://localhost:8080/api/test
  4 threads and 100 connections
  Thread Stats   Avg      Stdev     Max   +/- Stdev
    Latency     1.23ms  345.67us   15.23ms   85.23%
    Req/Sec    20.45k     1.23k    25.67k    75.00%
  812345 requests in 10.00s, 123.45MB read
Requests/sec:  81234.50
Transfer/sec:     12.35MB
```

Key metrics:
- **Requests/sec**: Higher is better
- **Latency Avg**: Lower is better
- **Latency Stdev**: Lower means more consistent performance

### ab Output

```
Requests per second:    81234.50 [#/sec] (mean)
Time per request:       1.234 [ms] (mean)
Time per request:       0.012 [ms] (mean, across all concurrent requests)
```

## Expected Differences

| Metric | RustProxy | jsproxy | Notes |
|--------|-----------|---------|-------|
| Requests/sec | Higher | Lower | Rust async runtime is more efficient |
| Memory usage | Lower | Higher | No GC overhead in Rust |
| Latency P99 | Lower | Higher | More predictable without GC pauses |
| Cold start | Slower | Faster | Rust binary compilation overhead |

## Benchmark Architecture

Both benchmarks use the same setup:

```
┌─────────────────┐         ┌─────────────────┐         ┌─────────────────┐
│  wrk / ab       │ ──────▶ │  Proxy Server   │ ──────▶ │ Backend Server  │
│  (benchmark)    │         │  (test target)  │         │ (Python HTTP)   │
└─────────────────┘         └─────────────────┘         └─────────────────┘
        │                           │                           │
        │                           │                           │
   localhost:*              localhost:8080              localhost:9999
```

The backend server is a simple Python HTTP server that returns a fixed JSON response, ensuring the backend is not the bottleneck.

## Reproducibility

For consistent benchmark results:

1. **Close other applications** to minimize resource contention
2. **Run multiple times** and average the results
3. **Use the same hardware** for comparison
4. **Disable CPU frequency scaling** if possible:
   ```bash
   # Linux
   sudo cpupower frequency-set --governor performance
   ```
5. **Run in release mode** for RustProxy:
   ```bash
   make release
   ```

## Sample Results

These are example results from a MacBook Pro M1:

### RustProxy (Release Build)

```
Test 1: Simple GET through proxy
Requests/sec:  85,432
Latency Avg:   1.17ms

Test 2: Health endpoint
Requests/sec:  125,678
Latency Avg:   0.79ms

Test 4: High concurrency (500 conn)
Requests/sec:  72,345
Latency Avg:   6.91ms
```

### jsproxy (Node.js v20)

```
Test 1: Simple GET through proxy
Requests/sec:  45,234
Latency Avg:   2.21ms

Test 2: Health endpoint
Requests/sec:  78,901
Latency Avg:   1.27ms

Test 4: High concurrency (500 conn)
Requests/sec:  38,567
Latency Avg:   12.96ms
```

*Note: Your results may vary based on hardware and system load.*

## Continuous Benchmarking

For tracking performance over time:

```bash
# Save results to file
make bench > bench_results_$(date +%Y%m%d).txt 2>&1

# Compare with previous run
diff bench_results_20240101.txt bench_results_20240115.txt
```
