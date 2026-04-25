//! Integration tests for RustProxy
//!
//! Tests the full proxy server functionality including:
//! - HTTP proxying
//! - Path rewriting
//! - Health check endpoint
//! - Database operations
//! - IP allowlisting
//! - Auth (basic, bearer, password)
//! - Wildcard and catch-all domain routing
//! - WebSocket proxying (basic)

use bytes::Bytes;
use http_body_util::Full;
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use rustproxy::{CertificateManager, DatabaseManager, FallbackHandler, ProxyBuilder, ProxyConfig, ProxyServer};
use anyhow::Result;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tempfile::tempdir;
use tokio::net::TcpListener;
use tokio::time::sleep;

static PORT_COUNTER: AtomicU16 = AtomicU16::new(19000);

fn get_unique_port() -> u16 {
    PORT_COUNTER.fetch_add(1, Ordering::SeqCst)
}

/// Simple backend server for testing — echoes path, host, and X-Forwarded-For
async fn run_backend_server(port: u16, tag: &'static str) -> tokio::task::JoinHandle<()> {
    let addr: SocketAddr = format!("127.0.0.1:{}", port).parse().unwrap();
    let listener = TcpListener::bind(addr).await.unwrap();

    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else { continue };
            let io = TokioIo::new(stream);
            tokio::spawn(async move {
                let _ = http1::Builder::new()
                    .serve_connection(io, service_fn(move |req: Request<Incoming>| async move {
                        let path = req.uri().path().to_string();
                        let host = req.headers().get("host")
                            .and_then(|h| h.to_str().ok()).unwrap_or("unknown");
                        let xff = req.headers().get("x-forwarded-for")
                            .and_then(|h| h.to_str().ok()).unwrap_or("none");
                        Ok::<_, Infallible>(Response::builder().status(200)
                            .body(Full::new(Bytes::from(format!("{}|path={}|host={}|xff={}", tag, path, host, xff))))
                            .unwrap())
                    }))
                    .await;
            });
        }
    })
}

async fn setup_proxy(http_port: u16, db_path: &std::path::Path, certs_dir: &std::path::Path) -> Arc<ProxyServer> {
    let db_manager = Arc::new(DatabaseManager::new(db_path).unwrap());
    let cert_manager = Arc::new(CertificateManager::new(certs_dir, None).unwrap());
    let config = ProxyConfig {
        http_port,
        https_port: http_port + 1,
        enable_https: false,
        force_https: false,
        http_host: "0.0.0.0".to_string(),
    };
    Arc::new(ProxyServer::new(config, db_manager, cert_manager))
}

fn add(db: &DatabaseManager, domain: &str, front: &str, port: u16, back: &str) {
    db.add_mapping(domain, front, port, back, None, None, None, None, None).unwrap();
}

async fn start_proxy(proxy_port: u16, db_path: &std::path::Path, certs_dir: &std::path::Path) {
    let proxy = setup_proxy(proxy_port, db_path, certs_dir).await;
    tokio::spawn(async move { let _ = proxy.run().await; });
    sleep(Duration::from_millis(150)).await;
}

// ── Core proxy tests ──────────────────────────────────────────────────────────

#[tokio::test]
async fn test_health_endpoint() {
    let dir = tempdir().unwrap();
    let proxy_port = get_unique_port();
    start_proxy(proxy_port, &dir.path().join("test.db"), &dir.path().join("certs")).await;

    let resp = reqwest::Client::new()
        .get(format!("http://127.0.0.1:{}/health", proxy_port))
        .send().await.unwrap();

    assert!(resp.status().is_success());
    assert_eq!(resp.text().await.unwrap(), "OK");
}

#[tokio::test]
async fn test_proxy_simple_request() {
    let dir = tempdir().unwrap();
    let proxy_port = get_unique_port();
    let backend_port = get_unique_port();

    let db = DatabaseManager::new(dir.path().join("test.db")).unwrap();
    add(&db, "localhost", "", backend_port, "");
    drop(db);

    let _backend = run_backend_server(backend_port, "BACKEND_RESPONSE").await;
    start_proxy(proxy_port, &dir.path().join("test.db"), &dir.path().join("certs")).await;

    let body = reqwest::Client::new()
        .get(format!("http://127.0.0.1:{}/test", proxy_port))
        .header("Host", "localhost")
        .send().await.unwrap().text().await.unwrap();

    assert!(body.contains("BACKEND_RESPONSE"));
    assert!(body.contains("path=/test"));
}

#[tokio::test]
async fn test_proxy_path_rewriting() {
    let dir = tempdir().unwrap();
    let proxy_port = get_unique_port();
    let backend_port = get_unique_port();

    let db = DatabaseManager::new(dir.path().join("test.db")).unwrap();
    add(&db, "localhost", "api/v1", backend_port, "v1");
    drop(db);

    let _backend = run_backend_server(backend_port, "REWRITTEN").await;
    start_proxy(proxy_port, &dir.path().join("test.db"), &dir.path().join("certs")).await;

    let body = reqwest::Client::new()
        .get(format!("http://127.0.0.1:{}/api/v1/users", proxy_port))
        .header("Host", "localhost")
        .send().await.unwrap().text().await.unwrap();

    assert!(body.contains("path=/v1/users"));
}

#[tokio::test]
async fn test_proxy_longest_match() {
    let dir = tempdir().unwrap();
    let proxy_port = get_unique_port();
    let port_short = get_unique_port();
    let port_long = get_unique_port();

    let db = DatabaseManager::new(dir.path().join("test.db")).unwrap();
    add(&db, "localhost", "api", port_short, "");
    add(&db, "localhost", "api/v1", port_long, "v1");
    drop(db);

    let _b1 = run_backend_server(port_short, "SHORT_MATCH").await;
    let _b2 = run_backend_server(port_long, "LONG_MATCH").await;
    start_proxy(proxy_port, &dir.path().join("test.db"), &dir.path().join("certs")).await;

    let client = reqwest::Client::new();

    let body = client.get(format!("http://127.0.0.1:{}/api/v1/users", proxy_port))
        .header("Host", "localhost").send().await.unwrap().text().await.unwrap();
    assert!(body.contains("LONG_MATCH"));

    let body = client.get(format!("http://127.0.0.1:{}/api/v2/users", proxy_port))
        .header("Host", "localhost").send().await.unwrap().text().await.unwrap();
    assert!(body.contains("SHORT_MATCH"));
}

#[tokio::test]
async fn test_proxy_no_mapping_404() {
    let dir = tempdir().unwrap();
    let proxy_port = get_unique_port();
    start_proxy(proxy_port, &dir.path().join("test.db"), &dir.path().join("certs")).await;

    let resp = reqwest::Client::new()
        .get(format!("http://127.0.0.1:{}/test", proxy_port))
        .header("Host", "unknown.example.com")
        .send().await.unwrap();

    assert_eq!(resp.status().as_u16(), 404);
}

#[tokio::test]
async fn test_proxy_missing_host_400() {
    let dir = tempdir().unwrap();
    let proxy_port = get_unique_port();
    start_proxy(proxy_port, &dir.path().join("test.db"), &dir.path().join("certs")).await;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    let mut stream = TcpStream::connect(format!("127.0.0.1:{}", proxy_port)).await.unwrap();
    stream.write_all(b"GET /test HTTP/1.1\r\n\r\n").await.unwrap();

    let mut buf = vec![0u8; 1024];
    let n = stream.read(&mut buf).await.unwrap();
    assert!(String::from_utf8_lossy(&buf[..n]).contains("400"));
}

#[tokio::test]
async fn test_proxy_x_forwarded_headers() {
    let dir = tempdir().unwrap();
    let proxy_port = get_unique_port();
    let backend_port = get_unique_port();

    let db = DatabaseManager::new(dir.path().join("test.db")).unwrap();
    add(&db, "example.com", "", backend_port, "");
    drop(db);

    let _backend = run_backend_server(backend_port, "HEADERS_TEST").await;
    start_proxy(proxy_port, &dir.path().join("test.db"), &dir.path().join("certs")).await;

    let body = reqwest::Client::new()
        .get(format!("http://127.0.0.1:{}/test", proxy_port))
        .header("Host", "example.com")
        .send().await.unwrap().text().await.unwrap();

    assert!(body.contains("host=example.com"));
    assert!(body.contains("xff=127.0.0.1"));
}

#[tokio::test]
async fn test_proxy_post_request() {
    let dir = tempdir().unwrap();
    let proxy_port = get_unique_port();
    let backend_port = get_unique_port();

    let db = DatabaseManager::new(dir.path().join("test.db")).unwrap();
    add(&db, "localhost", "", backend_port, "");
    drop(db);

    let _backend = run_backend_server(backend_port, "POST_TEST").await;
    start_proxy(proxy_port, &dir.path().join("test.db"), &dir.path().join("certs")).await;

    let resp = reqwest::Client::new()
        .post(format!("http://127.0.0.1:{}/api/data", proxy_port))
        .header("Host", "localhost")
        .body("test body content")
        .send().await.unwrap();

    assert!(resp.status().is_success());
}

#[tokio::test]
async fn test_proxy_query_string_preserved() {
    let dir = tempdir().unwrap();
    let proxy_port = get_unique_port();
    let backend_port = get_unique_port();

    let db = DatabaseManager::new(dir.path().join("test.db")).unwrap();
    add(&db, "localhost", "", backend_port, "");
    drop(db);

    let addr: SocketAddr = format!("127.0.0.1:{}", backend_port).parse().unwrap();
    let listener = TcpListener::bind(addr).await.unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else { continue };
            let io = TokioIo::new(stream);
            tokio::spawn(async move {
                let _ = http1::Builder::new()
                    .serve_connection(io, service_fn(|req: Request<Incoming>| async move {
                        let uri = req.uri().to_string();
                        Ok::<_, Infallible>(Response::builder().status(200)
                            .body(Full::new(Bytes::from(format!("URI={}", uri)))).unwrap())
                    }))
                    .await;
            });
        }
    });

    start_proxy(proxy_port, &dir.path().join("test.db"), &dir.path().join("certs")).await;

    let body = reqwest::Client::new()
        .get(format!("http://127.0.0.1:{}/api?foo=bar&baz=qux", proxy_port))
        .header("Host", "localhost")
        .send().await.unwrap().text().await.unwrap();

    assert!(body.contains("foo=bar"));
    assert!(body.contains("baz=qux"));
}

#[tokio::test]
async fn test_backend_unreachable_502() {
    let dir = tempdir().unwrap();
    let proxy_port = get_unique_port();
    let backend_port = get_unique_port();

    let db = DatabaseManager::new(dir.path().join("test.db")).unwrap();
    add(&db, "localhost", "", backend_port, "");
    drop(db);

    start_proxy(proxy_port, &dir.path().join("test.db"), &dir.path().join("certs")).await;

    let resp = reqwest::Client::new()
        .get(format!("http://127.0.0.1:{}/test", proxy_port))
        .header("Host", "localhost")
        .send().await.unwrap();

    assert_eq!(resp.status().as_u16(), 502);
}

// ── Database tests ────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_database_operations() {
    let dir = tempdir().unwrap();
    let db = DatabaseManager::new(dir.path().join("test.db")).unwrap();

    let m = db.add_mapping("test.com", "api", 3000, "v1", None, None, None, None, None).unwrap();
    assert_eq!(m.domain, "test.com");
    assert_eq!(m.back_port, 3000);

    assert_eq!(db.list_mappings(None).unwrap().len(), 1);
    assert!(db.find_mapping("test.com", "/api/users").unwrap().is_some());
    assert!(db.domain_exists("test.com").unwrap());
    assert!(!db.domain_exists("unknown.com").unwrap());

    assert_eq!(db.delete_mapping("test.com", Some("api")).unwrap(), 1);
    assert_eq!(db.list_mappings(None).unwrap().len(), 0);
}

// ── Wildcard and catch-all domain tests ───────────────────────────────────────

#[tokio::test]
async fn test_wildcard_domain_routing() {
    let dir = tempdir().unwrap();
    let proxy_port = get_unique_port();
    let backend_port = get_unique_port();

    let db = DatabaseManager::new(dir.path().join("test.db")).unwrap();
    add(&db, "*.example.com", "", backend_port, "");
    drop(db);

    let _backend = run_backend_server(backend_port, "WILDCARD").await;
    start_proxy(proxy_port, &dir.path().join("test.db"), &dir.path().join("certs")).await;

    // sub.example.com should match *.example.com
    let body = reqwest::Client::new()
        .get(format!("http://127.0.0.1:{}/test", proxy_port))
        .header("Host", "sub.example.com")
        .send().await.unwrap().text().await.unwrap();
    assert!(body.contains("WILDCARD"));

    // another.example.com should also match
    let body = reqwest::Client::new()
        .get(format!("http://127.0.0.1:{}/test", proxy_port))
        .header("Host", "another.example.com")
        .send().await.unwrap().text().await.unwrap();
    assert!(body.contains("WILDCARD"));
}

#[tokio::test]
async fn test_catchall_domain_routing() {
    let dir = tempdir().unwrap();
    let proxy_port = get_unique_port();
    let backend_port = get_unique_port();

    let db = DatabaseManager::new(dir.path().join("test.db")).unwrap();
    add(&db, "*", "", backend_port, "");
    drop(db);

    let _backend = run_backend_server(backend_port, "CATCHALL").await;
    start_proxy(proxy_port, &dir.path().join("test.db"), &dir.path().join("certs")).await;

    for host in &["random.example.com", "anything.net", "foo.bar.baz"] {
        let body = reqwest::Client::new()
            .get(format!("http://127.0.0.1:{}/test", proxy_port))
            .header("Host", *host)
            .send().await.unwrap().text().await.unwrap();
        assert!(body.contains("CATCHALL"), "host {} should match catch-all, got: {}", host, body);
    }
}

#[tokio::test]
async fn test_exact_domain_beats_catchall() {
    let dir = tempdir().unwrap();
    let proxy_port = get_unique_port();
    let exact_port = get_unique_port();
    let catchall_port = get_unique_port();

    let db = DatabaseManager::new(dir.path().join("test.db")).unwrap();
    add(&db, "specific.com", "", exact_port, "");
    add(&db, "*", "", catchall_port, "");
    drop(db);

    let _b1 = run_backend_server(exact_port, "EXACT").await;
    let _b2 = run_backend_server(catchall_port, "CATCHALL").await;
    start_proxy(proxy_port, &dir.path().join("test.db"), &dir.path().join("certs")).await;

    let client = reqwest::Client::new();

    let body = client.get(format!("http://127.0.0.1:{}/test", proxy_port))
        .header("Host", "specific.com").send().await.unwrap().text().await.unwrap();
    assert!(body.contains("EXACT"));

    let body = client.get(format!("http://127.0.0.1:{}/test", proxy_port))
        .header("Host", "other.com").send().await.unwrap().text().await.unwrap();
    assert!(body.contains("CATCHALL"));
}

// ── IP allowlist tests ────────────────────────────────────────────────────────

#[tokio::test]
async fn test_ip_allowlist_blocks_unlisted() {
    let dir = tempdir().unwrap();
    let proxy_port = get_unique_port();
    let backend_port = get_unique_port();

    let db = DatabaseManager::new(dir.path().join("test.db")).unwrap();
    // Allow only 10.0.0.1 — our test client is 127.0.0.1, so it should be blocked
    db.add_mapping("localhost", "", backend_port, "", None, None,
                   Some("10.0.0.1"), None, None).unwrap();
    drop(db);

    let _backend = run_backend_server(backend_port, "SHOULD_NOT_SEE").await;
    start_proxy(proxy_port, &dir.path().join("test.db"), &dir.path().join("certs")).await;

    let resp = reqwest::Client::new()
        .get(format!("http://127.0.0.1:{}/test", proxy_port))
        .header("Host", "localhost")
        .send().await.unwrap();

    assert_eq!(resp.status().as_u16(), 403);
}

#[tokio::test]
async fn test_ip_allowlist_allows_listed() {
    let dir = tempdir().unwrap();
    let proxy_port = get_unique_port();
    let backend_port = get_unique_port();

    let db = DatabaseManager::new(dir.path().join("test.db")).unwrap();
    // Allow loopback range
    db.add_mapping("localhost", "", backend_port, "", None, None,
                   Some("127.0.0.0/8"), None, None).unwrap();
    drop(db);

    let _backend = run_backend_server(backend_port, "ALLOWED").await;
    start_proxy(proxy_port, &dir.path().join("test.db"), &dir.path().join("certs")).await;

    let resp = reqwest::Client::new()
        .get(format!("http://127.0.0.1:{}/test", proxy_port))
        .header("Host", "localhost")
        .send().await.unwrap();

    assert!(resp.status().is_success());
    assert!(resp.text().await.unwrap().contains("ALLOWED"));
}

// ── Auth tests ────────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_bearer_auth_allowed() {
    let dir = tempdir().unwrap();
    let proxy_port = get_unique_port();
    let backend_port = get_unique_port();

    let creds = r#"[{"token":"secret-token"}]"#;
    let db = DatabaseManager::new(dir.path().join("test.db")).unwrap();
    db.add_mapping("localhost", "", backend_port, "", None, None,
                   None, Some("bearer"), Some(creds)).unwrap();
    drop(db);

    let _backend = run_backend_server(backend_port, "BEARER_OK").await;
    start_proxy(proxy_port, &dir.path().join("test.db"), &dir.path().join("certs")).await;

    let client = reqwest::Client::new();

    // No token → 401
    let resp = client.get(format!("http://127.0.0.1:{}/test", proxy_port))
        .header("Host", "localhost").send().await.unwrap();
    assert_eq!(resp.status().as_u16(), 401);

    // Wrong token → 401
    let resp = client.get(format!("http://127.0.0.1:{}/test", proxy_port))
        .header("Host", "localhost")
        .header("Authorization", "Bearer wrong-token")
        .send().await.unwrap();
    assert_eq!(resp.status().as_u16(), 401);

    // Correct token → 200
    let resp = client.get(format!("http://127.0.0.1:{}/test", proxy_port))
        .header("Host", "localhost")
        .header("Authorization", "Bearer secret-token")
        .send().await.unwrap();
    assert!(resp.status().is_success());
    assert!(resp.text().await.unwrap().contains("BEARER_OK"));
}

#[tokio::test]
async fn test_basic_auth() {
    let dir = tempdir().unwrap();
    let proxy_port = get_unique_port();
    let backend_port = get_unique_port();

    let creds = r#"[{"user":"admin","pass":"password123"}]"#;
    let db = DatabaseManager::new(dir.path().join("test.db")).unwrap();
    db.add_mapping("localhost", "", backend_port, "", None, None,
                   None, Some("basic"), Some(creds)).unwrap();
    drop(db);

    let _backend = run_backend_server(backend_port, "BASIC_OK").await;
    start_proxy(proxy_port, &dir.path().join("test.db"), &dir.path().join("certs")).await;

    let client = reqwest::Client::new();

    // No auth → 401
    let resp = client.get(format!("http://127.0.0.1:{}/test", proxy_port))
        .header("Host", "localhost").send().await.unwrap();
    assert_eq!(resp.status().as_u16(), 401);

    // Correct basic auth → 200
    let resp = client.get(format!("http://127.0.0.1:{}/test", proxy_port))
        .header("Host", "localhost")
        .basic_auth("admin", Some("password123"))
        .send().await.unwrap();
    assert!(resp.status().is_success());
    assert!(resp.text().await.unwrap().contains("BASIC_OK"));
}

#[tokio::test]
async fn test_password_auth_via_bearer() {
    let dir = tempdir().unwrap();
    let proxy_port = get_unique_port();
    let backend_port = get_unique_port();

    let creds = r#"[{"pass":"mypassword"}]"#;
    let db = DatabaseManager::new(dir.path().join("test.db")).unwrap();
    db.add_mapping("localhost", "", backend_port, "", None, None,
                   None, Some("password"), Some(creds)).unwrap();
    drop(db);

    let _backend = run_backend_server(backend_port, "PASS_OK").await;
    start_proxy(proxy_port, &dir.path().join("test.db"), &dir.path().join("certs")).await;

    let client = reqwest::Client::new();

    // Wrong password → 401
    let resp = client.get(format!("http://127.0.0.1:{}/test", proxy_port))
        .header("Host", "localhost")
        .header("Authorization", "Bearer wrongpass")
        .send().await.unwrap();
    assert_eq!(resp.status().as_u16(), 401);

    // Correct password via Bearer → 200
    let resp = client.get(format!("http://127.0.0.1:{}/test", proxy_port))
        .header("Host", "localhost")
        .header("Authorization", "Bearer mypassword")
        .send().await.unwrap();
    assert!(resp.status().is_success());
    assert!(resp.text().await.unwrap().contains("PASS_OK"));
}

#[tokio::test]
async fn test_auth_expiry() {
    let dir = tempdir().unwrap();
    let proxy_port = get_unique_port();
    let backend_port = get_unique_port();

    // Token expired in the past
    let creds = r#"[{"token":"expired","expires_at":"2020-01-01T00:00:00Z"}]"#;
    let db = DatabaseManager::new(dir.path().join("test.db")).unwrap();
    db.add_mapping("localhost", "", backend_port, "", None, None,
                   None, Some("bearer"), Some(creds)).unwrap();
    drop(db);

    let _backend = run_backend_server(backend_port, "SHOULD_NOT_REACH").await;
    start_proxy(proxy_port, &dir.path().join("test.db"), &dir.path().join("certs")).await;

    let resp = reqwest::Client::new()
        .get(format!("http://127.0.0.1:{}/test", proxy_port))
        .header("Host", "localhost")
        .header("Authorization", "Bearer expired")
        .send().await.unwrap();

    assert_eq!(resp.status().as_u16(), 401);
}

// ── HA round-robin tests ──────────────────────────────────────────────────────

#[tokio::test]
async fn test_ha_round_robin_both_up() {
    let dir = tempdir().unwrap();
    let proxy_port = get_unique_port();
    let port1 = get_unique_port();
    let port2 = get_unique_port();

    let db = DatabaseManager::new(dir.path().join("test.db")).unwrap();
    db.add_mapping("localhost", "", 0, "", None, Some(&format!("{},{}", port1, port2)),
                   None, None, None).unwrap();
    drop(db);

    let _b1 = run_backend_server(port1, "BACKEND1").await;
    let _b2 = run_backend_server(port2, "BACKEND2").await;
    start_proxy(proxy_port, &dir.path().join("test.db"), &dir.path().join("certs")).await;

    let client = reqwest::Client::new();
    let mut saw_b1 = false;
    let mut saw_b2 = false;

    for _ in 0..10 {
        let body = client.get(format!("http://127.0.0.1:{}/test", proxy_port))
            .header("Host", "localhost").send().await.unwrap().text().await.unwrap();
        if body.contains("BACKEND1") { saw_b1 = true; }
        if body.contains("BACKEND2") { saw_b2 = true; }
        if saw_b1 && saw_b2 { break; }
    }

    assert!(saw_b1, "BACKEND1 was never hit");
    assert!(saw_b2, "BACKEND2 was never hit");
}

#[tokio::test]
async fn test_ha_failover_dead_port() {
    let dir = tempdir().unwrap();
    let proxy_port = get_unique_port();
    let port_dead = get_unique_port(); // nothing running on this port
    let port_alive = get_unique_port();

    let db = DatabaseManager::new(dir.path().join("test.db")).unwrap();
    db.add_mapping("localhost", "", 0, "", None, Some(&format!("{},{}", port_dead, port_alive)),
                   None, None, None).unwrap();
    drop(db);

    let _b2 = run_backend_server(port_alive, "ALIVE").await;
    start_proxy(proxy_port, &dir.path().join("test.db"), &dir.path().join("certs")).await;

    // Should always get a response from the alive backend
    let client = reqwest::Client::new();
    for _ in 0..5 {
        let resp = client.get(format!("http://127.0.0.1:{}/test", proxy_port))
            .header("Host", "localhost").send().await.unwrap();
        assert!(resp.status().is_success());
        assert!(resp.text().await.unwrap().contains("ALIVE"));
    }
}

// ── Fallback / embedded-library tests ────────────────────────────────────────

/// A custom fallback that always returns 200 with a known body.
struct HelloFallback;

#[async_trait::async_trait]
impl FallbackHandler for HelloFallback {
    async fn handle(
        &self,
        _req: hyper::Request<hyper::body::Incoming>,
        _remote_addr: std::net::SocketAddr,
    ) -> Result<hyper::Response<http_body_util::Full<bytes::Bytes>>> {
        Ok(hyper::Response::builder()
            .status(200)
            .body(http_body_util::Full::new(bytes::Bytes::from("hello from fallback")))
            .unwrap())
    }
}

/// A fallback that always returns 500 — used to verify /health bypasses it.
struct PanicFallback;

#[async_trait::async_trait]
impl FallbackHandler for PanicFallback {
    async fn handle(
        &self,
        _req: hyper::Request<hyper::body::Incoming>,
        _remote_addr: std::net::SocketAddr,
    ) -> Result<hyper::Response<http_body_util::Full<bytes::Bytes>>> {
        Ok(hyper::Response::builder()
            .status(500)
            .body(http_body_util::Full::new(bytes::Bytes::from("fallback error")))
            .unwrap())
    }
}

#[tokio::test]
async fn test_fallback_called_when_no_mapping() {
    let dir = tempdir().unwrap();
    let proxy_port = get_unique_port();

    let server = Arc::new(ProxyBuilder::new()
        .db_path(dir.path().join("test.db"))
        .certs_dir(dir.path().join("certs"))
        .http_port(proxy_port)
        .fallback(HelloFallback)
        .build()
        .unwrap());

    tokio::spawn(async move { let _ = server.run().await; });
    sleep(Duration::from_millis(150)).await;

    let resp = reqwest::Client::new()
        .get(format!("http://127.0.0.1:{}/anything", proxy_port))
        .header("Host", "myapp.example.com")
        .send().await.unwrap();

    assert_eq!(resp.status().as_u16(), 200);
    assert_eq!(resp.text().await.unwrap(), "hello from fallback");
}

#[tokio::test]
async fn test_proxy_wins_over_fallback() {
    let dir = tempdir().unwrap();
    let proxy_port = get_unique_port();
    let backend_port = get_unique_port();

    let db = DatabaseManager::new(dir.path().join("test.db")).unwrap();
    add(&db, "localhost", "", backend_port, "");
    drop(db);

    let _backend = run_backend_server(backend_port, "PROXIED").await;

    let server = Arc::new(ProxyBuilder::new()
        .db_path(dir.path().join("test.db"))
        .certs_dir(dir.path().join("certs"))
        .http_port(proxy_port)
        .fallback(HelloFallback) // would return "hello from fallback" if called
        .build()
        .unwrap());

    tokio::spawn(async move { let _ = server.run().await; });
    sleep(Duration::from_millis(150)).await;

    let body = reqwest::Client::new()
        .get(format!("http://127.0.0.1:{}/test", proxy_port))
        .header("Host", "localhost")
        .send().await.unwrap().text().await.unwrap();

    assert!(body.contains("PROXIED"), "expected proxy response, got: {}", body);
}

#[tokio::test]
async fn test_health_check_bypasses_fallback() {
    let dir = tempdir().unwrap();
    let proxy_port = get_unique_port();

    let server = Arc::new(ProxyBuilder::new()
        .db_path(dir.path().join("test.db"))
        .certs_dir(dir.path().join("certs"))
        .http_port(proxy_port)
        .fallback(PanicFallback) // returns 500 if called
        .build()
        .unwrap());

    tokio::spawn(async move { let _ = server.run().await; });
    sleep(Duration::from_millis(150)).await;

    let resp = reqwest::Client::new()
        .get(format!("http://127.0.0.1:{}/health", proxy_port))
        .send().await.unwrap();

    assert_eq!(resp.status().as_u16(), 200);
    assert_eq!(resp.text().await.unwrap(), "OK");
}
