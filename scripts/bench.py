#!/usr/bin/env python3
"""
jsproxy benchmark: compares JS (Node.js) vs Rust proxy performance.

Prerequisites:
  - wrk installed (sudo apt install wrk)
  - Node.js installed (for JS version)
  - Rust binary built (cd rust && cargo build --release)

Usage:
  python3 scripts/bench.py [--duration 10] [--connections 50] [--threads 4]

Results saved to docs/bench/{datetime}/report.md
"""

import argparse
import datetime
import json
import os
import platform
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import urllib.error
from pathlib import Path

ROOT = Path(__file__).parent.parent.resolve()
DOCS_BENCH = ROOT / "docs" / "bench"

# ── Utilities ────────────────────────────────────────────────────────────────

def find_free_port(start=20000):
    for p in range(start, start + 1000):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                continue
    raise RuntimeError("No free port found")

def wait_for_port(port, timeout=10.0, host="127.0.0.1"):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection((host, port), timeout=0.5):
                return True
        except (ConnectionRefusedError, OSError):
            time.sleep(0.1)
    return False

def http_get(url, timeout=5):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return r.status, r.read().decode()
    except Exception as e:
        return None, str(e)

def check_wrk():
    if not shutil.which("wrk"):
        print("ERROR: 'wrk' not found. Install it with:  sudo apt install wrk")
        sys.exit(1)

def run_wrk(url, duration, connections, threads):
    """Run wrk and return parsed stats dict, or None on failure."""
    cmd = [
        "wrk",
        f"-t{threads}",
        f"-c{connections}",
        f"-d{duration}s",
        "--latency",
        url,
    ]
    try:
        out = subprocess.check_output(cmd, stderr=subprocess.STDOUT, timeout=duration + 30)
        return parse_wrk_output(out.decode())
    except subprocess.CalledProcessError as e:
        print(f"  wrk error: {e.output.decode()[:200]}")
        return None
    except subprocess.TimeoutExpired:
        print("  wrk timed out")
        return None

def parse_wrk_output(text):
    """Extract key metrics from wrk output into a dict."""
    import re
    stats = {"raw": text}

    m = re.search(r"Requests/sec:\s+([\d.]+)", text)
    if m: stats["req_per_sec"] = float(m.group(1))

    m = re.search(r"Transfer/sec:\s+([\d.]+\w+)", text)
    if m: stats["transfer_per_sec"] = m.group(1)

    m = re.search(r"Latency\s+([\d.]+)(\w+)\s+([\d.]+)(\w+)\s+([\d.]+)(\w+)", text)
    if m:
        stats["latency_avg"] = f"{m.group(1)}{m.group(2)}"
        stats["latency_stdev"] = f"{m.group(3)}{m.group(4)}"
        stats["latency_max"] = f"{m.group(5)}{m.group(6)}"

    m = re.search(r"50%\s+([\d.]+\w+)", text)
    if m: stats["p50"] = m.group(1)
    m = re.search(r"75%\s+([\d.]+\w+)", text)
    if m: stats["p75"] = m.group(1)
    m = re.search(r"90%\s+([\d.]+\w+)", text)
    if m: stats["p90"] = m.group(1)
    m = re.search(r"99%\s+([\d.]+\w+)", text)
    if m: stats["p99"] = m.group(1)

    m = re.search(r"(\d+) requests in", text)
    if m: stats["total_requests"] = int(m.group(1))

    m = re.search(r"Non-2xx or 3xx responses:\s+(\d+)", text)
    if m: stats["errors"] = int(m.group(1))
    else: stats["errors"] = 0

    return stats

# ── Backend echo server (Node.js) ───────────────────────────────────────────

ECHO_BACKEND_JS = """
const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type': 'text/plain'});
  res.end('OK');
});
server.listen(process.argv[2] || 9999, '127.0.0.1');
"""

def start_echo_backend(port):
    """Start a minimal Node.js echo backend. Returns Popen process."""
    script = tempfile.NamedTemporaryFile(mode='w', suffix='.js', delete=False)
    script.write(ECHO_BACKEND_JS)
    script.flush()
    proc = subprocess.Popen(
        ["node", script.name, str(port)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    if not wait_for_port(port, timeout=5):
        proc.kill()
        raise RuntimeError(f"Echo backend on port {port} didn't start")
    return proc

# ── SQLite DB setup ──────────────────────────────────────────────────────────

def create_test_db(db_path, domain, front_uri, back_port, back_uri=""):
    """Create a minimal SQLite database with a single mapping using Python's sqlite3."""
    import sqlite3, uuid
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS mappings (
            id TEXT PRIMARY KEY,
            domain TEXT NOT NULL,
            front_uri TEXT NOT NULL DEFAULT '',
            back_port TEXT NOT NULL,
            back_uri TEXT NOT NULL DEFAULT '',
            backend TEXT DEFAULT NULL,
            back_ports TEXT DEFAULT NULL,
            allowed_ips TEXT DEFAULT NULL,
            auth_type TEXT DEFAULT NULL,
            auth_credentials TEXT DEFAULT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.execute(
        "INSERT INTO mappings (id, domain, front_uri, back_port, back_uri) VALUES (?,?,?,?,?)",
        (str(uuid.uuid4()), domain, front_uri, str(back_port), back_uri)
    )
    conn.execute("PRAGMA journal_mode=WAL")
    conn.commit()
    conn.close()

# ── Proxy launchers ──────────────────────────────────────────────────────────

def start_js_proxy(http_port, db_path):
    """Start the Node.js proxy. Returns Popen process or None."""
    node = shutil.which("node")
    if not node:
        print("  SKIP: node not found")
        return None

    entry = ROOT / "index.js"
    if not entry.exists():
        print(f"  SKIP: {entry} not found")
        return None

    env = os.environ.copy()
    env.update({
        "HTTP_PORT": str(http_port),
        "ENABLE_HTTPS": "false",
        "DB_PATH": str(db_path),
        "NODE_ENV": "development",
        "LOG_LEVEL": "error",
    })
    proc = subprocess.Popen(
        [node, str(entry)],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        cwd=str(ROOT),
    )
    if not wait_for_port(http_port, timeout=10):
        proc.kill()
        print(f"  SKIP: JS proxy on port {http_port} didn't start in time")
        return None
    return proc

def start_rust_proxy(http_port, db_path):
    """Start the Rust proxy. Returns Popen process or None."""
    release_bin = ROOT / "rust" / "target" / "release" / "rustproxy"
    debug_bin   = ROOT / "rust" / "target" / "debug"  / "rustproxy"

    binary = release_bin if release_bin.exists() else (debug_bin if debug_bin.exists() else None)
    if binary is None:
        print("  SKIP: rustproxy binary not found. Run: cd rust && cargo build --release")
        return None

    env = os.environ.copy()
    env.update({
        "HTTP_PORT": str(http_port),
        "ENABLE_HTTPS": "false",
        "DB_PATH": str(db_path),
        "LOG_LEVEL": "error",
        "RUST_LOG": "error",
    })
    proc = subprocess.Popen(
        [str(binary)],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    if not wait_for_port(http_port, timeout=10):
        proc.kill()
        print(f"  SKIP: Rust proxy on port {http_port} didn't start in time")
        return None
    return proc

# ── Benchmark scenarios ───────────────────────────────────────────────────────

def bench_scenario(name, proxy_port, path, domain, duration, connections, threads):
    url = f"http://127.0.0.1:{proxy_port}{path}"
    # Sanity check: one request must work before we bench
    status, body = http_get(url)
    if status != 200:
        print(f"    Sanity check failed for {url}: status={status} body={body[:80]}")
        return None
    print(f"    Running wrk: {url}")
    return run_wrk(url, duration, connections, threads)

SCENARIOS = [
    # (name, path, description)
    ("simple_proxy",  "/",         "Simple passthrough (no URI rewrite)"),
    ("health_check",  "/health",   "Health endpoint (no backend hit)"),
]

# ── Report generation ─────────────────────────────────────────────────────────

def stats_row(stats):
    if stats is None:
        return "| N/A | N/A | N/A | N/A | N/A | N/A |"
    return (
        f"| {stats.get('req_per_sec', 'N/A'):>10} "
        f"| {stats.get('latency_avg', 'N/A'):>10} "
        f"| {stats.get('p50', 'N/A'):>8} "
        f"| {stats.get('p90', 'N/A'):>8} "
        f"| {stats.get('p99', 'N/A'):>8} "
        f"| {stats.get('errors', 'N/A'):>6} |"
    )

def ratio(js_rps, rust_rps):
    if js_rps and rust_rps and isinstance(js_rps, float) and isinstance(rust_rps, float):
        r = rust_rps / js_rps
        arrow = "🚀" if r > 1.2 else ("✅" if r >= 0.9 else "⚠️")
        return f"{r:.2f}x {arrow}"
    return "N/A"

def generate_report(results, args, ts):
    lines = [
        f"# jsproxy Benchmark Report",
        f"",
        f"**Date:** {ts}  ",
        f"**Platform:** {platform.node()} ({platform.system()} {platform.machine()})  ",
        f"**CPUs:** {os.cpu_count()}  ",
        f"**wrk config:** duration={args.duration}s, connections={args.connections}, threads={args.threads}",
        f"",
        f"## Summary",
        f"",
        f"| Scenario | JS req/s | Rust req/s | Rust/JS ratio |",
        f"|----------|----------|------------|----------------|",
    ]

    for scenario_name, _, description, js_stats, rust_stats in results:
        js_rps = js_stats.get("req_per_sec") if js_stats else None
        rust_rps = rust_stats.get("req_per_sec") if rust_stats else None
        js_s = f"{js_rps:.0f}" if js_rps else "SKIP"
        rust_s = f"{rust_rps:.0f}" if rust_rps else "SKIP"
        r = ratio(js_rps, rust_rps)
        lines.append(f"| {description} | {js_s} | {rust_s} | {r} |")

    lines += [
        f"",
        f"## Detailed Results",
        f"",
        f"Header: `req/s | avg latency | p50 | p90 | p99 | errors`",
        f"",
    ]

    for scenario_name, _, description, js_stats, rust_stats in results:
        lines += [
            f"### {description}",
            f"",
            f"| Impl | req/s | avg lat | p50 | p90 | p99 | errors |",
            f"|------|-------|---------|-----|-----|-----|--------|",
            f"| **JS**   {stats_row(js_stats)}",
            f"| **Rust** {stats_row(rust_stats)}",
            f"",
        ]

        if js_stats and rust_stats:
            lines += [
                f"<details><summary>JS wrk output</summary>",
                f"",
                f"```",
                js_stats.get("raw", ""),
                f"```",
                f"</details>",
                f"",
                f"<details><summary>Rust wrk output</summary>",
                f"",
                f"```",
                rust_stats.get("raw", ""),
                f"```",
                f"</details>",
                f"",
            ]

    lines += [
        f"## Notes",
        f"",
        f"- Rust uses Hyper 1.1 + Tokio async runtime (single process)",
        f"- JS uses Node.js http-proxy + cluster mode (worker processes)",
        f"- Both proxies forward to the same in-process echo backend",
        f"- Benchmarks measure end-to-end proxy latency, not just HTTP throughput",
        f"- If Rust is slower: something is wrong — file an issue!",
    ]

    return "\n".join(lines)

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Benchmark jsproxy JS vs Rust")
    parser.add_argument("--duration",    type=int, default=10,  help="wrk duration in seconds")
    parser.add_argument("--connections", type=int, default=50,  help="wrk concurrent connections")
    parser.add_argument("--threads",     type=int, default=4,   help="wrk threads")
    parser.add_argument("--skip-js",     action="store_true",   help="Skip JS proxy benchmark")
    parser.add_argument("--skip-rust",   action="store_true",   help="Skip Rust proxy benchmark")
    args = parser.parse_args()

    check_wrk()

    ts = datetime.datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    report_dir = DOCS_BENCH / ts
    report_dir.mkdir(parents=True, exist_ok=True)

    print(f"=== jsproxy benchmark {ts} ===")
    print(f"wrk: {args.duration}s, {args.connections} connections, {args.threads} threads")
    print()

    # Start echo backend
    backend_port = find_free_port(21000)
    print(f"Starting echo backend on port {backend_port}...")
    backend_proc = start_echo_backend(backend_port)
    print("  OK")

    tmpdir = tempfile.mkdtemp()

    # Create test databases
    js_db   = os.path.join(tmpdir, "js.db")
    rust_db = os.path.join(tmpdir, "rust.db")
    create_test_db(js_db,   "localhost", "", backend_port)
    create_test_db(rust_db, "localhost", "", backend_port)

    results = []

    for scenario_name, path, description in SCENARIOS:
        print(f"\n─── Scenario: {description} ───")

        js_stats   = None
        rust_stats = None

        # JS proxy
        if not args.skip_js:
            js_port = find_free_port(22000)
            print(f"  Starting JS proxy on port {js_port}...")
            js_proc = start_js_proxy(js_port, js_db)
            if js_proc:
                print("  Warming up JS...")
                time.sleep(1)
                print(f"  Benchmarking JS ({description})...")
                js_stats = bench_scenario(scenario_name, js_port, path, "localhost",
                                          args.duration, args.connections, args.threads)
                js_proc.kill()
                js_proc.wait()

        # Rust proxy
        if not args.skip_rust:
            rust_port = find_free_port(23000)
            print(f"  Starting Rust proxy on port {rust_port}...")
            rust_proc = start_rust_proxy(rust_port, rust_db)
            if rust_proc:
                print("  Warming up Rust...")
                time.sleep(1)
                print(f"  Benchmarking Rust ({description})...")
                rust_stats = bench_scenario(scenario_name, rust_port, path, "localhost",
                                            args.duration, args.connections, args.threads)
                rust_proc.kill()
                rust_proc.wait()

        # Print quick comparison
        if js_stats and rust_stats:
            js_rps = js_stats.get("req_per_sec", 0)
            ru_rps = rust_stats.get("req_per_sec", 0)
            print(f"  JS:   {js_rps:>10.0f} req/s")
            print(f"  Rust: {ru_rps:>10.0f} req/s  ({ratio(js_rps, ru_rps)})")

        results.append((scenario_name, path, description, js_stats, rust_stats))

    # Stop backend
    backend_proc.kill()
    backend_proc.wait()

    # Generate report
    report = generate_report(results, args, ts)
    report_path = report_dir / "report.md"
    report_path.write_text(report)

    print(f"\n=== Done ===")
    print(f"Report saved to: {report_path}")
    print()

    # Print summary table
    print("| Scenario                          | JS req/s | Rust req/s | Ratio |")
    print("|-----------------------------------|----------|------------|-------|")
    for _, _, desc, js_s, rust_s in results:
        js_rps   = js_s.get("req_per_sec") if js_s else None
        rust_rps = rust_s.get("req_per_sec") if rust_s else None
        js_str   = f"{js_rps:.0f}" if js_rps else "SKIP"
        rust_str = f"{rust_rps:.0f}" if rust_rps else "SKIP"
        print(f"| {desc:<33} | {js_str:>8} | {rust_str:>10} | {ratio(js_rps, rust_rps):>5} |")

if __name__ == "__main__":
    main()
