//! RustProxy - A resilient HTTP/HTTPS reverse proxy server
//!
//! This is a Rust port of jsproxy, providing:
//! - Domain-based routing with SQLite mappings
//! - Path rewriting (front_uri -> back_uri)
//! - HTTPS with automatic certificate management
//! - WebSocket proxy support
//! - Health check endpoint

pub mod certificate;
pub mod database;
pub mod proxy;

pub use certificate::CertificateManager;
pub use database::{DatabaseManager, Mapping};
pub use proxy::{ProxyConfig, ProxyServer};
