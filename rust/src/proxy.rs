//! Proxy server implementation
//! Handles HTTP/HTTPS reverse proxying with path rewriting, auth, IP allowlisting, and HA

use crate::certificate::CertificateManager;
use crate::database::{DatabaseManager, Mapping};
use anyhow::{Context, Result, anyhow};
use bytes::Bytes;
use dashmap::DashMap;
use http_body_util::{BodyExt, Empty, Full, combinators::BoxBody};
use hyper::body::Incoming;
use hyper::header::{HOST, UPGRADE, CONNECTION};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode, Uri, Version};
use hyper_util::rt::TokioIo;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tracing::{debug, error, info, warn};
use base64::{Engine as _, engine::general_purpose};
use url::Url;

/// Trait for handling requests that have no proxy mapping.
///
/// Implement this in your application and pass it to [`ProxyBuilder::fallback`] so that
/// unmatched requests fall through to your own routes instead of returning 404.
#[async_trait::async_trait]
pub trait FallbackHandler: Send + Sync + 'static {
    async fn handle(
        &self,
        req: Request<Incoming>,
        remote_addr: SocketAddr,
    ) -> Result<Response<Full<Bytes>>>;
}

/// Default fallback: returns `404 No mapping found`.
pub struct NotFoundFallback;

#[async_trait::async_trait]
impl FallbackHandler for NotFoundFallback {
    async fn handle(
        &self,
        _req: Request<Incoming>,
        _remote_addr: SocketAddr,
    ) -> Result<Response<Full<Bytes>>> {
        Ok(Response::builder()
            .status(StatusCode::NOT_FOUND)
            .header("Content-Type", "text/plain")
            .body(Full::new(Bytes::from("No mapping found")))
            .unwrap())
    }
}

/// Proxy server configuration
#[derive(Clone)]
pub struct ProxyConfig {
    pub http_port: u16,
    pub https_port: u16,
    pub enable_https: bool,
    pub force_https: bool,
    pub http_host: String,
}

impl Default for ProxyConfig {
    fn default() -> Self {
        Self {
            http_port: 8080,
            https_port: 8443,
            enable_https: false,
            force_https: false,
            http_host: "0.0.0.0".to_string(),
        }
    }
}

struct AuthResult {
    allowed: bool,
    credential_index: Option<usize>,
    /// "bearer" or "basic" — used for WWW-Authenticate header
    scheme: &'static str,
}

/// Proxy server
pub struct ProxyServer {
    config: ProxyConfig,
    db_manager: Arc<DatabaseManager>,
    cert_manager: Arc<CertificateManager>,
    /// HA: score per port key "{mapping_id}:{port}", range 0–100 (100 = healthy).
    port_scores: DashMap<String, u8>,
    /// HA: round-robin tie-break counters per mapping ID.
    rr_counters: DashMap<String, usize>,
    /// HA: set of port keys currently being background-probed.
    bg_checks: DashMap<String, ()>,
    /// Called when no DB mapping matches the request.
    fallback: Arc<dyn FallbackHandler>,
}

impl ProxyServer {
    pub fn new(
        config: ProxyConfig,
        db_manager: Arc<DatabaseManager>,
        cert_manager: Arc<CertificateManager>,
    ) -> Self {
        Self {
            config,
            db_manager,
            cert_manager,
            port_scores: DashMap::new(),
            rr_counters: DashMap::new(),
            bg_checks: DashMap::new(),
            fallback: Arc::new(NotFoundFallback),
        }
    }

    // ── HA helpers ──────────────────────────────────────────────────────────

    fn port_key(mapping_id: &str, port: u16) -> String {
        format!("{}:{}", mapping_id, port)
    }

    fn get_port_score(&self, mapping_id: &str, port: u16) -> u8 {
        self.port_scores.get(&Self::port_key(mapping_id, port)).map(|v| *v).unwrap_or(100)
    }

    fn boost_port(&self, mapping_id: &str, port: u16) {
        self.port_scores.insert(Self::port_key(mapping_id, port), 100);
    }

    fn penalize_port(&self, mapping_id: &str, port: u16) {
        self.port_scores.insert(Self::port_key(mapping_id, port), 0);
    }

    /// Return ports sorted best-score-first; round-robin as tie-break.
    fn ranked_ports(&self, mapping_id: &str, ports: &[u16]) -> Vec<u16> {
        let mut counter = self.rr_counters.entry(mapping_id.to_string()).or_insert(0);
        let i = *counter;
        *counter = i.wrapping_add(1);
        drop(counter);

        let n = ports.len();
        let mut rotated: Vec<u16> = ports[i % n..].iter().chain(ports[..i % n].iter()).copied().collect();
        rotated.sort_by_key(|&p| std::cmp::Reverse(self.get_port_score(mapping_id, p)));
        rotated
    }

    /// TCP-probe a port in the background until it responds; then set score to 50
    /// so the next real request gives it a try.
    fn start_background_check(self: Arc<Self>, mapping_id: String, port: u16, host: String) {
        let key = Self::port_key(&mapping_id, port);
        if self.bg_checks.contains_key(&key) {
            return;
        }
        self.bg_checks.insert(key.clone(), ());
        warn!("HA: port {} scored 0, starting background probe for mapping {}", port, mapping_id);

        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(2)).await;
            loop {
                if !self.bg_checks.contains_key(&key) {
                    break;
                }
                let addr = format!("{}:{}", host, port);
                match tokio::time::timeout(Duration::from_secs(3), TcpStream::connect(&addr)).await {
                    Ok(Ok(_)) => {
                        self.bg_checks.remove(&key);
                        self.port_scores.insert(key.clone(), 50);
                        info!("HA: port {} back up (score→50) for mapping {}", port, mapping_id);
                        break;
                    }
                    _ => {
                        tokio::time::sleep(Duration::from_secs(5)).await;
                    }
                }
            }
        });
    }

    /// Start the proxy server (binds its own listener — used in single-worker mode).
    pub async fn run(self: Arc<Self>) -> Result<()> {
        let http_addr: SocketAddr = format!("{}:{}", self.config.http_host, self.config.http_port).parse()?;
        info!("Proxy server starting on HTTP:{}", self.config.http_port);
        if self.config.enable_https {
            info!("HTTPS will be enabled on port {}", self.config.https_port);
        }
        let listener = TcpListener::bind(http_addr).await?;
        self.run_with_listener(listener).await
    }

    /// Accept loop on a pre-bound listener.
    /// Called by each worker thread when running in multi-worker mode.
    pub async fn run_with_listener(self: Arc<Self>, listener: TcpListener) -> Result<()> {
        info!("HTTP worker listening on {}", listener.local_addr()?);

        loop {
            let (stream, remote_addr) = listener.accept().await?;
            let proxy = self.clone();
            tokio::spawn(async move {
                if let Err(e) = Self::handle_connection(stream, remote_addr, proxy).await {
                    debug!("HTTP connection error from {}: {}", remote_addr, e);
                }
            });
        }
    }

    async fn handle_connection(
        stream: TcpStream,
        remote_addr: SocketAddr,
        proxy: Arc<Self>,
    ) -> Result<()> {
        let io = TokioIo::new(stream);
        http1::Builder::new()
            .preserve_header_case(true)
            .title_case_headers(false)
            .serve_connection(
                io,
                service_fn(move |req| {
                    let p = proxy.clone();
                    async move { Self::handle_request(req, remote_addr, p).await }
                }),
            )
            .await
            .map_err(|e| anyhow!("HTTP service error: {}", e))
    }

    async fn handle_request(
        req: Request<Incoming>,
        remote_addr: SocketAddr,
        proxy: Arc<Self>,
    ) -> Result<Response<BoxBody<Bytes, hyper::Error>>, Infallible> {
        match proxy.process_request(req, remote_addr).await {
            Ok(response) => Ok(response),
            Err(e) => {
                error!("Request error: {}", e);
                Ok(Self::error_response(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error"))
            }
        }
    }

    async fn process_request(
        self: &Arc<Self>,
        req: Request<Incoming>,
        remote_addr: SocketAddr,
    ) -> Result<Response<BoxBody<Bytes, hyper::Error>>> {
        let path = req.uri().path().to_string();
        let method = req.method().clone();

        debug!("{} {} from {}", method, path, remote_addr);

        // Health check
        if path == "/health" {
            return Ok(Self::text_response(StatusCode::OK, "OK"));
        }

        // ACME test challenge
        if path.starts_with("/.well-known/test-challenge/") {
            let token = path.strip_prefix("/.well-known/test-challenge/").unwrap_or("");
            return match self.cert_manager.get_test_challenge(token) {
                Some(v) => Ok(Self::text_response(StatusCode::OK, &v)),
                None => Ok(Self::error_response(StatusCode::NOT_FOUND, "Not found")),
            };
        }

        // ACME challenge
        if path.starts_with("/.well-known/acme-challenge/") {
            let token = path.strip_prefix("/.well-known/acme-challenge/").unwrap_or("");
            return match self.cert_manager.get_acme_challenge(token) {
                Some(k) => Ok(Self::text_response(StatusCode::OK, &k)),
                None => Ok(Self::error_response(StatusCode::NOT_FOUND, "Challenge not found")),
            };
        }

        // Force HTTPS redirect
        if self.config.force_https && !Self::is_https_request(&req) {
            let host = req.headers().get(HOST).and_then(|h| h.to_str().ok()).unwrap_or("");
            let location = format!("https://{}{}", host, req.uri().path_and_query().map(|pq| pq.as_str()).unwrap_or("/"));
            return Ok(Self::redirect_response(&location));
        }

        // Resolve host
        let host = req.headers()
            .get(HOST)
            .and_then(|h| h.to_str().ok())
            .map(|h| h.split(':').next().unwrap_or(h).to_string());

        let host = match host {
            Some(h) => h,
            None => return Ok(Self::error_response(StatusCode::BAD_REQUEST, "Missing Host header")),
        };

        // Find mapping
        let mapping = match self.db_manager.find_mapping(&host, &path)? {
            Some(m) => m,
            None => {
                let fb = self.fallback.handle(req, remote_addr).await?;
                return Ok(fb.map(|b| b.map_err(|never| match never {}).boxed()));
            }
        };

        // IP allowlist check
        let client_ip = Self::get_client_ip(&req, remote_addr);
        if !Self::is_ip_allowed(&client_ip, mapping.allowed_ips.as_deref()) {
            return Ok(Self::error_response(StatusCode::FORBIDDEN, "Forbidden"));
        }

        // Auth check
        let auth = Self::check_auth(&req, &mapping);
        if !auth.allowed {
            return Ok(Self::unauthorized_response(auth.scheme));
        }
        if let Some(idx) = auth.credential_index {
            let db = self.db_manager.clone();
            let mid = mapping.id.clone();
            tokio::task::spawn_blocking(move || db.record_auth_use(&mid, idx));
        }

        // WebSocket upgrade
        if Self::is_websocket_upgrade(&req) {
            return Self::handle_websocket_proxy(req, &mapping, remote_addr, false).await;
        }

        // HA round-robin across multiple ports
        if mapping.back_ports.is_some() {
            return self.ha_proxy_request(req, &mapping, remote_addr, false).await;
        }

        Self::proxy_request(req, &mapping, remote_addr, false).await
    }

    // ── Auth helpers ──────────────────────────────────────────────────────────

    fn check_auth(req: &Request<Incoming>, mapping: &Mapping) -> AuthResult {
        let auth_type = match mapping.auth_type.as_deref() {
            Some(t) => t,
            None => return AuthResult { allowed: true, credential_index: None, scheme: "basic" },
        };

        let creds: Vec<serde_json::Value> = mapping.auth_credentials
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_default();

        if creds.is_empty() {
            let scheme = if auth_type == "bearer" { "bearer" } else { "basic" };
            return AuthResult { allowed: false, credential_index: None, scheme };
        }

        let auth_header = req.headers()
            .get("authorization")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("");

        let now = chrono::Utc::now();

        let expired = |c: &serde_json::Value| -> bool {
            if let Some(exp) = c.get("expires_at").and_then(|v| v.as_str()) {
                if let Ok(expiry) = chrono::DateTime::parse_from_rfc3339(exp) {
                    return expiry < now;
                }
            }
            false
        };

        match auth_type {
            "bearer" => {
                if !auth_header.starts_with("Bearer ") {
                    return AuthResult { allowed: false, credential_index: None, scheme: "bearer" };
                }
                let token = auth_header[7..].trim();
                for (i, c) in creds.iter().enumerate() {
                    if c.get("token").and_then(|v| v.as_str()) == Some(token) && !expired(c) {
                        return AuthResult { allowed: true, credential_index: Some(i), scheme: "bearer" };
                    }
                }
                AuthResult { allowed: false, credential_index: None, scheme: "bearer" }
            }

            "basic" => {
                if !auth_header.starts_with("Basic ") {
                    return AuthResult { allowed: false, credential_index: None, scheme: "basic" };
                }
                let decoded = match general_purpose::STANDARD.decode(auth_header[6..].trim()) {
                    Ok(b) => String::from_utf8_lossy(&b).to_string(),
                    Err(_) => return AuthResult { allowed: false, credential_index: None, scheme: "basic" },
                };
                let idx = decoded.find(':').unwrap_or(decoded.len());
                let user = &decoded[..idx];
                let pass = if idx < decoded.len() { &decoded[idx + 1..] } else { "" };

                for (i, c) in creds.iter().enumerate() {
                    let cu = c.get("user").and_then(|v| v.as_str()).unwrap_or("");
                    let cp = c.get("pass").and_then(|v| v.as_str()).unwrap_or("");
                    if cu == user && cp == pass && !expired(c) {
                        return AuthResult { allowed: true, credential_index: Some(i), scheme: "basic" };
                    }
                }
                AuthResult { allowed: false, credential_index: None, scheme: "basic" }
            }

            "password" => {
                let pass: Option<&str> = if auth_header.starts_with("Bearer ") {
                    Some(auth_header[7..].trim())
                } else if auth_header.starts_with("Basic ") {
                    // Extract password from Base64 "user:pass" (take everything after last ':')
                    general_purpose::STANDARD.decode(auth_header[6..].trim())
                        .ok()
                        .and_then(|b| String::from_utf8(b).ok())
                        .map(|s| {
                            let idx = s.rfind(':').map(|i| i + 1).unwrap_or(0);
                            s[idx..].to_string()
                        })
                        .as_deref()
                        .map(|_| "") // placeholder — see below
                } else {
                    None
                };

                // Re-decode cleanly to avoid lifetime issues
                let pass_owned: Option<String> = if auth_header.starts_with("Bearer ") {
                    Some(auth_header[7..].trim().to_string())
                } else if auth_header.starts_with("Basic ") {
                    general_purpose::STANDARD.decode(auth_header[6..].trim())
                        .ok()
                        .and_then(|b| String::from_utf8(b).ok())
                        .map(|s| {
                            let idx = s.rfind(':').map(|i| i + 1).unwrap_or(0);
                            s[idx..].to_string()
                        })
                } else {
                    None
                };
                let _ = pass; // unused, using pass_owned

                let pass_str = match &pass_owned {
                    Some(p) => p.as_str(),
                    None => return AuthResult { allowed: false, credential_index: None, scheme: "basic" },
                };

                for (i, c) in creds.iter().enumerate() {
                    let cp = c.get("pass").and_then(|v| v.as_str()).unwrap_or("");
                    if cp == pass_str && !expired(c) {
                        return AuthResult { allowed: true, credential_index: Some(i), scheme: "basic" };
                    }
                }
                AuthResult { allowed: false, credential_index: None, scheme: "basic" }
            }

            _ => AuthResult { allowed: false, credential_index: None, scheme: "basic" },
        }
    }

    // ── IP allowlist helpers ──────────────────────────────────────────────────

    fn get_client_ip(req: &Request<Incoming>, remote_addr: SocketAddr) -> String {
        if let Some(xff) = req.headers().get("x-forwarded-for") {
            if let Ok(v) = xff.to_str() {
                let ip = v.split(',').next().unwrap_or("").trim().to_string();
                if !ip.is_empty() {
                    return ip;
                }
            }
        }
        let ip = remote_addr.ip().to_string();
        // Strip IPv6-mapped IPv4 prefix
        if let Some(stripped) = ip.strip_prefix("::ffff:") {
            return stripped.to_string();
        }
        ip
    }

    fn is_ip_allowed(client_ip: &str, allowed_ips: Option<&str>) -> bool {
        let list = match allowed_ips {
            Some(s) if !s.trim().is_empty() => s,
            _ => return true,
        };
        list.split(',')
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .any(|entry| {
                if entry.contains('/') {
                    Self::ip_in_cidr(client_ip, entry)
                } else {
                    client_ip == entry
                }
            })
    }

    fn ip_in_cidr(ip: &str, cidr: &str) -> bool {
        let mut parts = cidr.splitn(2, '/');
        let range = parts.next().unwrap_or("");
        let bits: u32 = parts.next().and_then(|b| b.parse().ok()).unwrap_or(32);
        let mask = if bits == 0 { 0u32 } else { (!0u32) << (32 - bits) };
        match (Self::ip_to_u32(ip), Self::ip_to_u32(range)) {
            (Some(a), Some(b)) => (a & mask) == (b & mask),
            _ => false,
        }
    }

    fn ip_to_u32(ip: &str) -> Option<u32> {
        let mut octets = ip.splitn(4, '.');
        let a: u32 = octets.next()?.parse().ok()?;
        let b: u32 = octets.next()?.parse().ok()?;
        let c: u32 = octets.next()?.parse().ok()?;
        let d: u32 = octets.next()?.parse().ok()?;
        Some((a << 24) | (b << 16) | (c << 8) | d)
    }

    // ── Request helpers ───────────────────────────────────────────────────────

    fn is_https_request<T>(req: &Request<T>) -> bool {
        if let Some(proto) = req.headers().get("x-forwarded-proto") {
            if proto.to_str().ok() == Some("https") { return true; }
        }
        if let Some(ssl) = req.headers().get("x-forwarded-ssl") {
            if ssl.to_str().ok() == Some("on") { return true; }
        }
        if let Some(https) = req.headers().get("front-end-https") {
            if https.to_str().ok() == Some("on") { return true; }
        }
        false
    }

    fn is_websocket_upgrade<T>(req: &Request<T>) -> bool {
        req.headers().get(UPGRADE)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.eq_ignore_ascii_case("websocket"))
            .unwrap_or(false)
    }

    // ── Path rewriting ────────────────────────────────────────────────────────

    fn rewrite_path(path: &str, mapping: &Mapping) -> String {
        let mut result = path.to_string();

        if !mapping.front_uri.is_empty() {
            let front_pattern = format!("/{}", mapping.front_uri);
            if result.starts_with(&front_pattern) {
                result = result[front_pattern.len()..].to_string();
                if result.is_empty() { result = "/".to_string(); }
            }
        }

        if !mapping.back_uri.is_empty() {
            result = format!("/{}{}", mapping.back_uri, result);
        }

        while result.contains("//") {
            result = result.replace("//", "/");
        }

        if !result.starts_with('/') {
            result = format!("/{}", result);
        }
        if result.is_empty() {
            result = "/".to_string();
        }
        result
    }

    fn build_backend_url(mapping: &Mapping, path: &str, query: Option<&str>) -> String {
        let backend = mapping.backend.as_deref().unwrap_or("http://localhost");
        let rewritten_path = Self::rewrite_path(path, mapping);
        let mut url = format!("{}:{}{}", backend, mapping.back_port, rewritten_path);
        if let Some(q) = query {
            url = format!("{}?{}", url, q);
        }
        url
    }

    // ── Core proxy ────────────────────────────────────────────────────────────

    async fn proxy_request(
        req: Request<Incoming>,
        mapping: &Mapping,
        remote_addr: SocketAddr,
        is_https: bool,
    ) -> Result<Response<BoxBody<Bytes, hyper::Error>>> {
        let is_get = req.method() == hyper::Method::GET;
        let original_host = req.headers().get(HOST).and_then(|h| h.to_str().ok()).unwrap_or("").to_string();

        let path = req.uri().path().to_string();
        let query = req.uri().query().map(|q| q.to_string());
        let backend_url = Self::build_backend_url(mapping, &path, query.as_deref());

        debug!("Proxying to: {}", backend_url);

        let url: Url = backend_url.parse().context("Invalid backend URL")?;
        let host = url.host_str().unwrap_or("localhost");
        let port = url.port().unwrap_or(if url.scheme() == "https" { 443 } else { 80 });

        let stream = match TcpStream::connect(format!("{}:{}", host, port)).await {
            Ok(s) => s,
            Err(e) => {
                error!("Failed to connect to backend: {}", e);
                return Ok(Self::error_response(StatusCode::BAD_GATEWAY, "Bad Gateway"));
            }
        };

        let (parts, body) = req.into_parts();
        let body_bytes = match body.collect().await {
            Ok(b) => b.to_bytes(),
            Err(_) => return Ok(Self::error_response(StatusCode::BAD_REQUEST, "Bad Request")),
        };

        let rewritten_path = Self::rewrite_path(parts.uri.path(), mapping);
        let uri_str = match query.as_deref() {
            Some(q) => format!("{}?{}", rewritten_path, q),
            None => rewritten_path,
        };
        let uri: Uri = uri_str.parse().context("Invalid URI")?;

        let mut builder = Request::builder().method(parts.method).uri(uri).version(Version::HTTP_11);
        for (key, value) in parts.headers.iter() {
            if key != HOST { builder = builder.header(key, value); }
        }
        builder = builder.header(HOST, &original_host);
        builder = builder.header("X-Forwarded-For", remote_addr.ip().to_string());
        builder = builder.header("X-Forwarded-Host", &original_host);
        builder = builder.header("X-Forwarded-Proto", if is_https { "https" } else { "http" });

        let proxy_req = builder.body(Full::new(body_bytes)).context("Failed to build proxy request")?;

        let io = TokioIo::new(stream);
        let (mut sender, conn) = hyper::client::conn::http1::handshake(io).await
            .context("Failed to establish connection to backend")?;
        tokio::spawn(async move { let _ = conn.await; });

        let response = match sender.send_request(proxy_req).await {
            Ok(r) => r,
            Err(e) => {
                error!("Failed to send request to backend: {}", e);
                return Ok(Self::error_response(StatusCode::BAD_GATEWAY, "Bad Gateway"));
            }
        };

        let (parts, body) = response.into_parts();
        let body_bytes = body.collect().await
            .map(|b| b.to_bytes())
            .unwrap_or_else(|_| Bytes::new());

        let mut builder = Response::builder().status(parts.status);
        for (key, value) in parts.headers.iter() {
            builder = builder.header(key, value);
        }

        // Cache headers (CACHE_HEADERS=true env var)
        if is_get && std::env::var("CACHE_HEADERS").ok().as_deref() == Some("true") {
            let expiry = std::env::var("CACHE_EXPIRY").ok();
            let infinite = expiry.as_deref().map(|e| e == "-1" || e.is_empty()).unwrap_or(true);
            if infinite {
                builder = builder.header("cache-control", "public, max-age=31536000, immutable");
                builder = builder.header("expires", "Thu, 31 Dec 2099 23:59:59 GMT");
            } else if let Some(mins) = expiry.as_deref().and_then(|e| e.parse::<u64>().ok()) {
                builder = builder.header("cache-control", format!("public, max-age={}", mins * 60));
            }
        }

        Ok(builder.body(Self::full_body(body_bytes)).context("Failed to build response")?)
    }

    /// Try a single backend port; returns (status, headers, body) or an error.
    async fn try_port(
        method: hyper::Method,
        uri: Uri,
        headers: hyper::HeaderMap,
        body_bytes: Bytes,
        host: &str,
        port: u16,
        remote_addr: SocketAddr,
        is_https: bool,
    ) -> Result<(StatusCode, hyper::HeaderMap, Bytes)> {
        let addr = format!("{}:{}", host, port);
        let stream = TcpStream::connect(&addr).await
            .map_err(|e| anyhow!("connect {}: {}", addr, e))?;

        let mut builder = Request::builder().method(method).uri(uri).version(Version::HTTP_11);
        for (key, value) in headers.iter() {
            if key != HOST { builder = builder.header(key, value); }
        }
        builder = builder.header(HOST, format!("{}:{}", host, port));
        builder = builder.header("X-Forwarded-For", remote_addr.ip().to_string());
        builder = builder.header("X-Forwarded-Proto", if is_https { "https" } else { "http" });

        let proxy_req = builder.body(Full::new(body_bytes)).context("Failed to build proxy request")?;
        let io = TokioIo::new(stream);
        let (mut sender, conn) = hyper::client::conn::http1::handshake(io).await
            .context("Handshake failed")?;
        tokio::spawn(async move { let _ = conn.await; });

        let response = sender.send_request(proxy_req).await.context("send_request failed")?;
        let (parts, body) = response.into_parts();
        let body_bytes = body.collect().await.context("Failed to read response body")?.to_bytes();

        Ok((parts.status, parts.headers, body_bytes))
    }

    /// HA score-based proxy: tries ports best-score-first, first port that responds wins.
    /// Connection failures penalize the port and start a background probe.
    async fn ha_proxy_request(
        self: &Arc<Self>,
        req: Request<Incoming>,
        mapping: &Mapping,
        remote_addr: SocketAddr,
        is_https: bool,
    ) -> Result<Response<BoxBody<Bytes, hyper::Error>>> {
        let back_ports_str = mapping.back_ports.as_deref().unwrap_or("");
        let all_ports: Vec<u16> = back_ports_str
            .split(',')
            .filter_map(|s| s.trim().parse().ok())
            .collect();

        if all_ports.is_empty() {
            return Ok(Self::error_response(StatusCode::INTERNAL_SERVER_ERROR, "HA: no ports configured"));
        }

        let path = req.uri().path().to_string();
        let query = req.uri().query().map(|q| q.to_string());
        let rewritten_path = Self::rewrite_path(&path, mapping);
        let uri_str = match query.as_deref() {
            Some(q) => format!("{}?{}", rewritten_path, q),
            None => rewritten_path,
        };
        let uri: Uri = uri_str.parse().context("Invalid URI")?;

        let (parts, body) = req.into_parts();
        let body_bytes = body.collect().await.context("Failed to read request body")?.to_bytes();

        let backend = mapping.backend.as_deref().unwrap_or("http://localhost");
        let backend_url: Url = backend.parse().unwrap_or_else(|_| "http://localhost".parse().unwrap());
        let backend_host = backend_url.host_str().unwrap_or("localhost").to_string();

        let ordered = self.ranked_ports(&mapping.id, &all_ports);

        for &port in &ordered {
            match Self::try_port(
                parts.method.clone(),
                uri.clone(),
                parts.headers.clone(),
                body_bytes.clone(),
                &backend_host,
                port,
                remote_addr,
                is_https,
            ).await {
                Ok((status, headers, body)) => {
                    self.boost_port(&mapping.id, port);
                    return Ok(Self::build_ha_response(status, headers, body));
                }
                Err(e) => {
                    warn!("HA: port {} failed: {}", port, e);
                    self.penalize_port(&mapping.id, port);
                    self.clone().start_background_check(
                        mapping.id.clone(), port, backend_host.clone()
                    );
                }
            }
        }

        Ok(Self::error_response(StatusCode::BAD_GATEWAY, "Bad Gateway: all backends unavailable"))
    }

    fn build_ha_response(
        status: StatusCode,
        headers: hyper::HeaderMap,
        body: Bytes,
    ) -> Response<BoxBody<Bytes, hyper::Error>> {
        let skip = ["transfer-encoding", "connection", "keep-alive", "upgrade", "trailer"];
        let mut builder = Response::builder().status(status);
        for (key, value) in headers.iter() {
            if !skip.contains(&key.as_str()) {
                builder = builder.header(key, value);
            }
        }
        builder.body(Self::full_body(body)).unwrap()
    }

    /// Handle WebSocket proxy
    async fn handle_websocket_proxy(
        req: Request<Incoming>,
        mapping: &Mapping,
        remote_addr: SocketAddr,
        is_https: bool,
    ) -> Result<Response<BoxBody<Bytes, hyper::Error>>> {
        let original_host = req.headers().get(HOST).and_then(|h| h.to_str().ok()).unwrap_or("").to_string();
        let path = req.uri().path();
        let query = req.uri().query();
        let backend_url = Self::build_backend_url(mapping, path, query);

        debug!("WebSocket proxying to: {}", backend_url);

        let url: Url = backend_url.parse().context("Invalid backend URL")?;
        let host = url.host_str().unwrap_or("localhost");
        let port = url.port().unwrap_or(80);

        let backend_stream = match TcpStream::connect(format!("{}:{}", host, port)).await {
            Ok(s) => s,
            Err(e) => {
                error!("Failed to connect to backend {}: {}", format!("{}:{}", host, port), e);
                return Ok(Self::error_response(StatusCode::BAD_GATEWAY, "Bad Gateway"));
            }
        };

        let rewritten_path = Self::rewrite_path(path, mapping);
        let uri_str = if let Some(q) = query {
            format!("{}?{}", rewritten_path, q)
        } else {
            rewritten_path
        };

        let mut upgrade_req = format!("GET {} HTTP/1.1\r\nHost: {}\r\n", uri_str, original_host);
        for (key, value) in req.headers().iter() {
            if key != HOST {
                if let Ok(v) = value.to_str() {
                    upgrade_req.push_str(&format!("{}: {}\r\n", key.as_str(), v));
                }
            }
        }
        upgrade_req.push_str(&format!("X-Forwarded-For: {}\r\n", remote_addr.ip()));
        upgrade_req.push_str(&format!("X-Forwarded-Host: {}\r\n", original_host));
        upgrade_req.push_str(&format!("X-Forwarded-Proto: {}\r\n", if is_https { "https" } else { "http" }));
        upgrade_req.push_str("\r\n");

        let mut backend_stream = backend_stream;
        backend_stream.write_all(upgrade_req.as_bytes()).await?;

        let mut response_buf = vec![0u8; 4096];
        let n = backend_stream.read(&mut response_buf).await?;
        let response_str = String::from_utf8_lossy(&response_buf[..n]);

        if !response_str.contains("101") {
            warn!("WebSocket upgrade rejected by backend");
            return Ok(Self::error_response(StatusCode::BAD_GATEWAY, "WebSocket upgrade failed"));
        }

        Ok(Response::builder()
            .status(StatusCode::SWITCHING_PROTOCOLS)
            .header(UPGRADE, "websocket")
            .header(CONNECTION, "Upgrade")
            .body(Self::empty_body())
            .context("Failed to build WebSocket response")?)
    }

    // ── Response builders ─────────────────────────────────────────────────────

    fn text_response(status: StatusCode, body: &str) -> Response<BoxBody<Bytes, hyper::Error>> {
        Response::builder()
            .status(status)
            .header("Content-Type", "text/plain")
            .body(Self::full_body(Bytes::from(body.to_string())))
            .unwrap()
    }

    fn error_response(status: StatusCode, message: &str) -> Response<BoxBody<Bytes, hyper::Error>> {
        Response::builder()
            .status(status)
            .header("Content-Type", "text/plain")
            .body(Self::full_body(Bytes::from(message.to_string())))
            .unwrap()
    }

    fn unauthorized_response(scheme: &str) -> Response<BoxBody<Bytes, hyper::Error>> {
        let www_auth = if scheme == "bearer" {
            "Bearer realm=\"Proxy\""
        } else {
            "Basic realm=\"Proxy\""
        };
        Response::builder()
            .status(StatusCode::UNAUTHORIZED)
            .header("Content-Type", "text/plain")
            .header("WWW-Authenticate", www_auth)
            .body(Self::full_body(Bytes::from("Unauthorized")))
            .unwrap()
    }

    fn redirect_response(location: &str) -> Response<BoxBody<Bytes, hyper::Error>> {
        Response::builder()
            .status(StatusCode::MOVED_PERMANENTLY)
            .header("Location", location)
            .body(Self::empty_body())
            .unwrap()
    }

    fn full_body(bytes: Bytes) -> BoxBody<Bytes, hyper::Error> {
        Full::new(bytes).map_err(|never| match never {}).boxed()
    }

    fn empty_body() -> BoxBody<Bytes, hyper::Error> {
        Empty::<Bytes>::new().map_err(|never| match never {}).boxed()
    }
}

// ── ProxyBuilder ──────────────────────────────────────────────────────────────

/// Ergonomic builder for creating a [`ProxyServer`], optionally with a custom
/// [`FallbackHandler`] for embedding rustproxy inside another application.
pub struct ProxyBuilder {
    config: ProxyConfig,
    db_path: std::path::PathBuf,
    certs_dir: std::path::PathBuf,
    acme_directory_url: Option<String>,
    fallback: Option<Arc<dyn FallbackHandler>>,
}

impl Default for ProxyBuilder {
    fn default() -> Self { Self::new() }
}

impl ProxyBuilder {
    pub fn new() -> Self {
        Self {
            config: ProxyConfig::default(),
            db_path: "./data/current.db".into(),
            certs_dir: "./certs".into(),
            acme_directory_url: None,
            fallback: None,
        }
    }

    pub fn db_path(mut self, p: impl Into<std::path::PathBuf>) -> Self { self.db_path = p.into(); self }
    pub fn certs_dir(mut self, p: impl Into<std::path::PathBuf>) -> Self { self.certs_dir = p.into(); self }
    pub fn http_port(mut self, port: u16) -> Self { self.config.http_port = port; self }
    pub fn https_port(mut self, port: u16) -> Self { self.config.https_port = port; self }
    pub fn enable_https(mut self, v: bool) -> Self { self.config.enable_https = v; self }
    pub fn force_https(mut self, v: bool) -> Self { self.config.force_https = v; self }
    pub fn http_host(mut self, h: impl Into<String>) -> Self { self.config.http_host = h.into(); self }
    pub fn acme_directory_url(mut self, url: impl Into<String>) -> Self { self.acme_directory_url = Some(url.into()); self }

    /// Set a custom fallback handler for requests with no proxy mapping.
    pub fn fallback(mut self, h: impl FallbackHandler) -> Self {
        self.fallback = Some(Arc::new(h));
        self
    }

    pub fn build(self) -> Result<ProxyServer> {
        let db_manager = Arc::new(crate::database::DatabaseManager::new(&self.db_path)?);
        let cert_manager = Arc::new(crate::certificate::CertificateManager::new(
            &self.certs_dir, self.acme_directory_url,
        )?);
        Ok(ProxyServer {
            config: self.config,
            db_manager,
            cert_manager,
            port_scores: DashMap::new(),
            rr_counters: DashMap::new(),
            bg_checks: DashMap::new(),
            fallback: self.fallback.unwrap_or_else(|| Arc::new(NotFoundFallback)),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mapping(front_uri: &str, back_uri: &str) -> Mapping {
        Mapping {
            id: "test".to_string(),
            domain: "example.com".to_string(),
            front_uri: front_uri.to_string(),
            back_port: 3000,
            back_uri: back_uri.to_string(),
            backend: None,
            back_ports: None,
            allowed_ips: None,
            auth_type: None,
            auth_credentials: None,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn test_rewrite_path_with_front_and_back() {
        assert_eq!(ProxyServer::rewrite_path("/api/v1/users", &mapping("api/v1", "v1")), "/v1/users");
    }

    #[test]
    fn test_rewrite_path_front_only() {
        assert_eq!(ProxyServer::rewrite_path("/api/users", &mapping("api", "")), "/users");
    }

    #[test]
    fn test_rewrite_path_back_only() {
        assert_eq!(ProxyServer::rewrite_path("/users", &mapping("", "api")), "/api/users");
    }

    #[test]
    fn test_rewrite_path_no_change() {
        assert_eq!(ProxyServer::rewrite_path("/users", &mapping("", "")), "/users");
    }

    #[test]
    fn test_build_backend_url() {
        assert_eq!(
            ProxyServer::build_backend_url(&mapping("api", "v1"), "/api/users", Some("id=1")),
            "http://localhost:3000/v1/users?id=1"
        );
    }

    #[test]
    fn test_is_ip_allowed_empty() {
        assert!(ProxyServer::is_ip_allowed("1.2.3.4", None));
        assert!(ProxyServer::is_ip_allowed("1.2.3.4", Some("")));
    }

    #[test]
    fn test_is_ip_allowed_exact() {
        assert!(ProxyServer::is_ip_allowed("1.2.3.4", Some("1.2.3.4")));
        assert!(!ProxyServer::is_ip_allowed("1.2.3.5", Some("1.2.3.4")));
    }

    #[test]
    fn test_is_ip_allowed_cidr() {
        assert!(ProxyServer::is_ip_allowed("192.168.1.50", Some("192.168.1.0/24")));
        assert!(!ProxyServer::is_ip_allowed("192.168.2.50", Some("192.168.1.0/24")));
    }

    #[test]
    fn test_is_ip_allowed_multiple() {
        assert!(ProxyServer::is_ip_allowed("10.0.0.1", Some("10.0.0.1,192.168.0.0/24")));
        assert!(ProxyServer::is_ip_allowed("192.168.0.100", Some("10.0.0.1,192.168.0.0/24")));
        assert!(!ProxyServer::is_ip_allowed("8.8.8.8", Some("10.0.0.1,192.168.0.0/24")));
    }
}
