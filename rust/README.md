# RustProxy

A resilient HTTP/HTTPS reverse proxy server written in Rust. This is a 100% compatible port of [jsproxy](../README.md) (Node.js version).

## Features

- **Domain-based routing** with SQLite database mappings
- **Path rewriting** (front_uri → back_uri transformation)
- **HTTPS support** with automatic TLS certificate generation
- **WebSocket proxying** for real-time applications
- **Health check endpoint** (`/health`)
- **ACME challenge handling** for Let's Encrypt integration
- **X-Forwarded-* headers** for proper upstream communication
- **Longest-match-first** routing algorithm

## Quick Start

### Build

```bash
# Debug build
make build

# Release build (optimized)
make release
```

### Run

```bash
# Development mode (port 8080)
make run

# With debug logging
make dev

# Custom ports
make run-custom  # ports 3000/3443

# Production mode (ports 80/443, HTTPS enabled)
sudo make prod
```

### Test

```bash
# Run all tests
make test

# Run with verbose output
make test-verbose

# Run unit tests only
make test-unit

# Run integration tests only
make test-integration
```

### Benchmark

```bash
# Run performance benchmarks
make bench
```

See [BENCH.md](BENCH.md) for detailed benchmark information and comparison with jsproxy.

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HTTP_PORT` | `8080` | HTTP server port |
| `HTTPS_PORT` | `8443` | HTTPS server port |
| `ENABLE_HTTPS` | `false` | Enable HTTPS server |
| `FORCE_HTTPS` | `false` | Redirect HTTP to HTTPS |
| `DB_PATH` | `./data/current.db` | SQLite database path |
| `CERTS_DIR` | `./certs` | SSL certificates directory |
| `ACME_DIRECTORY_URL` | Let's Encrypt prod | ACME server URL |
| `LOG_LEVEL` | `info` | Log level (trace/debug/info/warn/error) |

### Command Line Arguments

```bash
rustproxy [OPTIONS]

OPTIONS:
    --http-port <PORT>           HTTP port [default: 8080]
    --https-port <PORT>          HTTPS port [default: 8443]
    --enable-https               Enable HTTPS server
    --force-https                Redirect HTTP to HTTPS
    --db-path <PATH>             Database path [default: ./data/current.db]
    --certs-dir <PATH>           Certificates directory [default: ./certs]
    --acme-directory-url <URL>   ACME directory URL
    --log-level <LEVEL>          Log level [default: info]
    --production                 Production mode (ports 80/443, HTTPS enabled)
```

## Managing Mappings

### Add a mapping

```bash
# Basic mapping: localhost:3000 → backend port 3000
make mapping-add DOMAIN=localhost PORT=3000

# With path rewriting: /api/v1/* → /v1/*
make mapping-add DOMAIN=api.example.com PORT=3000 FRONTEND=api/v1 BACKEND=v1

# External backend
make mapping-add DOMAIN=external.example.com PORT=8080 SERVER=https://api.external.com
```

### List mappings

```bash
make mapping-list
```

### Delete a mapping

```bash
# Delete all mappings for domain
make mapping-delete DOMAIN=example.com

# Delete specific path mapping
make mapping-delete DOMAIN=example.com FRONTEND=api/v1
```

### Using the CLI directly

```bash
# Add mapping
cargo run --bin rustproxy-mapping -- add example.com 3000 --frontend api --backend v1

# List all mappings
cargo run --bin rustproxy-mapping -- list

# List as JSON
cargo run --bin rustproxy-mapping -- list --json

# Delete mapping
cargo run --bin rustproxy-mapping -- delete example.com --frontend api
```

## Database Schema

The SQLite database stores domain mappings with the following schema:

```sql
CREATE TABLE mappings (
    id TEXT PRIMARY KEY,
    domain TEXT NOT NULL,
    front_uri TEXT NOT NULL,
    back_port INTEGER NOT NULL,
    back_uri TEXT NOT NULL,
    backend TEXT DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### Routing Examples

| Request | Domain | Front URI | Back Port | Back URI | Backend | Result |
|---------|--------|-----------|-----------|----------|---------|--------|
| `GET https://api.example.com/users` | api.example.com | `` | 3000 | `` | - | `http://localhost:3000/users` |
| `GET https://app.example.com/api/v1/data` | app.example.com | `api/v1` | 3001 | `v1` | - | `http://localhost:3001/v1/data` |
| `GET https://ext.example.com/users` | ext.example.com | `` | 8080 | `` | https://api.ext.com | `https://api.ext.com:8080/users` |

## Compatibility with jsproxy

RustProxy is designed to be 100% compatible with jsproxy:

- ✅ Same database schema
- ✅ Same routing algorithm (longest-match-first)
- ✅ Same path rewriting logic
- ✅ Same health endpoint (`/health`)
- ✅ Same X-Forwarded-* headers
- ✅ Same ACME challenge handling
- ✅ Same WebSocket proxying
- ✅ Same CLI mapping tool interface

You can switch between jsproxy and RustProxy using the same database file.

## Project Structure

```
rust/
├── Cargo.toml              # Rust dependencies
├── Makefile                # Build/run/test commands
├── README.md               # This file
├── BENCH.md                # Benchmark documentation
├── src/
│   ├── lib.rs              # Library exports
│   ├── main.rs             # Main entry point
│   ├── database.rs         # SQLite database manager
│   ├── certificate.rs      # SSL certificate manager
│   ├── proxy.rs            # HTTP/HTTPS proxy server
│   └── bin/
│       └── add_mapping.rs  # CLI mapping tool
├── tests/
│   └── integration_test.rs # Integration tests
└── scripts/
    └── bench.sh            # Benchmark script
```

## Development

### Format code

```bash
make fmt
```

### Run linter

```bash
make lint
```

### Generate documentation

```bash
make docs
```

## Installation

### Install to system

```bash
make install
```

### Uninstall

```bash
make uninstall
```

## License

MIT License - Same as jsproxy
