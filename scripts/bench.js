#!/usr/bin/env node
/**
 * JSProxy Benchmark Script
 * Tests performance with wrk or ab (Apache Bench)
 *
 * Usage: npm run bench
 */

const { spawn, execSync } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

// Configuration
const PROXY_PORT = process.env.PROXY_PORT || 8080;
const BACKEND_PORT = process.env.BACKEND_PORT || 9999;
const DB_PATH = './data/bench.db';
const DURATION = process.env.DURATION || 10;
const CONNECTIONS = process.env.CONNECTIONS || 100;
const THREADS = process.env.THREADS || 4;

// Colors
const colors = {
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    reset: '\x1b[0m'
};

function log(color, message) {
    console.log(`${colors[color]}${message}${colors.reset}`);
}

// Check for benchmark tools
function findBenchTool() {
    try {
        execSync('which wrk', { stdio: 'ignore' });
        return 'wrk';
    } catch {
        try {
            execSync('which ab', { stdio: 'ignore' });
            return 'ab';
        } catch {
            return null;
        }
    }
}

// Start backend server
function startBackend() {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"status": "ok", "message": "benchmark response"}');
        });
        server.listen(BACKEND_PORT, () => {
            resolve(server);
        });
    });
}

// Create test database with mapping
function setupDatabase() {
    return new Promise((resolve, reject) => {
        // Ensure data directory exists
        const dataDir = path.dirname(DB_PATH);
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }

        // Remove old benchmark database
        if (fs.existsSync(DB_PATH)) {
            fs.unlinkSync(DB_PATH);
        }

        const db = new sqlite3.Database(DB_PATH);

        db.serialize(() => {
            db.run(`
                CREATE TABLE IF NOT EXISTS mappings (
                    id TEXT PRIMARY KEY,
                    domain TEXT NOT NULL,
                    front_uri TEXT NOT NULL,
                    back_port INTEGER NOT NULL,
                    back_uri TEXT NOT NULL,
                    backend TEXT DEFAULT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);

            db.run(`
                INSERT INTO mappings (id, domain, front_uri, back_port, back_uri)
                VALUES ('bench-test', 'localhost', '', ?, '')
            `, [BACKEND_PORT], (err) => {
                if (err) reject(err);
                else {
                    db.close();
                    resolve();
                }
            });
        });
    });
}

// Start JSProxy
function startProxy() {
    return new Promise((resolve, reject) => {
        const env = {
            ...process.env,
            NODE_ENV: 'development',
            HTTP_PORT: PROXY_PORT.toString(),
            ENABLE_HTTPS: 'false',
            DB_PATH: DB_PATH,
            LOG_LEVEL: 'error'
        };

        const proxy = spawn('node', ['index.js'], {
            env,
            cwd: process.cwd(),
            stdio: 'pipe'
        });

        proxy.on('error', reject);

        // Wait for server to be ready
        setTimeout(() => {
            // Health check
            http.get(`http://localhost:${PROXY_PORT}/health`, (res) => {
                if (res.statusCode === 200) {
                    resolve(proxy);
                } else {
                    reject(new Error('Proxy health check failed'));
                }
            }).on('error', reject);
        }, 2000);
    });
}

// Run benchmark command
function runBenchmark(benchTool, title, url, options = {}) {
    return new Promise((resolve) => {
        console.log(`\n${colors.yellow}${title}${colors.reset}`);
        console.log(`URL: ${url}`);
        console.log(`Duration: ${DURATION}s, Connections: ${CONNECTIONS}, Threads: ${THREADS}`);
        console.log('');

        let args;
        if (benchTool === 'wrk') {
            args = [
                `-t${THREADS}`,
                `-c${options.connections || CONNECTIONS}`,
                `-d${DURATION}s`,
                url
            ];
            if (options.headers) {
                for (const [key, value] of Object.entries(options.headers)) {
                    args.push('-H', `${key}: ${value}`);
                }
            }
            if (options.script) {
                args.push('-s', options.script);
            }
        } else {
            args = [
                '-t', DURATION.toString(),
                '-c', (options.connections || CONNECTIONS).toString(),
                url
            ];
            if (options.headers) {
                for (const [key, value] of Object.entries(options.headers)) {
                    args.push('-H', `${key}: ${value}`);
                }
            }
        }

        const bench = spawn(benchTool, args, { stdio: 'inherit' });
        bench.on('close', resolve);
    });
}

// Main benchmark function
async function main() {
    log('blue', '╔══════════════════════════════════════════════════════════════╗');
    log('blue', '║              JSProxy Performance Benchmark                   ║');
    log('blue', '╚══════════════════════════════════════════════════════════════╝');
    console.log('');

    // Check for benchmark tool
    const benchTool = findBenchTool();
    if (!benchTool) {
        log('red', 'Error: Neither \'wrk\' nor \'ab\' found. Please install one:');
        console.log('  - wrk: brew install wrk (macOS) or apt install wrk (Linux)');
        console.log('  - ab: comes with Apache (httpd)');
        process.exit(1);
    }
    log('green', `Using benchmark tool: ${benchTool}`);

    let backendServer, proxyProcess;

    try {
        // Start backend
        log('yellow', `\nStarting backend server on port ${BACKEND_PORT}...`);
        backendServer = await startBackend();

        // Setup database
        log('yellow', 'Creating test mapping...');
        await setupDatabase();

        // Start proxy
        log('yellow', `Starting JSProxy on port ${PROXY_PORT}...`);
        proxyProcess = await startProxy();
        log('green', 'JSProxy health check: OK');

        // Run benchmarks
        log('blue', '\n═══════════════════════════════════════════════════════════════');
        log('blue', '                    Running Benchmarks                          ');
        log('blue', '═══════════════════════════════════════════════════════════════');

        // Test 1: Simple GET
        await runBenchmark(benchTool,
            'Test 1: Simple GET request through proxy',
            `http://localhost:${PROXY_PORT}/api/test`,
            { headers: { Host: 'localhost' } }
        );

        // Test 2: Health endpoint
        await runBenchmark(benchTool,
            'Test 2: Health endpoint (no proxy)',
            `http://localhost:${PROXY_PORT}/health`
        );

        // Test 3: POST request (wrk only with Lua script)
        if (benchTool === 'wrk') {
            const luaScript = '/tmp/post_jsproxy.lua';
            fs.writeFileSync(luaScript, `
wrk.method = "POST"
wrk.body   = '{"test": "data", "benchmark": true}'
wrk.headers["Content-Type"] = "application/json"
wrk.headers["Host"] = "localhost"
`);
            await runBenchmark(benchTool,
                'Test 3: POST request with small body',
                `http://localhost:${PROXY_PORT}/api/data`,
                { script: luaScript }
            );
            fs.unlinkSync(luaScript);
        } else {
            console.log(`\n${colors.yellow}Test 3: POST request with small body${colors.reset}`);
            console.log('(Skipped - requires wrk for POST benchmarks)');
        }

        // Test 4: High concurrency
        await runBenchmark(benchTool,
            'Test 4: Concurrent connections stress test (500 connections)',
            `http://localhost:${PROXY_PORT}/api/test`,
            { connections: 500, headers: { Host: 'localhost' } }
        );

        log('green', '\n═══════════════════════════════════════════════════════════════');
        log('green', '                    Benchmark Complete                          ');
        log('green', '═══════════════════════════════════════════════════════════════');

    } catch (error) {
        log('red', `Error: ${error.message}`);
        process.exit(1);
    } finally {
        // Cleanup
        log('yellow', '\nCleaning up...');
        if (proxyProcess) proxyProcess.kill();
        if (backendServer) backendServer.close();
        if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
    }
}

main().catch(console.error);
