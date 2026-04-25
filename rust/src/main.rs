//! RustProxy — main entry point with multi-worker cluster support.
//!
//! Mirrors Node.js cluster behaviour: spawns min(CPUs, 4) OS threads (configurable
//! via WORKERS env var), each binding the same port with SO_REUSEPORT.  The kernel
//! distributes incoming connections across all workers.

use anyhow::Result;
use clap::Parser;
use rustproxy::{CertificateManager, DatabaseManager, ProxyConfig, ProxyServer};
use socket2::{Domain, Socket, Type};
use std::net::SocketAddr;
use std::net::TcpListener as StdListener;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::net::TcpListener;
use tracing::{info, Level};
use tracing_subscriber::FmtSubscriber;

/// RustProxy — A resilient HTTP/HTTPS reverse proxy server
#[derive(Parser, Debug)]
#[command(name = "rustproxy")]
#[command(author = "RustProxy Contributors")]
#[command(version = "1.0.0")]
#[command(about = "A resilient HTTP/HTTPS reverse proxy server")]
struct Args {
    #[arg(long, env = "HTTP_PORT", default_value = "8080")]
    http_port: u16,

    #[arg(long, env = "HTTPS_PORT", default_value = "8443")]
    https_port: u16,

    #[arg(long, env = "ENABLE_HTTPS", default_value = "false")]
    enable_https: bool,

    #[arg(long, env = "FORCE_HTTPS", default_value = "false")]
    force_https: bool,

    #[arg(long, env = "HTTP_HOST", default_value = "0.0.0.0")]
    http_host: String,

    #[arg(long, env = "DB_PATH", default_value = "./data/current.db")]
    db_path: PathBuf,

    #[arg(long, env = "CERTS_DIR", default_value = "./certs")]
    certs_dir: PathBuf,

    #[arg(long, env = "ACME_DIRECTORY_URL")]
    acme_directory_url: Option<String>,

    #[arg(long, env = "LOG_LEVEL", default_value = "info")]
    log_level: String,

    /// Number of worker threads (default: min(logical CPUs, 4), matching Node.js cluster).
    /// Set WORKERS=1 to disable multi-worker mode.
    #[arg(long, env = "WORKERS")]
    workers: Option<usize>,

    #[arg(long)]
    production: bool,
}

/// Bind a TCP socket with SO_REUSEPORT so multiple threads can listen on the same address.
fn bind_reuseport(addr: SocketAddr) -> std::io::Result<TcpListener> {
    let domain = if addr.is_ipv6() { Domain::IPV6 } else { Domain::IPV4 };
    let socket = Socket::new(domain, Type::STREAM, None)?;
    socket.set_reuse_address(true)?;
    socket.set_reuse_port(true)?;
    socket.set_nonblocking(true)?;
    socket.bind(&addr.into())?;
    socket.listen(1024)?;
    let std_listener: StdListener = socket.into();
    TcpListener::from_std(std_listener)
}

fn default_workers() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get().min(4))
        .unwrap_or(1)
}

fn main() -> Result<()> {
    let mut args = Args::parse();

    if args.production {
        args.http_port = 80;
        args.https_port = 443;
        args.enable_https = true;
    }

    let log_level = match args.log_level.to_lowercase().as_str() {
        "trace" => Level::TRACE,
        "debug" => Level::DEBUG,
        "warn"  => Level::WARN,
        "error" => Level::ERROR,
        _       => Level::INFO,
    };

    let _subscriber = FmtSubscriber::builder()
        .with_max_level(log_level)
        .with_target(false)
        .with_thread_ids(true)   // show thread id so workers are distinguishable
        .compact()
        .init();

    let n_workers = args.workers.unwrap_or_else(default_workers).max(1);

    info!("Starting RustProxy v1.0.0 with {} worker(s)", n_workers);
    info!("HTTP port: {}", args.http_port);
    if args.enable_https {
        info!("HTTPS port: {}", args.https_port);
    }

    let db_manager  = Arc::new(DatabaseManager::new(&args.db_path)?);
    let cert_manager = Arc::new(CertificateManager::new(&args.certs_dir, args.acme_directory_url)?);
    info!("Database: {}", args.db_path.display());

    let config = ProxyConfig {
        http_port:    args.http_port,
        https_port:   args.https_port,
        enable_https: args.enable_https,
        force_https:  args.force_https,
        http_host:    args.http_host.clone(),
    };

    let server = Arc::new(ProxyServer::new(config, db_manager, cert_manager));

    let http_addr: SocketAddr = format!("{}:{}", args.http_host, args.http_port).parse()?;

    if n_workers == 1 {
        // Single-worker path: plain bind (no SO_REUSEPORT needed)
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?
            .block_on(server.run())?;
    } else {
        // Multi-worker: each OS thread gets its own SO_REUSEPORT listener and Tokio runtime,
        // mirroring Node.js cluster where each worker has its own event loop.
        let mut handles = Vec::with_capacity(n_workers);

        for worker_id in 0..n_workers {
            let s = server.clone();
            let addr = http_addr;

            handles.push(std::thread::Builder::new()
                .name(format!("worker-{}", worker_id))
                .spawn(move || -> Result<()> {
                    let rt = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()?;

                    rt.block_on(async move {
                        let listener = bind_reuseport(addr)
                            .map_err(|e| anyhow::anyhow!("SO_REUSEPORT bind failed: {}", e))?;
                        s.run_with_listener(listener).await
                    })
                })?);
        }

        for handle in handles {
            handle.join().map_err(|_| anyhow::anyhow!("worker thread panicked"))??;
        }
    }

    Ok(())
}
