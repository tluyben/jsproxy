//! RustProxy - Main entry point
//!
//! A resilient HTTP/HTTPS reverse proxy server (Rust port of jsproxy)

use anyhow::Result;
use clap::Parser;
use rustproxy::{CertificateManager, DatabaseManager, ProxyConfig, ProxyServer};
use std::path::PathBuf;
use std::sync::Arc;
use tracing::{info, Level};
use tracing_subscriber::FmtSubscriber;

/// RustProxy - A resilient HTTP/HTTPS reverse proxy server
#[derive(Parser, Debug)]
#[command(name = "rustproxy")]
#[command(author = "RustProxy Contributors")]
#[command(version = "1.0.0")]
#[command(about = "A resilient HTTP/HTTPS reverse proxy server")]
struct Args {
    /// HTTP port to listen on
    #[arg(long, env = "HTTP_PORT", default_value = "8080")]
    http_port: u16,

    /// HTTPS port to listen on
    #[arg(long, env = "HTTPS_PORT", default_value = "8443")]
    https_port: u16,

    /// Enable HTTPS server
    #[arg(long, env = "ENABLE_HTTPS", default_value = "false")]
    enable_https: bool,

    /// Force HTTPS redirect
    #[arg(long, env = "FORCE_HTTPS", default_value = "false")]
    force_https: bool,

    /// Database path
    #[arg(long, env = "DB_PATH", default_value = "./data/current.db")]
    db_path: PathBuf,

    /// Certificates directory
    #[arg(long, env = "CERTS_DIR", default_value = "./certs")]
    certs_dir: PathBuf,

    /// ACME directory URL (Let's Encrypt)
    #[arg(long, env = "ACME_DIRECTORY_URL")]
    acme_directory_url: Option<String>,

    /// Log level
    #[arg(long, env = "LOG_LEVEL", default_value = "info")]
    log_level: String,

    /// Run in production mode (ports 80/443)
    #[arg(long)]
    production: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    let mut args = Args::parse();

    // Production mode overrides
    if args.production {
        args.http_port = 80;
        args.https_port = 443;
        args.enable_https = true;
    }

    // Initialize logging
    let log_level = match args.log_level.to_lowercase().as_str() {
        "trace" => Level::TRACE,
        "debug" => Level::DEBUG,
        "info" => Level::INFO,
        "warn" => Level::WARN,
        "error" => Level::ERROR,
        _ => Level::INFO,
    };

    let subscriber = FmtSubscriber::builder()
        .with_max_level(log_level)
        .with_target(false)
        .with_thread_ids(false)
        .compact()
        .init();

    info!("Starting RustProxy v1.0.0");
    info!("HTTP port: {}", args.http_port);

    if args.enable_https {
        info!("HTTPS port: {}", args.https_port);
    }

    // Initialize database manager
    let db_manager = Arc::new(DatabaseManager::new(&args.db_path)?);
    info!("Database initialized at: {}", args.db_path.display());

    // Initialize certificate manager
    let cert_manager = Arc::new(CertificateManager::new(
        &args.certs_dir,
        args.acme_directory_url,
    )?);
    info!("Certificate manager initialized at: {}", args.certs_dir.display());

    // Create proxy configuration
    let config = ProxyConfig {
        http_port: args.http_port,
        https_port: args.https_port,
        enable_https: args.enable_https,
        force_https: args.force_https,
    };

    // Create and run proxy server
    let server = Arc::new(ProxyServer::new(config, db_manager, cert_manager));

    info!("RustProxy started successfully");

    server.run().await?;

    Ok(())
}
