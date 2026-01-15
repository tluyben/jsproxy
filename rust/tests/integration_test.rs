//! Integration tests for RustProxy
//!
//! Tests the full proxy server functionality including:
//! - HTTP proxying
//! - Path rewriting
//! - Health check endpoint
//! - Database operations
//! - WebSocket proxying (basic)

use bytes::Bytes;
use http_body_util::Full;
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use rustproxy::{CertificateManager, DatabaseManager, ProxyConfig, ProxyServer};
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tempfile::tempdir;
use tokio::net::TcpListener;
use tokio::time::sleep;

// Counter for unique port allocation
static PORT_COUNTER: AtomicU16 = AtomicU16::new(19000);

fn get_unique_port() -> u16 {
    PORT_COUNTER.fetch_add(1, Ordering::SeqCst)
}

/// Simple backend server for testing
async fn run_backend_server(
    port: u16,
    response_body: &'static str,
) -> tokio::task::JoinHandle<()> {
    let addr: SocketAddr = format!("127.0.0.1:{}", port).parse().unwrap();
    let listener = TcpListener::bind(addr).await.unwrap();

    tokio::spawn(async move {
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            let io = TokioIo::new(stream);
            let body = response_body;

            tokio::spawn(async move {
                let service = service_fn(move |req: Request<Incoming>| {
                    let body = body;
                    async move {
                        let path = req.uri().path().to_string();
                        let host = req.headers()
                            .get("host")
                            .and_then(|h| h.to_str().ok())
                            .unwrap_or("unknown");
                        let x_forwarded_for = req.headers()
                            .get("x-forwarded-for")
                            .and_then(|h| h.to_str().ok())
                            .unwrap_or("none");

                        let response_text = format!(
                            "{}|path={}|host={}|xff={}",
                            body, path, host, x_forwarded_for
                        );

                        Ok::<_, Infallible>(
                            Response::builder()
                                .status(200)
                                .body(Full::new(Bytes::from(response_text)))
                                .unwrap()
                        )
                    }
                });

                let _ = http1::Builder::new()
                    .serve_connection(io, service)
                    .await;
            });
        }
    })
}

/// Create test proxy server
async fn setup_proxy(
    http_port: u16,
    db_path: &std::path::Path,
    certs_dir: &std::path::Path,
) -> Arc<ProxyServer> {
    let db_manager = Arc::new(DatabaseManager::new(db_path).unwrap());
    let cert_manager = Arc::new(CertificateManager::new(certs_dir, None).unwrap());

    let config = ProxyConfig {
        http_port,
        https_port: http_port + 1,
        enable_https: false,
        force_https: false,
    };

    Arc::new(ProxyServer::new(config, db_manager, cert_manager))
}

#[tokio::test]
async fn test_health_endpoint() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("test.db");
    let certs_dir = dir.path().join("certs");

    let proxy_port = get_unique_port();
    let proxy = setup_proxy(proxy_port, &db_path, &certs_dir).await;

    // Start proxy server
    let proxy_clone = proxy.clone();
    tokio::spawn(async move {
        let _ = proxy_clone.run().await;
    });

    // Wait for server to start
    sleep(Duration::from_millis(100)).await;

    // Test health endpoint
    let client = reqwest::Client::new();
    let response = client
        .get(format!("http://127.0.0.1:{}/health", proxy_port))
        .send()
        .await
        .unwrap();

    assert!(response.status().is_success());
    assert_eq!(response.text().await.unwrap(), "OK");
}

#[tokio::test]
async fn test_proxy_simple_request() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("test.db");
    let certs_dir = dir.path().join("certs");

    let proxy_port = get_unique_port();
    let backend_port = get_unique_port();

    // Setup database with mapping
    let db = DatabaseManager::new(&db_path).unwrap();
    db.add_mapping("localhost", "", backend_port, "", None).unwrap();

    // Start backend server
    let _backend = run_backend_server(backend_port, "BACKEND_RESPONSE").await;

    // Start proxy server
    let proxy = setup_proxy(proxy_port, &db_path, &certs_dir).await;
    let proxy_clone = proxy.clone();
    tokio::spawn(async move {
        let _ = proxy_clone.run().await;
    });

    // Wait for servers to start
    sleep(Duration::from_millis(200)).await;

    // Test proxying
    let client = reqwest::Client::new();
    let response = client
        .get(format!("http://127.0.0.1:{}/test", proxy_port))
        .header("Host", "localhost")
        .send()
        .await
        .unwrap();

    assert!(response.status().is_success());
    let body = response.text().await.unwrap();
    assert!(body.contains("BACKEND_RESPONSE"));
    assert!(body.contains("path=/test"));
}

#[tokio::test]
async fn test_proxy_path_rewriting() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("test.db");
    let certs_dir = dir.path().join("certs");

    let proxy_port = get_unique_port();
    let backend_port = get_unique_port();

    // Setup database with mapping: /api/v1/* -> /v1/*
    let db = DatabaseManager::new(&db_path).unwrap();
    db.add_mapping("localhost", "api/v1", backend_port, "v1", None).unwrap();

    // Start backend server
    let _backend = run_backend_server(backend_port, "REWRITTEN").await;

    // Start proxy server
    let proxy = setup_proxy(proxy_port, &db_path, &certs_dir).await;
    let proxy_clone = proxy.clone();
    tokio::spawn(async move {
        let _ = proxy_clone.run().await;
    });

    // Wait for servers to start
    sleep(Duration::from_millis(200)).await;

    // Test path rewriting
    let client = reqwest::Client::new();
    let response = client
        .get(format!("http://127.0.0.1:{}/api/v1/users", proxy_port))
        .header("Host", "localhost")
        .send()
        .await
        .unwrap();

    assert!(response.status().is_success());
    let body = response.text().await.unwrap();
    assert!(body.contains("path=/v1/users"));
}

#[tokio::test]
async fn test_proxy_longest_match() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("test.db");
    let certs_dir = dir.path().join("certs");

    let proxy_port = get_unique_port();
    let backend_port_short = get_unique_port();
    let backend_port_long = get_unique_port();

    // Setup database with two mappings
    let db = DatabaseManager::new(&db_path).unwrap();
    db.add_mapping("localhost", "api", backend_port_short, "", None).unwrap();
    db.add_mapping("localhost", "api/v1", backend_port_long, "v1", None).unwrap();

    // Start backend servers
    let _backend_short = run_backend_server(backend_port_short, "SHORT_MATCH").await;
    let _backend_long = run_backend_server(backend_port_long, "LONG_MATCH").await;

    // Start proxy server
    let proxy = setup_proxy(proxy_port, &db_path, &certs_dir).await;
    let proxy_clone = proxy.clone();
    tokio::spawn(async move {
        let _ = proxy_clone.run().await;
    });

    // Wait for servers to start
    sleep(Duration::from_millis(200)).await;

    let client = reqwest::Client::new();

    // Should match longer pattern (api/v1)
    let response = client
        .get(format!("http://127.0.0.1:{}/api/v1/users", proxy_port))
        .header("Host", "localhost")
        .send()
        .await
        .unwrap();

    let body = response.text().await.unwrap();
    assert!(body.contains("LONG_MATCH"));

    // Should match shorter pattern (api) for /api/v2
    let response = client
        .get(format!("http://127.0.0.1:{}/api/v2/users", proxy_port))
        .header("Host", "localhost")
        .send()
        .await
        .unwrap();

    let body = response.text().await.unwrap();
    assert!(body.contains("SHORT_MATCH"));
}

#[tokio::test]
async fn test_proxy_no_mapping_404() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("test.db");
    let certs_dir = dir.path().join("certs");

    let proxy_port = get_unique_port();

    // Don't add any mappings
    let _db = DatabaseManager::new(&db_path).unwrap();

    // Start proxy server
    let proxy = setup_proxy(proxy_port, &db_path, &certs_dir).await;
    let proxy_clone = proxy.clone();
    tokio::spawn(async move {
        let _ = proxy_clone.run().await;
    });

    // Wait for server to start
    sleep(Duration::from_millis(100)).await;

    // Test request to unknown domain
    let client = reqwest::Client::new();
    let response = client
        .get(format!("http://127.0.0.1:{}/test", proxy_port))
        .header("Host", "unknown.example.com")
        .send()
        .await
        .unwrap();

    assert_eq!(response.status().as_u16(), 404);
}

#[tokio::test]
async fn test_proxy_missing_host_400() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("test.db");
    let certs_dir = dir.path().join("certs");

    let proxy_port = get_unique_port();

    let _db = DatabaseManager::new(&db_path).unwrap();

    // Start proxy server
    let proxy = setup_proxy(proxy_port, &db_path, &certs_dir).await;
    let proxy_clone = proxy.clone();
    tokio::spawn(async move {
        let _ = proxy_clone.run().await;
    });

    // Wait for server to start
    sleep(Duration::from_millis(100)).await;

    // Make raw TCP request without Host header
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    let mut stream = TcpStream::connect(format!("127.0.0.1:{}", proxy_port))
        .await
        .unwrap();

    stream
        .write_all(b"GET /test HTTP/1.1\r\n\r\n")
        .await
        .unwrap();

    let mut response = vec![0u8; 1024];
    let n = stream.read(&mut response).await.unwrap();
    let response_str = String::from_utf8_lossy(&response[..n]);

    assert!(response_str.contains("400"));
}

#[tokio::test]
async fn test_proxy_x_forwarded_headers() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("test.db");
    let certs_dir = dir.path().join("certs");

    let proxy_port = get_unique_port();
    let backend_port = get_unique_port();

    // Setup database with mapping
    let db = DatabaseManager::new(&db_path).unwrap();
    db.add_mapping("example.com", "", backend_port, "", None).unwrap();

    // Start backend server
    let _backend = run_backend_server(backend_port, "HEADERS_TEST").await;

    // Start proxy server
    let proxy = setup_proxy(proxy_port, &db_path, &certs_dir).await;
    let proxy_clone = proxy.clone();
    tokio::spawn(async move {
        let _ = proxy_clone.run().await;
    });

    // Wait for servers to start
    sleep(Duration::from_millis(200)).await;

    // Test X-Forwarded-* headers
    let client = reqwest::Client::new();
    let response = client
        .get(format!("http://127.0.0.1:{}/test", proxy_port))
        .header("Host", "example.com")
        .send()
        .await
        .unwrap();

    assert!(response.status().is_success());
    let body = response.text().await.unwrap();

    // Check that host header was preserved
    assert!(body.contains("host=example.com"));

    // Check that X-Forwarded-For was set
    assert!(body.contains("xff=127.0.0.1"));
}

#[tokio::test]
async fn test_proxy_post_request() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("test.db");
    let certs_dir = dir.path().join("certs");

    let proxy_port = get_unique_port();
    let backend_port = get_unique_port();

    // Setup database with mapping
    let db = DatabaseManager::new(&db_path).unwrap();
    db.add_mapping("localhost", "", backend_port, "", None).unwrap();

    // Start backend server
    let _backend = run_backend_server(backend_port, "POST_TEST").await;

    // Start proxy server
    let proxy = setup_proxy(proxy_port, &db_path, &certs_dir).await;
    let proxy_clone = proxy.clone();
    tokio::spawn(async move {
        let _ = proxy_clone.run().await;
    });

    // Wait for servers to start
    sleep(Duration::from_millis(200)).await;

    // Test POST request
    let client = reqwest::Client::new();
    let response = client
        .post(format!("http://127.0.0.1:{}/api/data", proxy_port))
        .header("Host", "localhost")
        .body("test body content")
        .send()
        .await
        .unwrap();

    assert!(response.status().is_success());
}

#[tokio::test]
async fn test_proxy_query_string_preserved() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("test.db");
    let certs_dir = dir.path().join("certs");

    let proxy_port = get_unique_port();
    let backend_port = get_unique_port();

    // Setup database
    let db = DatabaseManager::new(&db_path).unwrap();
    db.add_mapping("localhost", "", backend_port, "", None).unwrap();

    // Start a backend that echoes the full URI
    let addr: SocketAddr = format!("127.0.0.1:{}", backend_port).parse().unwrap();
    let listener = TcpListener::bind(addr).await.unwrap();

    tokio::spawn(async move {
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            let io = TokioIo::new(stream);

            tokio::spawn(async move {
                let service = service_fn(|req: Request<Incoming>| async move {
                    let full_uri = req.uri().to_string();
                    Ok::<_, Infallible>(
                        Response::builder()
                            .status(200)
                            .body(Full::new(Bytes::from(format!("URI={}", full_uri))))
                            .unwrap()
                    )
                });

                let _ = http1::Builder::new()
                    .serve_connection(io, service)
                    .await;
            });
        }
    });

    // Start proxy server
    let proxy = setup_proxy(proxy_port, &db_path, &certs_dir).await;
    let proxy_clone = proxy.clone();
    tokio::spawn(async move {
        let _ = proxy_clone.run().await;
    });

    // Wait for servers to start
    sleep(Duration::from_millis(200)).await;

    // Test with query string
    let client = reqwest::Client::new();
    let response = client
        .get(format!("http://127.0.0.1:{}/api?foo=bar&baz=qux", proxy_port))
        .header("Host", "localhost")
        .send()
        .await
        .unwrap();

    let body = response.text().await.unwrap();
    assert!(body.contains("foo=bar"));
    assert!(body.contains("baz=qux"));
}

#[tokio::test]
async fn test_database_operations() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("test.db");

    let db = DatabaseManager::new(&db_path).unwrap();

    // Test add
    let mapping = db.add_mapping("test.com", "api", 3000, "v1", None).unwrap();
    assert_eq!(mapping.domain, "test.com");
    assert_eq!(mapping.front_uri, "api");
    assert_eq!(mapping.back_port, 3000);
    assert_eq!(mapping.back_uri, "v1");

    // Test list
    let mappings = db.list_mappings(None).unwrap();
    assert_eq!(mappings.len(), 1);

    // Test find
    let found = db.find_mapping("test.com", "/api/users").unwrap();
    assert!(found.is_some());

    // Test domain_exists
    assert!(db.domain_exists("test.com").unwrap());
    assert!(!db.domain_exists("unknown.com").unwrap());

    // Test delete
    let deleted = db.delete_mapping("test.com", Some("api")).unwrap();
    assert_eq!(deleted, 1);

    let mappings = db.list_mappings(None).unwrap();
    assert_eq!(mappings.len(), 0);
}

#[tokio::test]
async fn test_backend_unreachable_502() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("test.db");
    let certs_dir = dir.path().join("certs");

    let proxy_port = get_unique_port();
    let backend_port = get_unique_port(); // No server running on this port

    // Setup database with mapping to non-existent backend
    let db = DatabaseManager::new(&db_path).unwrap();
    db.add_mapping("localhost", "", backend_port, "", None).unwrap();

    // Start proxy server
    let proxy = setup_proxy(proxy_port, &db_path, &certs_dir).await;
    let proxy_clone = proxy.clone();
    tokio::spawn(async move {
        let _ = proxy_clone.run().await;
    });

    // Wait for server to start
    sleep(Duration::from_millis(100)).await;

    // Test request to unreachable backend
    let client = reqwest::Client::new();
    let response = client
        .get(format!("http://127.0.0.1:{}/test", proxy_port))
        .header("Host", "localhost")
        .send()
        .await
        .unwrap();

    assert_eq!(response.status().as_u16(), 502);
}
