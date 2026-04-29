//! Certificate manager for SSL/TLS certificate handling
//! Supports self-signed certificates and ACME (Let's Encrypt) integration

use anyhow::Result;
use dashmap::DashMap;
use rcgen::generate_simple_self_signed;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex as TokioMutex;
use tracing::{info, warn};

/// ACME challenge token storage
pub struct AcmeChallenge {
    pub token: String,
    pub key_authorization: String,
}

/// Cached result of an ACME HTTP-01 reachability probe for a domain
struct AcmeCapableEntry {
    capable: bool,
    probed_at: Instant,
}

/// Rate limiting state for certificate requests
struct RateLimitState {
    last_request: Instant,
    weekly_count: u32,
    week_start: Instant,
}

/// Certificate manager for handling SSL certificates
pub struct CertificateManager {
    certs_dir: PathBuf,
    acme_challenges: DashMap<String, AcmeChallenge>,
    /// In-flight ACME HTTP-01 reachability test challenges: token -> value
    test_challenges: DashMap<String, String>,
    rate_limits: DashMap<String, RateLimitState>,
    /// ACME HTTP-01 capability cache: domain -> { capable, probed_at }
    acme_capable: DashMap<String, AcmeCapableEntry>,
    /// Domains with an in-progress background re-probe (deduplicate concurrent spawns)
    reprobing_domains: DashMap<String, ()>,
    #[allow(dead_code)]
    acme_directory_url: String,
    #[allow(dead_code)]
    acme_lock: TokioMutex<()>,
}

// Implement Send and Sync
unsafe impl Send for CertificateManager {}
unsafe impl Sync for CertificateManager {}

impl CertificateManager {
    /// Create a new certificate manager
    pub fn new<P: AsRef<Path>>(certs_dir: P, acme_directory_url: Option<String>) -> Result<Self> {
        let certs_dir = certs_dir.as_ref().to_path_buf();
        fs::create_dir_all(&certs_dir)?;

        let manager = Self {
            certs_dir,
            acme_challenges: DashMap::new(),
            test_challenges: DashMap::new(),
            rate_limits: DashMap::new(),
            acme_capable: DashMap::new(),
            reprobing_domains: DashMap::new(),
            acme_directory_url: acme_directory_url.unwrap_or_else(|| {
                "https://acme-v02.api.letsencrypt.org/directory".to_string()
            }),
            acme_lock: TokioMutex::new(()),
        };

        // Create default certificate if not exists
        manager.ensure_default_cert()?;

        Ok(manager)
    }

    /// Ensure default certificate exists
    fn ensure_default_cert(&self) -> Result<()> {
        let cert_path = self.certs_dir.join("localhost.crt");
        let key_path = self.certs_dir.join("localhost.key");

        if !cert_path.exists() || !key_path.exists() {
            info!("Generating default self-signed certificate");
            self.generate_self_signed("localhost", &["localhost"])?;
        }

        Ok(())
    }

    /// Generate a self-signed certificate
    pub fn generate_self_signed(&self, domain: &str, san: &[&str]) -> Result<()> {
        let subject_alt_names: Vec<String> = san.iter().map(|s| s.to_string()).collect();

        let cert = generate_simple_self_signed(subject_alt_names)?;

        let cert_pem = cert.serialize_pem()?;
        let key_pem = cert.serialize_private_key_pem();

        // Save to disk
        let cert_path = self.certs_dir.join(format!("{}.crt", Self::sanitize_domain(domain)));
        let key_path = self.certs_dir.join(format!("{}.key", Self::sanitize_domain(domain)));
        fs::write(&cert_path, &cert_pem)?;
        fs::write(&key_path, &key_pem)?;

        info!("Generated self-signed certificate for: {}", domain);

        Ok(())
    }

    /// Sanitize domain name for filesystem
    fn sanitize_domain(domain: &str) -> String {
        domain.replace('*', "wildcard")
    }

    /// Check if domain is rate limited
    #[allow(dead_code)]
    fn is_rate_limited(&self, domain: &str) -> bool {
        if let Some(state) = self.rate_limits.get(domain) {
            let now = Instant::now();

            // Check 5-minute cooldown
            if now.duration_since(state.last_request) < Duration::from_secs(5 * 60) {
                return true;
            }

            // Check weekly limit (5 per week)
            if now.duration_since(state.week_start) < Duration::from_secs(7 * 24 * 60 * 60) {
                if state.weekly_count >= 5 {
                    return true;
                }
            }
        }
        false
    }

    /// Update rate limit state
    #[allow(dead_code)]
    fn update_rate_limit(&self, domain: &str) {
        let now = Instant::now();
        self.rate_limits.entry(domain.to_string())
            .and_modify(|state| {
                // Reset weekly count if week has passed
                if now.duration_since(state.week_start) >= Duration::from_secs(7 * 24 * 60 * 60) {
                    state.week_start = now;
                    state.weekly_count = 1;
                } else {
                    state.weekly_count += 1;
                }
                state.last_request = now;
            })
            .or_insert(RateLimitState {
                last_request: now,
                weekly_count: 1,
                week_start: now,
            });
    }

    /// Store an ACME HTTP-01 reachability test challenge
    pub fn store_test_challenge(&self, token: &str, value: &str) {
        self.test_challenges.insert(token.to_string(), value.to_string());
    }

    /// Get an ACME HTTP-01 reachability test challenge value
    pub fn get_test_challenge(&self, token: &str) -> Option<String> {
        self.test_challenges.get(token).map(|v| v.clone())
    }

    /// Remove an ACME HTTP-01 reachability test challenge
    pub fn remove_test_challenge(&self, token: &str) {
        self.test_challenges.remove(token);
    }

    /// Store ACME challenge token
    pub fn store_acme_challenge(&self, token: &str, key_authorization: &str) {
        self.acme_challenges.insert(token.to_string(), AcmeChallenge {
            token: token.to_string(),
            key_authorization: key_authorization.to_string(),
        });
    }

    /// Get ACME challenge response
    pub fn get_acme_challenge(&self, token: &str) -> Option<String> {
        self.acme_challenges.get(token).map(|c| c.key_authorization.clone())
    }

    /// Remove ACME challenge
    #[allow(dead_code)]
    pub fn remove_acme_challenge(&self, token: &str) {
        self.acme_challenges.remove(token);
    }

    /// Get certs directory path
    #[allow(dead_code)]
    pub fn certs_dir(&self) -> &Path {
        &self.certs_dir
    }

    /// Test whether `domain` is reachable on port 80 via HTTP-01 challenge.
    ///
    /// - Returns `true` immediately if a successful probe is cached.
    /// - Returns `false` immediately if a failed probe is still within its 15-minute TTL,
    ///   but kicks off a background re-probe so recovery is eventually detected.
    /// - Runs a synchronous probe on the first call for this domain.
    pub async fn test_acme_capability(self: &Arc<Self>, domain: &str) -> bool {
        const FAILURE_TTL: Duration = Duration::from_secs(15 * 60);

        if let Some(entry) = self.acme_capable.get(domain) {
            if entry.capable {
                return true;
            }
            if entry.probed_at.elapsed() < FAILURE_TTL {
                return false;
            }
            drop(entry);
            // TTL expired — re-probe in background, serve self-signed for now
            Self::reprobe_acme_capability_background(Arc::clone(self), domain.to_string());
            return false;
        }

        self.run_probe(domain).await
    }

    fn reprobe_acme_capability_background(this: Arc<Self>, domain: String) {
        if this.reprobing_domains.contains_key(&domain) {
            return;
        }
        this.reprobing_domains.insert(domain.clone(), ());
        tokio::spawn(async move {
            let capable = this.run_probe(&domain).await;
            if capable {
                info!("ACME capability restored for {} — cleared self-signed block", domain);
                // No in-memory cert cache exists in the Rust version; disk is authoritative.
            }
            this.reprobing_domains.remove(&domain);
        });
    }

    async fn run_probe(&self, domain: &str) -> bool {
        let token = uuid::Uuid::new_v4().simple().to_string();
        let value = uuid::Uuid::new_v4().simple().to_string();
        self.store_test_challenge(&token, &value);

        let capable = self.do_probe(domain, &token, &value).await;
        self.remove_test_challenge(&token);

        if capable {
            info!("ACME HTTP-01 reachability confirmed for {}", domain);
        } else {
            warn!("ACME HTTP-01 not reachable for {}", domain);
        }

        self.acme_capable.insert(domain.to_string(), AcmeCapableEntry {
            capable,
            probed_at: Instant::now(),
        });

        capable
    }

    async fn do_probe(&self, domain: &str, token: &str, value: &str) -> bool {
        let url = format!("http://{}/.well-known/test-challenge/{}", domain, token);
        let client = match reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
        {
            Ok(c) => c,
            Err(_) => return false,
        };
        match client.get(&url).send().await {
            Ok(resp) if resp.status().is_success() => {
                resp.text().await.map(|b| b.trim() == value).unwrap_or(false)
            }
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_generate_self_signed() {
        let dir = tempdir().unwrap();
        let manager = CertificateManager::new(dir.path(), None).unwrap();

        manager.generate_self_signed("example.com", &["example.com", "www.example.com"]).unwrap();

        assert!(dir.path().join("example.com.crt").exists());
        assert!(dir.path().join("example.com.key").exists());
    }

    #[test]
    fn test_sanitize_domain() {
        assert_eq!(CertificateManager::sanitize_domain("example.com"), "example.com");
        assert_eq!(CertificateManager::sanitize_domain("*.example.com"), "wildcard.example.com");
    }

    #[test]
    fn test_acme_challenge_storage() {
        let dir = tempdir().unwrap();
        let manager = CertificateManager::new(dir.path(), None).unwrap();

        manager.store_acme_challenge("token123", "key_auth_value");

        let result = manager.get_acme_challenge("token123");
        assert_eq!(result, Some("key_auth_value".to_string()));

        manager.remove_acme_challenge("token123");
        assert!(manager.get_acme_challenge("token123").is_none());
    }
}
