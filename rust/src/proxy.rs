//! Proxy server implementation
//! Handles HTTP/HTTPS reverse proxying with path rewriting

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
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tracing::{debug, error, info, warn};
use url::Url;

const DEAD_PORT_TTL: Duration = Duration::from_secs(30);

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

/// Proxy server
pub struct ProxyServer {
    config: ProxyConfig,
    db_manager: Arc<DatabaseManager>,
    cert_manager: Arc<CertificateManager>,
    /// HA: dead port tracking. Key: "{mapping_id}:{port}", Value: time of death.
    dead_ports: DashMap<String, Instant>,
    /// HA: round-robin counters per mapping ID.
    rr_counters: DashMap<String, usize>,
}

impl ProxyServer {
    /// Create a new proxy server
    pub fn new(
        config: ProxyConfig,
        db_manager: Arc<DatabaseManager>,
        cert_manager: Arc<CertificateManager>,
    ) -> Self {
        Self {
            config,
            db_manager,
            cert_manager,
            dead_ports: DashMap::new(),
            rr_counters: DashMap::new(),
        }
    }

    // ── HA helpers ──────────────────────────────────────────────────────────

    fn is_port_dead(&self, mapping_id: &str, port: u16) -> bool {
        let key = format!("{}:{}", mapping_id, port);
        if let Some(dead_at) = self.dead_ports.get(&key) {
            if dead_at.elapsed() < DEAD_PORT_TTL {
                return true;
            }
            drop(dead_at);
            self.dead_ports.remove(&key);
        }
        false
    }

    fn mark_port_dead(&self, mapping_id: &str, port: u16) {
        warn!("HA: marking port {} dead for mapping {}", port, mapping_id);
        self.dead_ports.insert(format!("{}:{}", mapping_id, port), Instant::now());
    }

    fn next_rr_index(&self, mapping_id: &str, count: usize) -> usize {
        let mut entry = self.rr_counters.entry(mapping_id.to_string()).or_insert(0);
        let idx = *entry % count;
        *entry = idx + 1;
        idx
    }

    /// Start the proxy server
    pub async fn run(self: Arc<Self>) -> Result<()> {
        let http_addr: SocketAddr = format!("{}:{}", self.config.http_host, self.config.http_port).parse()?;

        info!("Proxy server starting on HTTP:{}", self.config.http_port);

        if self.config.enable_https {
            info!("HTTPS will be enabled on port {}", self.config.https_port);
        }

        // Run HTTP server (main server for this implementation)
        self.run_http_server(http_addr).await
    }

    /// Run HTTP server
    async fn run_http_server(self: Arc<Self>, addr: SocketAddr) -> Result<()> {
        let listener = TcpListener::bind(addr).await?;
        info!("HTTP server listening on {}", addr);

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

    /// Handle a single HTTP connection
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
                    async move {
                        Self::handle_request(req, remote_addr, p).await
                    }
                }),
            )
            .await
            .map_err(|e| anyhow!("HTTP service error: {}", e))
    }

    /// Handle incoming request
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

    /// Process request
    async fn process_request(
        self: &Arc<Self>,
        req: Request<Incoming>,
        remote_addr: SocketAddr,
    ) -> Result<Response<BoxBody<Bytes, hyper::Error>>> {
        let db_manager = &self.db_manager;
        let cert_manager = &self.cert_manager;
        let config = &self.config;
        let path = req.uri().path().to_string();
        let method = req.method().clone();

        debug!("{} {} from {}", method, path, remote_addr);

        // Health check endpoint
        if path == "/health" {
            return Ok(Self::text_response(StatusCode::OK, "OK"));
        }

        // ACME reachability test endpoint — DO NOT proxy
        if path.starts_with("/.well-known/test-challenge/") {
            let token = path.strip_prefix("/.well-known/test-challenge/").unwrap_or("");
            if let Some(value) = cert_manager.get_test_challenge(token) {
                return Ok(Self::text_response(StatusCode::OK, &value));
            }
            return Ok(Self::error_response(StatusCode::NOT_FOUND, "Not found"));
        }

        // ACME challenge endpoint
        if path.starts_with("/.well-known/acme-challenge/") {
            let token = path.strip_prefix("/.well-known/acme-challenge/").unwrap_or("");
            if let Some(key_auth) = cert_manager.get_acme_challenge(token) {
                return Ok(Self::text_response(StatusCode::OK, &key_auth));
            }
            return Ok(Self::error_response(StatusCode::NOT_FOUND, "Challenge not found"));
        }

        // Get host header
        let host = req.headers()
            .get(HOST)
            .and_then(|h| h.to_str().ok())
            .map(|h| h.split(':').next().unwrap_or(h).to_string());

        let host = match host {
            Some(h) => h,
            None => return Ok(Self::error_response(StatusCode::BAD_REQUEST, "Missing Host header")),
        };

        // Force HTTPS redirect
        if config.force_https && !Self::is_https_request(&req) {
            let location = format!("https://{}{}", host, req.uri().path_and_query().map(|pq| pq.as_str()).unwrap_or("/"));
            return Ok(Self::redirect_response(&location));
        }

        // Find mapping
        let mapping = match db_manager.find_mapping(&host, &path)? {
            Some(m) => m,
            None => return Ok(Self::error_response(StatusCode::NOT_FOUND, "No mapping found")),
        };

        // Check for WebSocket upgrade
        if Self::is_websocket_upgrade(&req) {
            return Self::handle_websocket_proxy(req, &mapping, remote_addr, false).await;
        }

        // HA round-robin across multiple ports
        if mapping.back_ports.is_some() {
            return self.ha_proxy_request(req, &mapping, remote_addr, false).await;
        }

        // Proxy the request
        Self::proxy_request(req, &mapping, remote_addr, false).await
    }

    /// Check if request is from HTTPS (via proxy headers)
    fn is_https_request<T>(req: &Request<T>) -> bool {
        if let Some(proto) = req.headers().get("x-forwarded-proto") {
            if proto.to_str().ok() == Some("https") {
                return true;
            }
        }
        if let Some(ssl) = req.headers().get("x-forwarded-ssl") {
            if ssl.to_str().ok() == Some("on") {
                return true;
            }
        }
        if let Some(https) = req.headers().get("front-end-https") {
            if https.to_str().ok() == Some("on") {
                return true;
            }
        }
        false
    }

    /// Check if request is WebSocket upgrade
    fn is_websocket_upgrade<T>(req: &Request<T>) -> bool {
        if let Some(upgrade) = req.headers().get(UPGRADE) {
            if upgrade.to_str().ok().map(|s| s.eq_ignore_ascii_case("websocket")).unwrap_or(false) {
                return true;
            }
        }
        false
    }

    /// Rewrite path based on mapping
    fn rewrite_path(path: &str, mapping: &Mapping) -> String {
        let mut result = path.to_string();

        // Strip front_uri from path
        if !mapping.front_uri.is_empty() {
            let front_pattern = format!("/{}", mapping.front_uri);
            if result.starts_with(&front_pattern) {
                result = result[front_pattern.len()..].to_string();
            }
        }

        // Prepend back_uri
        if !mapping.back_uri.is_empty() {
            result = format!("/{}{}", mapping.back_uri, result);
        }

        // Normalize slashes
        while result.contains("//") {
            result = result.replace("//", "/");
        }

        // Ensure starts with /
        if !result.starts_with('/') {
            result = format!("/{}", result);
        }

        if result.is_empty() {
            result = "/".to_string();
        }

        result
    }

    /// Build backend URL
    fn build_backend_url(mapping: &Mapping, path: &str, query: Option<&str>) -> String {
        let backend = mapping.backend.as_deref().unwrap_or("http://localhost");
        let rewritten_path = Self::rewrite_path(path, mapping);

        let mut url = format!("{}:{}{}", backend, mapping.back_port, rewritten_path);

        if let Some(q) = query {
            url = format!("{}?{}", url, q);
        }

        url
    }

    /// Proxy the request to backend
    async fn proxy_request(
        req: Request<Incoming>,
        mapping: &Mapping,
        remote_addr: SocketAddr,
        is_https: bool,
    ) -> Result<Response<BoxBody<Bytes, hyper::Error>>> {
        let is_get = req.method() == hyper::Method::GET;
        let original_host = req.headers()
            .get(HOST)
            .and_then(|h| h.to_str().ok())
            .unwrap_or("")
            .to_string();

        let path = req.uri().path().to_string();
        let query = req.uri().query().map(|q| q.to_string());
        let backend_url = Self::build_backend_url(mapping, &path, query.as_deref());

        debug!("Proxying to: {}", backend_url);

        // Parse backend URL
        let url: Url = backend_url.parse()
            .context("Invalid backend URL")?;

        let host = url.host_str().unwrap_or("localhost");
        let port = url.port().unwrap_or(if url.scheme() == "https" { 443 } else { 80 });

        // Connect to backend
        let addr = format!("{}:{}", host, port);
        let stream = match TcpStream::connect(&addr).await {
            Ok(s) => s,
            Err(e) => {
                error!("Failed to connect to backend {}: {}", addr, e);
                return Ok(Self::error_response(StatusCode::BAD_GATEWAY, "Bad Gateway"));
            }
        };

        // Build proxied request
        let (parts, body) = req.into_parts();

        // Collect body
        let body_bytes = match body.collect().await {
            Ok(b) => b.to_bytes(),
            Err(e) => {
                error!("Failed to read request body: {}", e);
                return Ok(Self::error_response(StatusCode::BAD_REQUEST, "Bad Request"));
            }
        };

        let rewritten_path = Self::rewrite_path(parts.uri.path(), mapping);
        let uri_str = if let Some(ref q) = query {
            format!("{}?{}", rewritten_path, q)
        } else {
            rewritten_path
        };

        let uri: Uri = uri_str.parse().context("Invalid URI")?;

        let mut builder = Request::builder()
            .method(parts.method)
            .uri(uri)
            .version(Version::HTTP_11);

        // Copy headers
        for (key, value) in parts.headers.iter() {
            if key != HOST {
                builder = builder.header(key, value);
            }
        }

        // Set forwarding headers
        builder = builder.header(HOST, &original_host);
        builder = builder.header("X-Forwarded-For", remote_addr.ip().to_string());
        builder = builder.header("X-Forwarded-Host", &original_host);
        builder = builder.header("X-Forwarded-Proto", if is_https { "https" } else { "http" });

        let proxy_req = builder.body(Full::new(body_bytes))
            .context("Failed to build proxy request")?;

        // Send request to backend
        let io = TokioIo::new(stream);

        let (mut sender, conn) = hyper::client::conn::http1::handshake(io).await
            .context("Failed to establish connection to backend")?;

        tokio::spawn(async move {
            if let Err(e) = conn.await {
                debug!("Backend connection error: {}", e);
            }
        });

        let response = match sender.send_request(proxy_req).await {
            Ok(r) => r,
            Err(e) => {
                error!("Failed to send request to backend: {}", e);
                return Ok(Self::error_response(StatusCode::BAD_GATEWAY, "Bad Gateway"));
            }
        };

        // Convert response
        let (parts, body) = response.into_parts();

        let body_bytes = match body.collect().await {
            Ok(b) => b.to_bytes(),
            Err(e) => {
                error!("Failed to read response body: {}", e);
                return Ok(Self::error_response(StatusCode::BAD_GATEWAY, "Bad Gateway"));
            }
        };

        let mut builder = Response::builder().status(parts.status);

        for (key, value) in parts.headers.iter() {
            builder = builder.header(key, value);
        }

        // Apply cache headers for GET responses when CACHE_HEADERS=true
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

        let response = builder.body(Self::full_body(body_bytes))
            .context("Failed to build response")?;

        Ok(response)
    }

    /// Try a single backend port; returns (status, headers, body) or an error.
    async fn try_port(
        method: hyper::Method,
        uri: Uri,
        headers: hyper::HeaderMap,
        body_bytes: Bytes,
        host: String,
        port: u16,
        remote_addr: SocketAddr,
        is_https: bool,
    ) -> Result<(StatusCode, hyper::HeaderMap, Bytes)> {
        let addr = format!("{}:{}", host, port);
        let stream = TcpStream::connect(&addr).await
            .map_err(|e| anyhow!("connect {}: {}", addr, e))?;

        let mut builder = Request::builder()
            .method(method)
            .uri(uri)
            .version(Version::HTTP_11);

        for (key, value) in headers.iter() {
            if key != HOST {
                builder = builder.header(key, value);
            }
        }

        // Patch Host to point at this specific port
        builder = builder.header(HOST, format!("{}:{}", host, port));
        builder = builder.header("X-Forwarded-For", remote_addr.ip().to_string());
        builder = builder.header("X-Forwarded-Proto", if is_https { "https" } else { "http" });

        let proxy_req = builder.body(Full::new(body_bytes))
            .context("Failed to build proxy request")?;

        let io = TokioIo::new(stream);
        let (mut sender, conn) = hyper::client::conn::http1::handshake(io).await
            .context("Handshake failed")?;

        tokio::spawn(async move { let _ = conn.await; });

        let response = sender.send_request(proxy_req).await
            .context("send_request failed")?;

        let (parts, body) = response.into_parts();
        let body_bytes = body.collect().await
            .context("Failed to read response body")?.to_bytes();

        Ok((parts.status, parts.headers, body_bytes))
    }

    /// HA round-robin proxy: tries ports in order, first 2xx wins;
    /// falls back to best response by status class.
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

        // Collect request parts upfront so body can be replayed
        let original_host = req.headers()
            .get(HOST)
            .and_then(|h| h.to_str().ok())
            .unwrap_or("")
            .to_string();

        let path = req.uri().path().to_string();
        let query = req.uri().query().map(|q| q.to_string());
        let rewritten_path = Self::rewrite_path(&path, mapping);
        let uri_str = match query.as_deref() {
            Some(q) => format!("{}?{}", rewritten_path, q),
            None => rewritten_path,
        };
        let uri: Uri = uri_str.parse().context("Invalid URI")?;

        let (parts, body) = req.into_parts();
        let body_bytes = body.collect().await
            .context("Failed to read request body")?.to_bytes();

        let backend = mapping.backend.as_deref().unwrap_or("http://localhost");
        let backend_url: Url = backend.parse().unwrap_or_else(|_| "http://localhost".parse().unwrap());
        let backend_host = backend_url.host_str().unwrap_or("localhost").to_string();

        // Build alive port list in round-robin order
        let alive: Vec<u16> = all_ports.iter()
            .copied()
            .filter(|&p| !self.is_port_dead(&mapping.id, p))
            .collect();

        let ordered: Vec<u16> = if alive.is_empty() {
            all_ports.clone()
        } else {
            let start = self.next_rr_index(&mapping.id, alive.len());
            alive[start..].iter().chain(alive[..start].iter()).copied().collect()
        };

        let mut results: Vec<(StatusCode, hyper::HeaderMap, Bytes)> = Vec::new();

        for &port in &ordered {
            match Self::try_port(
                parts.method.clone(),
                uri.clone(),
                parts.headers.clone(),
                body_bytes.clone(),
                backend_host.clone(),
                port,
                remote_addr,
                is_https,
            ).await {
                Ok((status, headers, body)) => {
                    if status.is_success() {
                        // First 2xx wins immediately
                        return Ok(Self::build_response(status, headers, body));
                    }
                    results.push((status, headers, body));
                }
                Err(e) => {
                    // Treat connection-level failures as dead ports
                    let msg = e.to_string();
                    if msg.contains("connect") || msg.contains("refused") || msg.contains("os error") {
                        self.mark_port_dead(&mapping.id, port);
                    }
                }
            }
        }

        if results.is_empty() {
            return Ok(Self::error_response(StatusCode::BAD_GATEWAY, "Bad Gateway: all backends unavailable"));
        }

        // Pick best by status class: 2xx < 3xx < 4xx < 5xx
        results.sort_by_key(|(s, _, _)| s.as_u16());
        let (status, headers, body) = results.remove(0);
        Ok(Self::build_response(status, headers, body))
    }

    /// Build a response from raw parts (used by HA path)
    fn build_response(
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
        let original_host = req.headers()
            .get(HOST)
            .and_then(|h| h.to_str().ok())
            .unwrap_or("")
            .to_string();

        let path = req.uri().path();
        let query = req.uri().query();
        let backend_url = Self::build_backend_url(mapping, path, query);

        debug!("WebSocket proxying to: {}", backend_url);

        // Parse backend URL
        let url: Url = backend_url.parse()
            .context("Invalid backend URL")?;

        let host = url.host_str().unwrap_or("localhost");
        let port = url.port().unwrap_or(80);

        // Connect to backend
        let addr = format!("{}:{}", host, port);
        let backend_stream = match TcpStream::connect(&addr).await {
            Ok(s) => s,
            Err(e) => {
                error!("Failed to connect to backend {}: {}", addr, e);
                return Ok(Self::error_response(StatusCode::BAD_GATEWAY, "Bad Gateway"));
            }
        };

        // Build upgrade request for backend
        let rewritten_path = Self::rewrite_path(path, mapping);
        let uri_str = if let Some(q) = query {
            format!("{}?{}", rewritten_path, q)
        } else {
            rewritten_path
        };

        let mut upgrade_req = format!(
            "GET {} HTTP/1.1\r\nHost: {}\r\n",
            uri_str, original_host
        );

        // Copy relevant headers
        for (key, value) in req.headers().iter() {
            if key != HOST {
                if let Ok(v) = value.to_str() {
                    upgrade_req.push_str(&format!("{}: {}\r\n", key.as_str(), v));
                }
            }
        }

        // Add forwarding headers
        upgrade_req.push_str(&format!("X-Forwarded-For: {}\r\n", remote_addr.ip()));
        upgrade_req.push_str(&format!("X-Forwarded-Host: {}\r\n", original_host));
        upgrade_req.push_str(&format!("X-Forwarded-Proto: {}\r\n", if is_https { "https" } else { "http" }));
        upgrade_req.push_str("\r\n");

        let mut backend_stream = backend_stream;
        backend_stream.write_all(upgrade_req.as_bytes()).await?;

        // Read response from backend
        let mut response_buf = vec![0u8; 4096];
        let n = backend_stream.read(&mut response_buf).await?;
        let response_str = String::from_utf8_lossy(&response_buf[..n]);

        // Check if upgrade was accepted
        if !response_str.contains("101") {
            warn!("WebSocket upgrade rejected by backend");
            return Ok(Self::error_response(StatusCode::BAD_GATEWAY, "WebSocket upgrade failed"));
        }

        // Return 101 Switching Protocols
        let response = Response::builder()
            .status(StatusCode::SWITCHING_PROTOCOLS)
            .header(UPGRADE, "websocket")
            .header(CONNECTION, "Upgrade")
            .body(Self::empty_body())
            .context("Failed to build WebSocket response")?;

        Ok(response)
    }

    /// Create text response
    fn text_response(status: StatusCode, body: &str) -> Response<BoxBody<Bytes, hyper::Error>> {
        Response::builder()
            .status(status)
            .header("Content-Type", "text/plain")
            .body(Self::full_body(Bytes::from(body.to_string())))
            .unwrap()
    }

    /// Create error response
    fn error_response(status: StatusCode, message: &str) -> Response<BoxBody<Bytes, hyper::Error>> {
        Response::builder()
            .status(status)
            .header("Content-Type", "text/plain")
            .body(Self::full_body(Bytes::from(message.to_string())))
            .unwrap()
    }

    /// Create redirect response
    fn redirect_response(location: &str) -> Response<BoxBody<Bytes, hyper::Error>> {
        Response::builder()
            .status(StatusCode::MOVED_PERMANENTLY)
            .header("Location", location)
            .body(Self::empty_body())
            .unwrap()
    }

    /// Create full body
    fn full_body(bytes: Bytes) -> BoxBody<Bytes, hyper::Error> {
        Full::new(bytes)
            .map_err(|never| match never {})
            .boxed()
    }

    /// Create empty body
    fn empty_body() -> BoxBody<Bytes, hyper::Error> {
        Empty::<Bytes>::new()
            .map_err(|never| match never {})
            .boxed()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rewrite_path_with_front_and_back() {
        let mapping = Mapping {
            id: "test".to_string(),
            domain: "example.com".to_string(),
            front_uri: "api/v1".to_string(),
            back_port: 3000,
            back_uri: "v1".to_string(),
            backend: None,
            back_ports: None,
            created_at: String::new(),
            updated_at: String::new(),
        };

        assert_eq!(ProxyServer::rewrite_path("/api/v1/users", &mapping), "/v1/users");
    }

    #[test]
    fn test_rewrite_path_front_only() {
        let mapping = Mapping {
            id: "test".to_string(),
            domain: "example.com".to_string(),
            front_uri: "api".to_string(),
            back_port: 3000,
            back_uri: "".to_string(),
            backend: None,
            back_ports: None,
            created_at: String::new(),
            updated_at: String::new(),
        };

        assert_eq!(ProxyServer::rewrite_path("/api/users", &mapping), "/users");
    }

    #[test]
    fn test_rewrite_path_back_only() {
        let mapping = Mapping {
            id: "test".to_string(),
            domain: "example.com".to_string(),
            front_uri: "".to_string(),
            back_port: 3000,
            back_uri: "api".to_string(),
            backend: None,
            back_ports: None,
            created_at: String::new(),
            updated_at: String::new(),
        };

        assert_eq!(ProxyServer::rewrite_path("/users", &mapping), "/api/users");
    }

    #[test]
    fn test_rewrite_path_no_change() {
        let mapping = Mapping {
            id: "test".to_string(),
            domain: "example.com".to_string(),
            front_uri: "".to_string(),
            back_port: 3000,
            back_uri: "".to_string(),
            backend: None,
            back_ports: None,
            created_at: String::new(),
            updated_at: String::new(),
        };

        assert_eq!(ProxyServer::rewrite_path("/users", &mapping), "/users");
    }

    #[test]
    fn test_build_backend_url() {
        let mapping = Mapping {
            id: "test".to_string(),
            domain: "example.com".to_string(),
            front_uri: "api".to_string(),
            back_port: 3000,
            back_uri: "v1".to_string(),
            backend: None,
            back_ports: None,
            created_at: String::new(),
            updated_at: String::new(),
        };

        assert_eq!(
            ProxyServer::build_backend_url(&mapping, "/api/users", Some("id=1")),
            "http://localhost:3000/v1/users?id=1"
        );
    }

    #[test]
    fn test_build_backend_url_external() {
        let mapping = Mapping {
            id: "test".to_string(),
            domain: "example.com".to_string(),
            front_uri: "".to_string(),
            back_port: 8080,
            back_uri: "".to_string(),
            backend: Some("https://api.external.com".to_string()),
            back_ports: None,
            created_at: String::new(),
            updated_at: String::new(),
        };

        assert_eq!(
            ProxyServer::build_backend_url(&mapping, "/users", None),
            "https://api.external.com:8080/users"
        );
    }
}
