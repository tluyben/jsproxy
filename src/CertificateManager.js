const acme = require('acme-client');
const forge = require('node-forge');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

class CertificateManager {
  constructor(logger, dbManager) {
    this.logger = logger;
    this.db = dbManager; // Need access to check main domains
    this.certificates = new Map();
    this.challenges = new Map(); // Store ACME challenges in memory
    this.certsDir = './certs';
    this.acmeClient = null;
    this.accountKey = null;
    this.processingDomains = new Set();
    this.lastCertRequest = new Map(); // Track last cert request time per domain
    this.certRequestCount = new Map(); // Track request count per domain
    this.wildcardCerts = new Map(); // Track wildcard certificates
  }

  async initialize() {
    await this.ensureCertsDirectory();
    await this.initializeAcmeClient();
    await this.loadExistingCertificates();
  }

  async ensureCertsDirectory() {
    try {
      await fs.access(this.certsDir);
    } catch (error) {
      await fs.mkdir(this.certsDir, { recursive: true });
      this.logger.info(`Created certificates directory: ${this.certsDir}`);
    }
  }

  async acquireLock(lockPath, timeout = 5000) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      try {
        // Try to create lock file (will fail if exists)
        await fs.writeFile(lockPath, process.pid.toString(), { flag: 'wx' });
        return true;
      } catch (error) {
        // Lock exists, wait and retry
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    return false;
  }

  async initializeAcmeClient() {
    try {
      const accountKeyPath = path.join(this.certsDir, 'account-key.pem');
      
      // Read or create account key (this part was working)
      try {
        const accountKeyPem = await fs.readFile(accountKeyPath);
        this.accountKey = accountKeyPem;
      } catch (error) {
        this.logger.info('Generating new ACME account key');
        this.accountKey = await acme.forge.createPrivateKey();
        await fs.writeFile(accountKeyPath, this.accountKey);
      }

      // ALWAYS use production certificates - staging certs are useless
      const directoryUrl = acme.directory.letsencrypt.production;

      this.acmeClient = new acme.Client({
        directoryUrl,
        accountKey: this.accountKey
      });

      // Check if we've already registered this account key
      const accountRegisteredPath = path.join(this.certsDir, '.account-registered');
      
      try {
        await fs.access(accountRegisteredPath);
        // Account already registered, just use it
        this.logger.info('ACME account already registered - reusing');
      } catch (error) {
        // Need to register account with ACME server
        const lockPath = path.join(this.certsDir, '.account-create.lock');
        const hasLock = await this.acquireLock(lockPath, 5000);
        
        if (hasLock) {
          try {
            // Double check the flag file
            try {
              await fs.access(accountRegisteredPath);
              this.logger.info('Account was just registered by another worker');
            } catch (e) {
              // Really need to create
              this.logger.info('Registering ACME account (one time only)');
              await this.acmeClient.createAccount({
                termsOfServiceAgreed: true,
                contact: []
              });
              
              // Mark as registered
              await fs.writeFile(accountRegisteredPath, new Date().toISOString());
              this.logger.info('ACME account registered successfully');
            }
          } finally {
            await fs.unlink(lockPath).catch(() => {});
          }
        } else {
          // Another worker is creating, wait for the flag file
          this.logger.info('Waiting for another worker to register account');
          let attempts = 20;
          while (attempts > 0) {
            try {
              await fs.access(accountRegisteredPath);
              this.logger.info('Account registered by another worker');
              break;
            } catch (e) {
              attempts--;
              await new Promise(resolve => setTimeout(resolve, 100));
            }
          }
        }
      }
    } catch (error) {
      this.logger.error('Failed to initialize ACME client:', error);
      this.acmeClient = null;
    }
  }

  async loadExistingCertificates() {
    try {
      const files = await fs.readdir(this.certsDir);
      const certFiles = files.filter(file => file.endsWith('.crt'));

      for (const certFile of certFiles) {
        const domain = certFile.replace('.crt', '');
        const certPath = path.join(this.certsDir, certFile);
        const keyPath = path.join(this.certsDir, `${domain}.key`);

        try {
          const cert = await fs.readFile(certPath);
          const key = await fs.readFile(keyPath);

          if (await this.isCertificateValid(cert)) {
            this.certificates.set(domain, { cert, key });
            this.logger.info(`Loaded certificate for domain: ${domain}`);
          } else {
            this.logger.warn(`Certificate for ${domain} is expired or invalid`);
          }
        } catch (error) {
          this.logger.warn(`Failed to load certificate for ${domain}:`, error.message);
        }
      }
    } catch (error) {
      this.logger.error('Error loading existing certificates:', error);
    }
  }

  async isCertificateValid(certPem) {
    try {
      // Parse certificate to check expiry
      const certString = certPem.toString();
      const cert = forge.pki.certificateFromPem(certString);

      const now = new Date();
      const notAfter = new Date(cert.validity.notAfter);
      const notBefore = new Date(cert.validity.notBefore);

      // Check if certificate is currently valid
      if (now < notBefore || now > notAfter) {
        this.logger.warn(`Certificate expired or not yet valid. Valid from ${notBefore} to ${notAfter}`);
        return false;
      }

      // Check if certificate expires in next 30 days (renew early)
      const thirtyDaysFromNow = new Date(now.getTime() + (30 * 24 * 60 * 60 * 1000));
      if (notAfter < thirtyDaysFromNow) {
        this.logger.info(`Certificate expiring soon (${notAfter}), will renew`);
        return false; // Trigger renewal
      }

      return true;
    } catch (error) {
      this.logger.error('Error checking certificate validity:', error);
      return false;
    }
  }

  async isRealCertificate(certPem) {
    try {
      // Parse certificate to check if it's CA-signed (not self-signed)
      const certString = certPem.toString();
      const cert = forge.pki.certificateFromPem(certString);

      // Self-signed certificates have subject === issuer
      const subject = cert.subject.attributes;
      const issuer = cert.issuer.attributes;

      // Check if subject and issuer are different (CA-signed)
      // For self-signed certs, they will be identical
      const subjectStr = subject.map(attr => `${attr.name}=${attr.value}`).sort().join(',');
      const issuerStr = issuer.map(attr => `${attr.name}=${attr.value}`).sort().join(',');

      if (subjectStr === issuerStr) {
        // Self-signed certificate
        return false;
      }

      // Additionally check for our test self-signed markers
      const orgName = subject.find(attr => attr.name === 'organizationName');
      if (orgName && orgName.value === 'Test') {
        return false; // Our self-signed cert
      }

      // This is a CA-signed certificate (like Let's Encrypt)
      return true;
    } catch (error) {
      this.logger.error('Error checking if certificate is real:', error);
      return false; // Assume self-signed on error
    }
  }

  async getDefaultCertificate() {
    const defaultCertPath = path.join(this.certsDir, 'default.crt');
    const defaultKeyPath = path.join(this.certsDir, 'default.key');

    try {
      const cert = await fs.readFile(defaultCertPath);
      const key = await fs.readFile(defaultKeyPath);
      return { cert, key };
    } catch (error) {
      this.logger.info('Generating self-signed default certificate');
      const { cert, key } = await this.generateSelfSignedCertificate('localhost');
      
      await fs.writeFile(defaultCertPath, cert);
      await fs.writeFile(defaultKeyPath, key);
      
      return { cert, key };
    }
  }

  async generateSelfSignedCertificate(commonName) {
    try {
      // Generate a key pair
      const keys = forge.pki.rsa.generateKeyPair(2048);
      
      // Create a certificate
      const cert = forge.pki.createCertificate();
      cert.publicKey = keys.publicKey;
      cert.serialNumber = '01';
      cert.validity.notBefore = new Date();
      cert.validity.notAfter = new Date();
      cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
      
      const attrs = [{
        name: 'commonName',
        value: commonName || 'localhost'
      }, {
        name: 'countryName',
        value: 'US'
      }, {
        shortName: 'ST',
        value: 'California'
      }, {
        name: 'localityName',
        value: 'San Francisco'
      }, {
        name: 'organizationName',
        value: 'Test'
      }, {
        shortName: 'OU',
        value: 'Test'
      }];
      
      cert.setSubject(attrs);
      cert.setIssuer(attrs);
      cert.setExtensions([{
        name: 'basicConstraints',
        cA: true
      }, {
        name: 'keyUsage',
        keyCertSign: true,
        digitalSignature: true,
        nonRepudiation: true,
        keyEncipherment: true,
        dataEncipherment: true
      }, {
        name: 'extKeyUsage',
        serverAuth: true,
        clientAuth: true,
        codeSigning: true,
        emailProtection: true,
        timeStamping: true
      }, {
        name: 'nsCertType',
        client: true,
        server: true,
        email: true,
        objsign: true,
        sslCA: true,
        emailCA: true,
        objCA: true
      }, {
        name: 'subjectAltName',
        altNames: [{
          type: 2, // DNS
          value: commonName || 'localhost'
        }]
      }, {
        name: 'subjectKeyIdentifier'
      }]);
      
      // Sign the certificate with its own key (self-signed)
      cert.sign(keys.privateKey, forge.md.sha256.create());
      
      // Convert to PEM format
      const certPem = forge.pki.certificateToPem(cert);
      const keyPem = forge.pki.privateKeyToPem(keys.privateKey);
      
      return { 
        cert: Buffer.from(certPem), 
        key: Buffer.from(keyPem) 
      };
    } catch (error) {
      this.logger.error('Failed to generate self-signed certificate:', error);
      
      // Ultimate fallback - create minimal working cert using acme.forge
      const key = await acme.forge.createPrivateKey();
      const cert = `-----BEGIN CERTIFICATE-----
MIICljCCAX4CCQCKvJPJ9VJd8TANBgkqhkiG9w0BAQsFADA1MQswCQYDVQQGEwJV
UzELMAkGA1UECAwCQ0ExEzARBgNVBAcMCkxvcyBBbmdlbGVzMQswCQYDVQQKDAJJ
VDEQMBAGA1UEAwwJbG9jYWxob3N0MB4XDTE4MTEwNTE5MDUwNFoXDTI4MTEwMjE5
MDUwNFowNTELMAkGA1UEBhMCVVMxCzAJBgNVBAgMAkNBMRMwEQYDVQQHDApMb3Mg
QW5nZWxlczELMAkGA1UECgwCSVQxEDAOBgNVBAMMB2xvY2FsaG9zdDBcMA0GCSqG
SIb3DQEBAQUAA0sAMEgCQQC7VJTUt9Us8cKjMzEfYyjiWA4R4npB9c20HlsIuM5W
QWVT47ubqyP6L0NmuXtBDTyY1j8N6yibDcalB3Nc8wKdAgMBAAEwDQYJKoZIhvcN
AQELBQADQQAGo8h5J9l8QO2s0/7RGYQwV5o4Yb0w9fX/b8d0+X9sR2Y6NJkPLYy4
3cIIj+oQ/q9VoRkQ2i0XJE8R1Kw9v4JJhQ==
-----END CERTIFICATE-----`;
      
      return { 
        cert: Buffer.from(cert), 
        key: Buffer.from(key) 
      };
    }
  }

  async getSNICallback() {
    return async (domain, callback) => {
      try {
        // Check if domain is in database
        const domainMapping = await this.db.getMapping(domain, '/');
        const isDomainValidated = domainMapping !== null;
        
        const certificate = await this.ensureCertificate(domain, isDomainValidated);
        
        // SNI callback needs a SecureContext, not just cert/key
        const tls = require('tls');
        const context = tls.createSecureContext({
          cert: certificate.cert,
          key: certificate.key
        });
        
        callback(null, context);
      } catch (error) {
        this.logger.error(`SNI callback error for ${domain}:`, error);
        callback(error);
      }
    };
  }

  async ensureCertificate(domain, isDomainValidated = false) {
    // ALWAYS check disk first for real certificates - don't trust cache blindly
    // This prevents serving stale self-signed certs when valid ones exist on disk
    const certPath = path.join(this.certsDir, `${domain}.crt`);
    const keyPath = path.join(this.certsDir, `${domain}.key`);

    try {
      const cert = await fs.readFile(certPath);
      const key = await fs.readFile(keyPath);

      if (await this.isCertificateValid(cert)) {
        // Check if this is a real (CA-signed) certificate vs self-signed
        const isRealCert = await this.isRealCertificate(cert);

        // If we have a real cert on disk, ALWAYS use it and update cache
        if (isRealCert) {
          this.certificates.set(domain, { cert, key });
          //this.logger.info(`Using valid CA-signed certificate from disk for domain: ${domain}`);
          return { cert, key };
        }

        // If disk has self-signed but cache has something, check if cache is better
        if (this.certificates.has(domain)) {
          const cached = this.certificates.get(domain);
          const cachedIsReal = await this.isRealCertificate(cached.cert);
          if (cachedIsReal) {
            // Cache has real cert, disk has self-signed - use cache
            return cached;
          }
        }

        // Both are self-signed or only disk exists - use disk version
        this.certificates.set(domain, { cert, key });
        return { cert, key };
      }
    } catch (error) {
      // Certificate doesn't exist on disk, check cache
      if (this.certificates.has(domain)) {
        const cached = this.certificates.get(domain);
        // Only use cached if it's valid
        if (await this.isCertificateValid(cached.cert)) {
          return cached;
        }
        // Cached cert is invalid, remove it
        this.certificates.delete(domain);
      }
    }

    const mainDomain = this.getMainDomain(domain);
    const isSubdomain = this.isSubdomain(domain);

    // If this is a subdomain, check if we have a wildcard cert for the main domain
    if (isSubdomain && isDomainValidated) {
      const wildcardCert = await this.getWildcardCertificate(mainDomain);
      if (wildcardCert) {
        this.logger.info(`Using wildcard certificate for ${domain} from *.${mainDomain}`);
        this.certificates.set(domain, wildcardCert);
        return wildcardCert;
      }

      // Check if main domain exists in database
      const mainDomainMapping = await this.db.getMapping(mainDomain, '/');
      if (mainDomainMapping) {
        this.logger.info(`Main domain ${mainDomain} exists in DB - will request wildcard certificate`);
        // Continue to request wildcard cert below
      }
    }

    // Only generate certificates for validated domains
    if (!isDomainValidated) {
      this.logger.warn(`Domain ${domain} not validated - using self-signed certificate`);
      return await this.generateSelfSignedCertificate(domain);
    }

    // Rate limiting - prevent too many requests for same domain
    const now = Date.now();
    const lastRequest = this.lastCertRequest.get(domain) || 0;
    const timeSinceLastRequest = now - lastRequest;
    
    // Limit: max 1 request per domain per 5 minutes
    if (timeSinceLastRequest < 5 * 60 * 1000) {
      this.logger.warn(`Rate limit: Too soon to request certificate for ${domain} (${Math.round(timeSinceLastRequest/1000)}s since last request)`);
      return await this.generateSelfSignedCertificate(domain);
    }

    // Track daily request count (Let's Encrypt limit: 5 duplicate certs per week)
    const requestCount = this.certRequestCount.get(domain) || 0;
    if (requestCount >= 5) {
      this.logger.error(`Rate limit: Too many certificate requests for ${domain} this week`);
      return await this.generateSelfSignedCertificate(domain);
    }

    if (this.processingDomains.has(domain)) {
      await this.waitForCertificateProcessing(domain);
      return this.certificates.get(domain) || await this.generateSelfSignedCertificate(domain);
    }

    this.processingDomains.add(domain);
    this.lastCertRequest.set(domain, now);
    this.certRequestCount.set(domain, requestCount + 1);

    try {
      const certificate = await this.obtainCertificate(domain);
      this.certificates.set(domain, certificate);
      return certificate;
    } finally {
      this.processingDomains.delete(domain);
    }
  }

  getMainDomain(domain) {
    // Extract main domain from subdomain
    // e.g., "sub.example.com" -> "example.com"
    // e.g., "example.com" -> "example.com"
    const parts = domain.split('.');
    if (parts.length <= 2) {
      return domain; // Already a main domain
    }
    
    // Handle common TLDs including compound ones like .co.uk
    const tldPatterns = [
      /\.(co|ac|gov|org|net|edu|mil)\.\w+$/,  // compound TLDs
      /\.\w+$/  // simple TLDs
    ];
    
    for (const pattern of tldPatterns) {
      const match = domain.match(pattern);
      if (match) {
        const tld = match[0];
        const domainWithoutTld = domain.slice(0, -tld.length);
        const domainParts = domainWithoutTld.split('.');
        return domainParts[domainParts.length - 1] + tld;
      }
    }
    
    // Fallback: assume last two parts
    return parts.slice(-2).join('.');
  }

  isSubdomain(domain) {
    const mainDomain = this.getMainDomain(domain);
    return domain !== mainDomain && domain !== `www.${mainDomain}`;
  }

  async getWildcardCertificate(mainDomain) {
    // Check if we have a wildcard certificate for this main domain
    const wildcardDomain = `*.${mainDomain}`;
    
    // Check memory cache
    if (this.wildcardCerts.has(mainDomain)) {
      return this.wildcardCerts.get(mainDomain);
    }
    
    // Check disk for wildcard cert
    try {
      const certPath = path.join(this.certsDir, `wildcard.${mainDomain}.crt`);
      const keyPath = path.join(this.certsDir, `wildcard.${mainDomain}.key`);
      const cert = await fs.readFile(certPath);
      const key = await fs.readFile(keyPath);
      
      if (await this.isCertificateValid(cert)) {
        const certificate = { cert, key };
        this.wildcardCerts.set(mainDomain, certificate);
        this.logger.info(`Loaded wildcard certificate from disk for *.${mainDomain}`);
        return certificate;
      }
    } catch (error) {
      // Wildcard cert doesn't exist
    }
    
    return null;
  }

  async waitForCertificateProcessing(domain, maxWait = 30000) {
    const startTime = Date.now();
    while (this.processingDomains.has(domain) && (Date.now() - startTime) < maxWait) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  async obtainCertificate(domain) {
    this.logger.info(`Obtaining certificate for domain: ${domain}`);

    // If ACME client is not available, return self-signed certificate
    if (!this.acmeClient) {
      this.logger.warn(`ACME client not available, generating self-signed certificate for ${domain}`);
      return await this.generateSelfSignedCertificate(domain);
    }

    try {
      const mainDomain = this.getMainDomain(domain);
      const isSubdomain = this.isSubdomain(domain);
      let requestDomains = [domain];
      let certFilename = domain;
      
      // DO NOT REQUEST WILDCARDS - they require DNS-01 challenge which needs DNS API access
      // Just request the specific domain
      requestDomains = [domain];
      certFilename = domain;

      const privateKey = await acme.forge.createPrivateKey();
      
      const [key, csr] = await acme.forge.createCsr({
        commonName: requestDomains[0],
        altNames: requestDomains
      }, privateKey);

      const cert = await this.acmeClient.auto({
        csr,
        email: null,
        termsOfServiceAgreed: true,
        challengeCreateFn: this.challengeCreateFn.bind(this),
        challengeRemoveFn: this.challengeRemoveFn.bind(this)
      });

      const certPath = path.join(this.certsDir, `${certFilename}.crt`);
      const keyPath = path.join(this.certsDir, `${certFilename}.key`);

      await fs.writeFile(certPath, cert);
      await fs.writeFile(keyPath, key);

      this.logger.info(`Certificate obtained and saved: ${certFilename} for domains: ${requestDomains.join(', ')}`);

      const certificate = { cert: Buffer.from(cert), key: Buffer.from(key) };
      
      // Cache wildcard cert if applicable
      if (certFilename.startsWith('wildcard.')) {
        const wildcardMainDomain = certFilename.replace('wildcard.', '').replace('.crt', '');
        this.wildcardCerts.set(wildcardMainDomain, certificate);
      }

      return certificate;
    } catch (error) {
      this.logger.error(`Failed to obtain certificate for ${domain}:`, error);
      
      // Fallback to self-signed certificate
      this.logger.info(`Falling back to self-signed certificate for ${domain}`);
      return await this.generateSelfSignedCertificate(domain);
    }
  }

  async getChallenge(token) {
    // First check in-memory challenges
    if (this.challenges.has(token)) {
      return this.challenges.get(token);
    }
    
    // Also check file system for challenges created by other workers
    const challengeFile = path.join(this.certsDir, '.well-known', 'acme-challenge', token);
    try {
      const challenge = await fs.readFile(challengeFile, 'utf8');
      return challenge;
    } catch (error) {
      return null;
    }
  }

  async challengeCreateFn(authz, challenge, keyAuthorization) {
    this.logger.info(`Creating challenge for ${authz.identifier.value}: ${challenge.type}`);

    if (challenge.type === 'http-01') {
      // Store in memory for this worker
      this.challenges.set(challenge.token, keyAuthorization);
      
      // Also write to file system for other workers
      const challengePath = path.join(this.certsDir, '.well-known', 'acme-challenge');
      await fs.mkdir(challengePath, { recursive: true });
      
      const challengeFile = path.join(challengePath, challenge.token);
      await fs.writeFile(challengeFile, keyAuthorization);
      
      this.logger.info(`HTTP challenge created: token=${challenge.token}`);
    }
  }

  async challengeRemoveFn(authz, challenge, keyAuthorization) {
    this.logger.info(`Removing challenge for ${authz.identifier.value}: ${challenge.type}`);

    if (challenge.type === 'http-01') {
      // Remove from memory
      this.challenges.delete(challenge.token);
      
      // Remove from file system
      const challengeFile = path.join(this.certsDir, '.well-known', 'acme-challenge', challenge.token);
      try {
        await fs.unlink(challengeFile);
        this.logger.info(`HTTP challenge removed: token=${challenge.token}`);
      } catch (error) {
        this.logger.warn(`Failed to remove challenge file:`, error);
      }
    }
  }

  async renewCertificates() {
    this.logger.info('Starting certificate renewal process');

    for (const [domain, certificate] of this.certificates.entries()) {
      try {
        if (await this.shouldRenewCertificate(certificate.cert)) {
          this.logger.info(`Renewing certificate for ${domain}`);
          const newCertificate = await this.obtainCertificate(domain);
          this.certificates.set(domain, newCertificate);
        }
      } catch (error) {
        this.logger.error(`Failed to renew certificate for ${domain}:`, error);
      }
    }
  }

  async shouldRenewCertificate(certPem) {
    return false;
  }
}

module.exports = CertificateManager;
