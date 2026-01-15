#!/bin/bash
# RustProxy Benchmark Script
# Tests performance with wrk or ab (Apache Bench)

set -e

# Configuration
PROXY_PORT=${PROXY_PORT:-8080}
BACKEND_PORT=${BACKEND_PORT:-9999}
DB_PATH="./data/bench.db"
CERTS_DIR="./certs"
DURATION=${DURATION:-10}
CONNECTIONS=${CONNECTIONS:-100}
THREADS=${THREADS:-4}

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║              RustProxy Performance Benchmark                 ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Check for benchmark tools
if command -v wrk &> /dev/null; then
    BENCH_TOOL="wrk"
elif command -v ab &> /dev/null; then
    BENCH_TOOL="ab"
else
    echo -e "${RED}Error: Neither 'wrk' nor 'ab' found. Please install one:${NC}"
    echo "  - wrk: brew install wrk (macOS) or apt install wrk (Linux)"
    echo "  - ab: comes with Apache (httpd)"
    exit 1
fi

echo -e "${GREEN}Using benchmark tool: $BENCH_TOOL${NC}"

# Function to cleanup
cleanup() {
    echo -e "\n${YELLOW}Cleaning up...${NC}"
    if [ ! -z "$PROXY_PID" ]; then
        kill $PROXY_PID 2>/dev/null || true
    fi
    if [ ! -z "$BACKEND_PID" ]; then
        kill $BACKEND_PID 2>/dev/null || true
    fi
    rm -f "$DB_PATH" 2>/dev/null || true
}
trap cleanup EXIT

# Start a simple backend server using Python
echo -e "\n${YELLOW}Starting backend server on port $BACKEND_PORT...${NC}"
python3 -c "
import http.server
import socketserver

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{\"status\": \"ok\", \"message\": \"benchmark response\"}')

    def log_message(self, format, *args):
        pass  # Suppress logging

with socketserver.TCPServer(('', $BACKEND_PORT), Handler) as httpd:
    httpd.serve_forever()
" &
BACKEND_PID=$!
sleep 1

# Create database directory
mkdir -p "$(dirname $DB_PATH)"

# Add mapping using sqlite3 directly
echo -e "${YELLOW}Creating test mapping...${NC}"
sqlite3 "$DB_PATH" <<EOF
CREATE TABLE IF NOT EXISTS mappings (
    id TEXT PRIMARY KEY,
    domain TEXT NOT NULL,
    front_uri TEXT NOT NULL,
    back_port INTEGER NOT NULL,
    back_uri TEXT NOT NULL,
    backend TEXT DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO mappings (id, domain, front_uri, back_port, back_uri)
VALUES ('bench-test', 'localhost', '', $BACKEND_PORT, '');
EOF

# Build release version
echo -e "${YELLOW}Building RustProxy (release)...${NC}"
cargo build --release --quiet

# Start RustProxy
echo -e "${YELLOW}Starting RustProxy on port $PROXY_PORT...${NC}"
./target/release/rustproxy --http-port $PROXY_PORT --db-path "$DB_PATH" --certs-dir "$CERTS_DIR" &
PROXY_PID=$!
sleep 2

# Verify servers are running
echo -e "${YELLOW}Verifying servers...${NC}"
if ! curl -s "http://localhost:$PROXY_PORT/health" > /dev/null; then
    echo -e "${RED}Error: RustProxy not responding${NC}"
    exit 1
fi
echo -e "${GREEN}RustProxy health check: OK${NC}"

# Run benchmarks
echo -e "\n${BLUE}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}                    Running Benchmarks                          ${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"

echo -e "\n${YELLOW}Test 1: Simple GET request through proxy${NC}"
echo "URL: http://localhost:$PROXY_PORT/api/test"
echo "Duration: ${DURATION}s, Connections: $CONNECTIONS, Threads: $THREADS"
echo ""

if [ "$BENCH_TOOL" = "wrk" ]; then
    wrk -t$THREADS -c$CONNECTIONS -d${DURATION}s "http://localhost:$PROXY_PORT/api/test" -H "Host: localhost"
else
    ab -t $DURATION -c $CONNECTIONS -H "Host: localhost" "http://localhost:$PROXY_PORT/api/test"
fi

echo -e "\n${YELLOW}Test 2: Health endpoint (no proxy)${NC}"
echo "URL: http://localhost:$PROXY_PORT/health"
echo ""

if [ "$BENCH_TOOL" = "wrk" ]; then
    wrk -t$THREADS -c$CONNECTIONS -d${DURATION}s "http://localhost:$PROXY_PORT/health"
else
    ab -t $DURATION -c $CONNECTIONS "http://localhost:$PROXY_PORT/health"
fi

echo -e "\n${YELLOW}Test 3: POST request with small body${NC}"
echo ""

if [ "$BENCH_TOOL" = "wrk" ]; then
    # Create Lua script for POST requests
    cat > /tmp/post.lua <<'LUAEOF'
wrk.method = "POST"
wrk.body   = '{"test": "data", "benchmark": true}'
wrk.headers["Content-Type"] = "application/json"
wrk.headers["Host"] = "localhost"
LUAEOF
    wrk -t$THREADS -c$CONNECTIONS -d${DURATION}s -s /tmp/post.lua "http://localhost:$PROXY_PORT/api/data"
    rm /tmp/post.lua
else
    ab -t $DURATION -c $CONNECTIONS -p /dev/stdin -T "application/json" -H "Host: localhost" \
        "http://localhost:$PROXY_PORT/api/data" <<< '{"test": "data", "benchmark": true}'
fi

echo -e "\n${YELLOW}Test 4: Concurrent connections stress test${NC}"
echo "Connections: 500"
echo ""

if [ "$BENCH_TOOL" = "wrk" ]; then
    wrk -t$THREADS -c500 -d${DURATION}s "http://localhost:$PROXY_PORT/api/test" -H "Host: localhost"
else
    ab -t $DURATION -c 500 -H "Host: localhost" "http://localhost:$PROXY_PORT/api/test"
fi

echo -e "\n${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}                    Benchmark Complete                          ${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
