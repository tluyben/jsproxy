//! Example: embed rustproxy inside an Axum application.
//!
//! This shows the typical "one binary" pattern where rustproxy handles traffic
//! for domains/paths registered in its SQLite database, and all unmatched
//! requests fall through to your Axum router.
//!
//! # What happens per request
//!
//! ```
//! Client → rustproxy (ProxyLayer)
//!          ├── /health           → rustproxy built-in  (200 OK)
//!          ├── /.well-known/...  → rustproxy built-in  (ACME challenge)
//!          ├── mapped domain     → proxied to backend   (DB mapping)
//!          └── everything else   → AxumFallback         (your app)
//!                                  ├── GET /hello  → "Hello from Axum!"
//!                                  └── *           → Axum 404
//! ```
//!
//! # Running
//!
//! ```sh
//! cd rust
//! cargo run --example axum_embed
//! # Then:
//! curl http://localhost:3000/health   # → "OK"  (rustproxy)
//! curl http://localhost:3000/hello    # → "Hello from Axum!"  (your app)
//! ```
//!
//! # Cargo.toml for your own project
//!
//! ```toml
//! [dependencies]
//! rustproxy = { path = "../rustproxy" }   # or version from crates.io
//! axum      = "0.7"
//! tower     = { version = "0.4", features = ["util"] }
//! tokio     = { version = "1", features = ["full"] }
//! anyhow    = "1"
//! async-trait = "0.1"
//! bytes     = "1"
//! http-body-util = "0.1"
//! hyper     = { version = "1", features = ["full"] }
//! ```

use anyhow::Result;
use async_trait::async_trait;
use axum::{Router, routing::get};
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::{Request, Response, body::Incoming};
use rustproxy::{FallbackHandler, ProxyBuilder};
use std::net::SocketAddr;
use std::sync::Arc;
use tempfile::tempdir;
use tower::ServiceExt;

// ── AxumFallback ──────────────────────────────────────────────────────────────

/// Wraps an Axum [`Router`] as a rustproxy [`FallbackHandler`].
///
/// For every request that rustproxy cannot match in its database, it calls
/// `AxumFallback::handle`, which forwards the request into Axum and converts
/// the response body back to `Full<Bytes>` so rustproxy can send it to the
/// client.
struct AxumFallback {
    router: Router,
}

impl AxumFallback {
    fn new(router: Router) -> Self {
        Self { router }
    }
}

#[async_trait]
impl FallbackHandler for AxumFallback {
    async fn handle(
        &self,
        req: Request<Incoming>,
        _remote_addr: SocketAddr,
    ) -> Result<Response<Full<Bytes>>> {
        // Convert hyper::Request<Incoming> → axum::extract::Request<axum::body::Body>
        let (parts, body) = req.into_parts();
        let body_bytes = body.collect().await?.to_bytes();
        let axum_req = Request::from_parts(parts, axum::body::Body::from(body_bytes));

        // Drive the Axum router for this one request (clone is cheap — Router is Arc inside)
        let axum_resp = self.router.clone().oneshot(axum_req).await
            .map_err(|e| anyhow::anyhow!("Axum error: {}", e))?;

        // Convert Response<axum::body::Body> → Response<Full<Bytes>>
        let (parts, body) = axum_resp.into_parts();
        let body_bytes = body.collect().await
            .map_err(|e| anyhow::anyhow!("Axum body error: {}", e))?
            .to_bytes();

        Ok(Response::from_parts(parts, Full::new(body_bytes)))
    }
}

// ── Application routes ────────────────────────────────────────────────────────

async fn hello_handler() -> &'static str {
    "Hello from Axum!"
}

async fn status_handler() -> impl axum::response::IntoResponse {
    axum::Json(serde_json::json!({ "status": "running", "version": "1.0" }))
}

// ── main ──────────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() -> Result<()> {
    // Set up tracing so you can see proxy logs
    tracing_subscriber::fmt().with_target(false).compact().init();

    // Your Axum application routes
    let app = Router::new()
        .route("/hello", get(hello_handler))
        .route("/status", get(status_handler));

    // Use a temp dir for this example; in production point to your real paths.
    let dir = tempdir()?;
    let db_path   = dir.path().join("proxy.db");
    let certs_dir = dir.path().join("certs");

    // Build the proxy server with your Axum router as the fallback.
    //
    // Any domain/path you insert into the SQLite database (via rustproxy-mapping
    // or the DatabaseManager API) will be proxied to the registered backend.
    // Everything else reaches Axum.
    let server = Arc::new(
        ProxyBuilder::new()
            .db_path(&db_path)
            .certs_dir(&certs_dir)
            .http_port(3000)
            .fallback(AxumFallback::new(app))
            .build()?
    );

    println!("Listening on http://0.0.0.0:3000");
    println!("  GET /health  → rustproxy built-in");
    println!("  GET /hello   → Axum route");
    println!("  GET /status  → Axum route");

    server.run().await
}
