#!/usr/bin/env python3
"""
jsproxy benchmark: compares JS (Node.js) vs Rust proxy performance.

Prerequisites:
  - wrk installed (sudo apt install wrk)
  - Node.js installed (for JS version)
  - Rust binary built (cd rust && cargo build --release)

Usage:
  python3 scripts/bench.py [--duration 10] [--connections 100] [--threads 4]

Results saved to docs/bench/{datetime}/report.md
"""

import argparse
import datetime
import os
import platform
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).parent.parent.resolve()
DOCS_BENCH = ROOT / "docs" / "bench"

# ── Utilities ─────────────────────────────────────────────────────────────────

def find_free_port(start=20000):
    for p in range(start, start + 2000):
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

def http_get_with_host(url, host_header, timeout=5):
    req = urllib.request.Request(url, headers={"Host": host_header})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()
    except Exception as e:
        return None, str(e)

def check_wrk():
    if not shutil.which("wrk"):
        print("ERROR: 'wrk' not found. Install it with:  sudo apt install wrk")
        sys.exit(1)

def run_wrk(url, duration, connections, threads, host_header=None):
    """Run wrk and return parsed stats dict, or None on failure."""
    cmd = [
        "wrk",
        f"-t{threads}",
        f"-c{connections}",
        f"-d{duration}s",
        "--latency",
    ]
    if host_header:
        cmd += ["-H", f"Host: {host_header}"]
    cmd.append(url)

    try:
        out = subprocess.check_output(cmd, stderr=subprocess.STDOUT, timeout=duration + 30)
        return parse_wrk_output(out.decode())
    except subprocess.CalledProcessError as e:
        print(f"  wrk error: {e.output.decode()[:300]}")
        return None
    except subprocess.TimeoutExpired:
        print("  wrk timed out")
        return None

def parse_wrk_output(text):
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
    stats["errors"] = int(m.group(1)) if m else 0

    return stats

# ── Echo backend ──────────────────────────────────────────────────────────────

ECHO_BACKEND_JS = """
const http = require('http');
const port = parseInt(process.argv[2]) || 9999;
const server = http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type': 'text/plain', 'Content-Length': '2'});
  res.end('OK');
});
server.listen(port, '127.0.0.1', () => process.stderr.write('ready\\n'));
"""

def start_echo_backend(port):
    script = tempfile.NamedTemporaryFile(mode='w', suffix='.js', delete=False)
    script.write(ECHO_BACKEND_JS)
    script.flush()
    proc = subprocess.Popen(
        ["node", script.name, str(port)],
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
    )
    # Wait for "ready" signal or port to open
    deadline = time.time() + 8
    while time.time() < deadline:
        try:
            line = proc.stderr.readline()
            if b"ready" in line:
                break
        except Exception:
            break
    if not wait_for_port(port, timeout=5):
        proc.kill()
        raise RuntimeError(f"Echo backend on port {port} didn't start")
    return proc

# ── Test database ─────────────────────────────────────────────────────────────

def create_test_db(db_path, backend_port):
    """
    Creates a test DB with:
      - '*'   → backend_port   (catch-all, used for simple proxy test)
      - 'bench.local' /api → /v1  (URI rewriting test)
    """
    os.makedirs(os.path.dirname(db_path) or ".", exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS mappings (
            id TEXT PRIMARY KEY,
            domain TEXT NOT NULL,
            front_uri TEXT NOT NULL DEFAULT '',
            back_port INTEGER NOT NULL,
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
    conn.execute("PRAGMA journal_mode=WAL")

    rows = [
        # catch-all domain for simple passthrough
        (str(uuid.uuid4()), "*",           "",    backend_port, ""),
        # path-rewrite: /api/* → /v1/*
        (str(uuid.uuid4()), "bench.local", "api", backend_port, "v1"),
    ]
    conn.executemany(
        "INSERT INTO mappings (id, domain, front_uri, back_port, back_uri) VALUES (?,?,?,?,?)",
        rows
    )
    conn.commit()
    conn.close()

# ── Proxy launchers ───────────────────────────────────────────────────────────

def start_js_proxy(http_port, db_path):
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
        "HTTP_PORT":    str(http_port),
        "ENABLE_HTTPS": "false",
        "DB_PATH":      str(db_path),
        "NODE_ENV":     "development",
        "LOG_LEVEL":    "error",
    })
    proc = subprocess.Popen(
        [node, str(entry)],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        cwd=str(ROOT),
    )
    if not wait_for_port(http_port, timeout=12):
        proc.kill()
        print(f"  SKIP: JS proxy on :{http_port} didn't start in time")
        return None
    return proc

def start_rust_proxy(http_port, db_path):
    release_bin = ROOT / "rust" / "target" / "release" / "rustproxy"
    debug_bin   = ROOT / "rust" / "target" / "debug"   / "rustproxy"
    binary = release_bin if release_bin.exists() else (debug_bin if debug_bin.exists() else None)
    if binary is None:
        print("  SKIP: rustproxy binary not found — run: cd rust && cargo build --release")
        return None

    env = os.environ.copy()
    env.update({
        "HTTP_PORT":    str(http_port),
        "ENABLE_HTTPS": "false",
        "DB_PATH":      str(db_path),
        "RUST_LOG":     "error",
    })
    proc = subprocess.Popen(
        [str(binary)],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    if not wait_for_port(http_port, timeout=10):
        proc.kill()
        print(f"  SKIP: Rust proxy on :{http_port} didn't start in time")
        return None
    return proc

# ── Benchmark scenarios ───────────────────────────────────────────────────────

# (id, path, host_header, description)
SCENARIOS = [
    ("health",       "/health",    None,           "Health check (no backend)"),
    ("simple_proxy", "/",          "anydomain.com","Passthrough proxy (catch-all)"),
    ("path_rewrite", "/api/data",  "bench.local",  "Path rewrite /api → /v1"),
]

def run_scenario(name, proxy_port, path, host_header, duration, connections, threads):
    url = f"http://127.0.0.1:{proxy_port}{path}"
    h = host_header or "127.0.0.1"
    status, body = http_get_with_host(url, h)
    if status != 200:
        print(f"    ✗ Sanity check failed ({url}, Host:{h}): {status} — {body[:100]}")
        return None
    print(f"    ✓ Sanity OK → running wrk {duration}s ×{connections}c ×{threads}t")
    return run_wrk(url, duration, connections, threads, host_header=host_header)

# ── Report generation ─────────────────────────────────────────────────────────

def ratio_str(js_rps, rust_rps):
    if not (js_rps and rust_rps):
        return "N/A"
    r = rust_rps / js_rps
    icon = "🚀" if r > 1.5 else ("✅" if r >= 1.0 else "⚠️")
    return f"{r:.2f}x {icon}"

def fmt(v, fmt_spec=".0f"):
    return f"{v:{fmt_spec}}" if v is not None else "—"

def stats_row(s):
    if s is None:
        return "| — | — | — | — | — | — |"
    rps  = fmt(s.get("req_per_sec"))
    lat  = s.get("latency_avg", "—")
    p50  = s.get("p50", "—")
    p90  = s.get("p90", "—")
    p99  = s.get("p99", "—")
    err  = fmt(s.get("errors", 0), "d")
    return f"| {rps} | {lat} | {p50} | {p90} | {p99} | {err} |"

def generate_report(results, args, ts, backend_port):
    cpu_info = ""
    try:
        cpu_info = subprocess.check_output(
            ["grep", "-m1", "model name", "/proc/cpuinfo"], text=True
        ).split(":")[1].strip()
    except Exception:
        cpu_info = platform.processor()

    lines = [
        "# jsproxy Benchmark Report",
        "",
        f"**Date:** {ts}  ",
        f"**Host:** {platform.node()} ({platform.system()} {platform.machine()})  ",
        f"**CPU:** {cpu_info}  ",
        f"**Logical CPUs:** {os.cpu_count()}  ",
        f"**wrk:** duration={args.duration}s, connections={args.connections}, threads={args.threads}  ",
        f"**JS runtime:** {subprocess.getoutput('node --version')}  ",
        f"**Rust build:** release (LTO enabled)  ",
        "",
        "## Summary",
        "",
        "| Scenario | JS req/s | Rust req/s | Rust/JS |",
        "|----------|----------|------------|---------|",
    ]

    for _, _, _, desc, js_s, rust_s in results:
        js_rps   = js_s.get("req_per_sec")   if js_s   else None
        rust_rps = rust_s.get("req_per_sec") if rust_s else None
        lines.append(
            f"| {desc} | {fmt(js_rps)} | {fmt(rust_rps)} | {ratio_str(js_rps, rust_rps)} |"
        )

    lines += [
        "",
        "> Ratio > 1.0x = Rust faster. Expected: Rust should win on proxy scenarios.",
        "",
        "## Detailed Results",
        "",
        "Columns: `req/s | avg latency | p50 | p90 | p99 | errors`",
        "",
    ]

    for _, _, _, desc, js_s, rust_s in results:
        lines += [
            f"### {desc}",
            "",
            "| Impl | req/s | avg lat | p50 | p90 | p99 | errors |",
            "|------|-------|---------|-----|-----|-----|--------|",
            f"| **JS**   {stats_row(js_s)}",
            f"| **Rust** {stats_row(rust_s)}",
            "",
        ]
        for label, s in [("JS", js_s), ("Rust", rust_s)]:
            if s and s.get("raw"):
                lines += [
                    f"<details><summary>{label} raw wrk output</summary>",
                    "",
                    "```",
                    s["raw"].strip(),
                    "```",
                    "",
                    "</details>",
                    "",
                ]

    lines += [
        "## Architecture Notes",
        "",
        "| | JS | Rust |",
        "|-|----|------|",
        "| Runtime | Node.js cluster (workers) | Tokio async (single process) |",
        "| HTTP lib | http-proxy | Hyper 1.1 |",
        "| DB | sqlite3 (npm) | rusqlite (bundled) |",
        "| TLS | acme-client / node:tls | rustls |",
        "| Auth | ✅ | ✅ (ported) |",
        "| IP allowlist | ✅ | ✅ (ported) |",
        "| Plugin system | ✅ | ❌ |",
        "| Catch-all routing | ✅ | ✅ (ported) |",
        "",
        "---",
        "_Generated by `scripts/bench.py`_",
    ]

    return "\n".join(lines)

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Benchmark jsproxy JS vs Rust")
    parser.add_argument("--duration",    type=int, default=15,  help="wrk duration per run (seconds)")
    parser.add_argument("--connections", type=int, default=100, help="wrk concurrent connections")
    parser.add_argument("--threads",     type=int, default=4,   help="wrk threads")
    parser.add_argument("--warmup",      type=int, default=3,   help="warmup seconds before bench")
    parser.add_argument("--skip-js",     action="store_true")
    parser.add_argument("--skip-rust",   action="store_true")
    args = parser.parse_args()

    check_wrk()

    ts = datetime.datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    report_dir = DOCS_BENCH / ts
    report_dir.mkdir(parents=True, exist_ok=True)

    print(f"╔══════════════════════════════════════════╗")
    print(f"║  jsproxy benchmark  {ts}  ║")
    print(f"╚══════════════════════════════════════════╝")
    print(f"  wrk: {args.duration}s × {args.connections}c × {args.threads}t  |  warmup: {args.warmup}s")
    print()

    # Single shared echo backend
    backend_port = find_free_port(21000)
    print(f"▶ Starting echo backend on :{backend_port} ...")
    backend_proc = start_echo_backend(backend_port)
    print("  OK\n")

    # Shared temp dir for DBs (create once, both proxies read same schema)
    tmpdir = tempfile.mkdtemp(prefix="jsproxy-bench-")
    db_path = os.path.join(tmpdir, "bench.db")
    create_test_db(db_path, backend_port)

    results = []

    for s_id, path, host_hdr, desc in SCENARIOS:
        print(f"══ {desc} {'═' * max(0, 50 - len(desc))}")

        js_stats   = None
        rust_stats = None

        # ── JS ──
        if not args.skip_js:
            js_port = find_free_port(22000)
            print(f"  [JS]   starting on :{js_port} ...")
            js_proc = start_js_proxy(js_port, db_path)
            if js_proc:
                print(f"  [JS]   warming up ({args.warmup}s) ...")
                time.sleep(args.warmup)
                print(f"  [JS]   benchmarking ...")
                js_stats = run_scenario(s_id, js_port, path, host_hdr,
                                        args.duration, args.connections, args.threads)
                js_proc.kill()
                js_proc.wait()
                time.sleep(0.5)

        # ── Rust ──
        if not args.skip_rust:
            rust_port = find_free_port(23000)
            print(f"  [Rust] starting on :{rust_port} ...")
            rust_proc = start_rust_proxy(rust_port, db_path)
            if rust_proc:
                print(f"  [Rust] warming up ({args.warmup}s) ...")
                time.sleep(args.warmup)
                print(f"  [Rust] benchmarking ...")
                rust_stats = run_scenario(s_id, rust_port, path, host_hdr,
                                          args.duration, args.connections, args.threads)
                rust_proc.kill()
                rust_proc.wait()
                time.sleep(0.5)

        # Quick result
        js_rps   = js_stats.get("req_per_sec")   if js_stats   else None
        rust_rps = rust_stats.get("req_per_sec") if rust_stats else None
        print()
        if js_rps:
            print(f"  JS   → {js_rps:>10,.0f} req/s  lat_avg={js_stats.get('latency_avg','?')}  p99={js_stats.get('p99','?')}")
        if rust_rps:
            print(f"  Rust → {rust_rps:>10,.0f} req/s  lat_avg={rust_stats.get('latency_avg','?')}  p99={rust_stats.get('p99','?')}")
        if js_rps and rust_rps:
            print(f"  Ratio: {ratio_str(js_rps, rust_rps)}")
        print()

        results.append((s_id, path, host_hdr, desc, js_stats, rust_stats))

    backend_proc.kill()
    backend_proc.wait()

    report = generate_report(results, args, ts, backend_port)
    report_path = report_dir / "report.md"
    report_path.write_text(report)

    print("╔══════════════════════════════════════════════════════╗")
    print("║  FINAL SUMMARY                                       ║")
    print("╠══════════════════════════════════════════════════════╣")
    print(f"  {'Scenario':<38} {'JS req/s':>10}  {'Rust req/s':>10}  {'Ratio':>8}")
    print(f"  {'─'*38} {'─'*10}  {'─'*10}  {'─'*8}")
    for _, _, _, desc, js_s, rust_s in results:
        js_rps   = js_s.get("req_per_sec")   if js_s   else None
        rust_rps = rust_s.get("req_per_sec") if rust_s else None
        print(f"  {desc:<38} {fmt(js_rps):>10}  {fmt(rust_rps):>10}  {ratio_str(js_rps, rust_rps):>8}")
    print(f"\n  Report → {report_path}")
    print("╚══════════════════════════════════════════════════════╝")

if __name__ == "__main__":
    main()
