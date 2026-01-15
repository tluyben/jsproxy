//! Certificate manager for SSL/TLS certificate handling
//! Supports self-signed certificates and ACME (Let's Encrypt) integration

use anyhow::Result;
use dashmap::DashMap;
use rcgen::generate_simple_self_signed;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tokio::sync::Mutex as TokioMutex;
use tracing::info;

/// ACME challenge token storage
pub struct AcmeChallenge {
    pub token: String,
    pub key_authorization: String,
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
    rate_limits: DashMap<String, RateLimitState>,
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
            rate_limits: DashMap::new(),
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
