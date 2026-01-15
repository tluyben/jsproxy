//! Proxy server implementation
//! Handles HTTP/HTTPS reverse proxying with path rewriting

use crate::certificate::CertificateManager;
use crate::database::{DatabaseManager, Mapping};
use anyhow::{Context, Result, anyhow};
use bytes::Bytes;
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
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tracing::{debug, error, info, warn};
use url::Url;

/// Proxy server configuration
#[derive(Clone)]
pub struct ProxyConfig {
    pub http_port: u16,
    pub https_port: u16,
    pub enable_https: bool,
    pub force_https: bool,
}

impl Default for ProxyConfig {
    fn default() -> Self {
        Self {
            http_port: 8080,
            https_port: 8443,
            enable_https: false,
            force_https: false,
        }
    }
}

/// Proxy server
pub struct ProxyServer {
    config: ProxyConfig,
    db_manager: Arc<DatabaseManager>,
    cert_manager: Arc<CertificateManager>,
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
        }
    }

    /// Start the proxy server
    pub async fn run(self: Arc<Self>) -> Result<()> {
        let http_addr: SocketAddr = format!("0.0.0.0:{}", self.config.http_port).parse()?;

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
            let db = self.db_manager.clone();
            let cert = self.cert_manager.clone();
            let config = self.config.clone();

            tokio::spawn(async move {
                if let Err(e) = Self::handle_connection(stream, remote_addr, db, cert, config).await {
                    debug!("HTTP connection error from {}: {}", remote_addr, e);
                }
            });
        }
    }

    /// Handle a single HTTP connection
    async fn handle_connection(
        stream: TcpStream,
        remote_addr: SocketAddr,
        db_manager: Arc<DatabaseManager>,
        cert_manager: Arc<CertificateManager>,
        config: ProxyConfig,
    ) -> Result<()> {
        let io = TokioIo::new(stream);

        http1::Builder::new()
            .preserve_header_case(true)
            .title_case_headers(false)
            .serve_connection(
                io,
                service_fn(move |req| {
                    let db = db_manager.clone();
                    let cert = cert_manager.clone();
                    let cfg = config.clone();
                    async move {
                        Self::handle_request(req, remote_addr, db, cert, cfg).await
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
        db_manager: Arc<DatabaseManager>,
        cert_manager: Arc<CertificateManager>,
        config: ProxyConfig,
    ) -> Result<Response<BoxBody<Bytes, hyper::Error>>, Infallible> {
        match Self::process_request(req, remote_addr, &db_manager, &cert_manager, &config).await {
            Ok(response) => Ok(response),
            Err(e) => {
                error!("Request error: {}", e);
                Ok(Self::error_response(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error"))
            }
        }
    }

    /// Process request
    async fn process_request(
        req: Request<Incoming>,
        remote_addr: SocketAddr,
        db_manager: &DatabaseManager,
        cert_manager: &CertificateManager,
        config: &ProxyConfig,
    ) -> Result<Response<BoxBody<Bytes, hyper::Error>>> {
        let path = req.uri().path().to_string();
        let method = req.method().clone();

        debug!("{} {} from {}", method, path, remote_addr);

        // Health check endpoint
        if path == "/health" {
            return Ok(Self::text_response(StatusCode::OK, "OK"));
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

        let response = builder.body(Self::full_body(body_bytes))
            .context("Failed to build response")?;

        Ok(response)
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
            created_at: String::new(),
            updated_at: String::new(),
        };

        assert_eq!(
            ProxyServer::build_backend_url(&mapping, "/users", None),
            "https://api.external.com:8080/users"
        );
    }
}
