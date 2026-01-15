# RustProxy Makefile
# A resilient HTTP/HTTPS reverse proxy server (Rust port of jsproxy)

.PHONY: all build release test clean run dev prod help bench mapping-add mapping-list

# Default target
all: build

# Build in debug mode
build:
	cargo build

# Build in release mode (optimized)
release:
	cargo build --release

# Run all tests
test:
	cargo test -- --test-threads=1

# Run tests with output
test-verbose:
	cargo test -- --test-threads=1 --nocapture

# Run unit tests only
test-unit:
	cargo test --lib

# Run integration tests only
test-integration:
	cargo test --test integration_test -- --test-threads=1

# Clean build artifacts
clean:
	cargo clean
	rm -rf data/ certs/ logs/

# Run in development mode (port 8080)
run: build
	cargo run

# Run in development mode with debug logging
dev: build
	RUST_LOG=debug cargo run

# Run on port 80 (requires privileges)
run-80: build
	cargo run -- --http-port 80

# Run with HTTPS on ports 80/443 (requires privileges)
run-443: release
	./target/release/rustproxy --http-port 80 --https-port 443 --enable-https

# Run in production mode (ports 80/443, HTTPS enabled)
prod: release
	./target/release/rustproxy --production

# Run with custom ports
run-custom: build
	cargo run -- --http-port 3000 --https-port 3443

# Run with HTTPS enabled (development)
run-https: build
	cargo run -- --enable-https

# Run benchmarks
bench: release
	@echo "Running RustProxy benchmarks..."
	@./scripts/bench.sh

# Add a mapping via CLI
mapping-add: build
	cargo run --bin rustproxy-mapping -- add $(DOMAIN) $(PORT) \
		$(if $(FRONTEND),--frontend $(FRONTEND),) \
		$(if $(BACKEND),--backend $(BACKEND),) \
		$(if $(SERVER),--server $(SERVER),)

# List all mappings
mapping-list: build
	cargo run --bin rustproxy-mapping -- list

# Delete a mapping
mapping-delete: build
	cargo run --bin rustproxy-mapping -- delete $(DOMAIN) \
		$(if $(FRONTEND),--frontend $(FRONTEND),)

# Format code
fmt:
	cargo fmt

# Check formatting
fmt-check:
	cargo fmt -- --check

# Run clippy linter
lint:
	cargo clippy -- -D warnings

# Check for security vulnerabilities
audit:
	cargo audit

# Generate documentation
docs:
	cargo doc --no-deps --open

# Install to system
install: release
	cargo install --path .

# Uninstall from system
uninstall:
	cargo uninstall rustproxy

# Show help
help:
	@echo "RustProxy Makefile"
	@echo ""
	@echo "Build targets:"
	@echo "  make build        - Build in debug mode"
	@echo "  make release      - Build in release mode (optimized)"
	@echo "  make clean        - Clean build artifacts"
	@echo ""
	@echo "Run targets:"
	@echo "  make run          - Run on port 8080 (development)"
	@echo "  make dev          - Run with debug logging"
	@echo "  make run-80       - Run on port 80 (requires root)"
	@echo "  make run-443      - Run on ports 80/443 with HTTPS"
	@echo "  make prod         - Run in production mode (80/443)"
	@echo "  make run-custom   - Run on ports 3000/3443"
	@echo "  make run-https    - Run with HTTPS on 8080/8443"
	@echo ""
	@echo "Test targets:"
	@echo "  make test         - Run all tests"
	@echo "  make test-verbose - Run tests with output"
	@echo "  make test-unit    - Run unit tests only"
	@echo "  make test-integration - Run integration tests only"
	@echo ""
	@echo "Benchmark targets:"
	@echo "  make bench        - Run performance benchmarks"
	@echo ""
	@echo "Mapping management:"
	@echo "  make mapping-add DOMAIN=example.com PORT=3000 [FRONTEND=api] [BACKEND=v1] [SERVER=http://backend]"
	@echo "  make mapping-list"
	@echo "  make mapping-delete DOMAIN=example.com [FRONTEND=api]"
	@echo ""
	@echo "Development targets:"
	@echo "  make fmt          - Format code"
	@echo "  make lint         - Run clippy linter"
	@echo "  make docs         - Generate documentation"
	@echo ""
	@echo "Installation:"
	@echo "  make install      - Install to system"
	@echo "  make uninstall    - Uninstall from system"
