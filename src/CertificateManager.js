const acme = require('acme-client');
const forge = require('node-forge');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const TRUSTED_UPGRADE_INTERVAL_MS = 60_000;

class CertificateManager {
  constructor(logger, dbManager) {
    this.logger = logger;
    this.db = dbManager;
    // entries: { cert, key, type: 'trusted' | 'selfsigned' }
    this.certificates = new Map();
    this.challenges = new Map();
    this.certsDir = './certs';
    this.acmeClient = null;
    this.accountKey = null;
    this.processingDomains = new Set();
    this.pendingCerts = new Map();
    this.lastCertRequest = new Map();
    this.certRequestCount = new Map();
    this.wildcardCerts = new Map();
    this.acmeCapable = new Map(); // domain -> { capable: bool, probedAt: number }
    this.reprobingDomains = new Set();
    this.upgradingDomains = new Set(); // domains with a pending trusted-cert upgrade check
    this.testChallenges = new Map();
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

  async initializeAcmeClient() {
    try {
      const accountKeyPath = path.join(this.certsDir, 'account-key.pem');

      try {
        const accountKeyPem = await fs.readFile(accountKeyPath);
        this.accountKey = accountKeyPem;
      } catch (error) {
        this.logger.info('Generating new ACME account key');
        this.accountKey = await acme.forge.createPrivateKey();
        await fs.writeFile(accountKeyPath, this.accountKey);
      }

      const directoryUrl = acme.directory.letsencrypt.production;

      this.acmeClient = new acme.Client({
        directoryUrl,
        accountKey: this.accountKey
      });

      await this.acmeClient.createAccount({
        termsOfServiceAgreed: true,
        contact: []
      });
      this.logger.info('ACME account ready');
    } catch (error) {
      this.logger.error('Failed to initialize ACME client:', error);
      this.acmeClient = null;
    }
  }

  async loadExistingCertificates() {
    try {
      const files = await fs.readdir(this.certsDir);

      // Load trusted certs (.trusted.crt), migrating bare .crt files on the fly
      const trustedFiles = files.filter(f => f.endsWith('.trusted.crt') && !f.startsWith('wildcard.'));
      const legacyCrtFiles = files.filter(f =>
        f.endsWith('.crt') &&
        !f.endsWith('.trusted.crt') &&
        !f.endsWith('.selfsigned.crt') &&
        !f.startsWith('wildcard.') &&
        f !== 'default.crt'
      );

      for (const certFile of [...trustedFiles, ...legacyCrtFiles]) {
        const isTrustedExt = certFile.endsWith('.trusted.crt');
        const domain = certFile.replace('.trusted.crt', '').replace('.crt', '');
        if (this.certificates.has(domain)) continue; // already loaded via .trusted.crt
        const certPath = path.join(this.certsDir, certFile);
        const keyPath  = path.join(this.certsDir, isTrustedExt ? `${domain}.trusted.key` : `${domain}.key`);
        try {
          const cert = await fs.readFile(certPath);
          const key  = await fs.readFile(keyPath);
          if (!await this.isCertificateValid(cert)) {
            this.logger.warn(`Certificate for ${domain} is expired or invalid`);
            continue;
          }
          const isReal = await this.isRealCertificate(cert);
          if (isReal) {
            if (!isTrustedExt) {
              // Migrate bare .crt/.key → .trusted.crt/.trusted.key
              const tCertPath = path.join(this.certsDir, `${domain}.trusted.crt`);
              const tKeyPath  = path.join(this.certsDir, `${domain}.trusted.key`);
              await fs.rename(certPath, tCertPath).catch(() => {});
              await fs.rename(keyPath,  tKeyPath).catch(() => {});
              this.logger.info(`Migrated trusted certificate for: ${domain}`);
            } else {
              this.logger.info(`Loaded trusted certificate for: ${domain}`);
            }
            this.certificates.set(domain, { cert, key, type: 'trusted' });
          } else {
            // Old self-signed .crt — migrate to .selfsigned.*
            const ssCertPath = path.join(this.certsDir, `${domain}.selfsigned.crt`);
            const ssKeyPath  = path.join(this.certsDir, `${domain}.selfsigned.key`);
            await fs.rename(certPath, ssCertPath).catch(() => {});
            await fs.rename(keyPath,  ssKeyPath).catch(() => {});
            this.certificates.set(domain, { cert, key, type: 'selfsigned' });
            this.logger.info(`Migrated self-signed certificate for: ${domain}`);
          }
        } catch (error) {
          this.logger.warn(`Failed to load certificate for ${domain}:`, error.message);
        }
      }

      // Load self-signed certs (.selfsigned.crt), skip domains already loaded as trusted
      const ssFiles = files.filter(f => f.endsWith('.selfsigned.crt'));
      for (const certFile of ssFiles) {
        const domain = certFile.replace('.selfsigned.crt', '');
        if (this.certificates.has(domain)) continue;
        const certPath = path.join(this.certsDir, certFile);
        const keyPath = path.join(this.certsDir, `${domain}.selfsigned.key`);
        try {
          const cert = await fs.readFile(certPath);
          const key = await fs.readFile(keyPath);
          if (!await this.isCertificateValid(cert)) {
            this.logger.warn(`Self-signed certificate for ${domain} is expired or invalid`);
            continue;
          }
          this.certificates.set(domain, { cert, key, type: 'selfsigned' });
          this.logger.info(`Loaded self-signed certificate for: ${domain}`);
        } catch (error) {
          this.logger.warn(`Failed to load self-signed certificate for ${domain}:`, error.message);
        }
      }
    } catch (error) {
      this.logger.error('Error loading existing certificates:', error);
    }
  }

  async isCertificateValid(certPem) {
    try {
      const certString = certPem.toString();
      const cert = forge.pki.certificateFromPem(certString);

      const now = new Date();
      const notAfter = new Date(cert.validity.notAfter);
      const notBefore = new Date(cert.validity.notBefore);

      if (now < notBefore || now > notAfter) {
        this.logger.warn(`Certificate expired or not yet valid. Valid from ${notBefore} to ${notAfter}`);
        return false;
      }

      const thirtyDaysFromNow = new Date(now.getTime() + (30 * 24 * 60 * 60 * 1000));
      if (notAfter < thirtyDaysFromNow) {
        this.logger.info(`Certificate expiring soon (${notAfter}), will renew`);
        return false;
      }

      return true;
    } catch (error) {
      this.logger.error('Error checking certificate validity:', error);
      return false;
    }
  }

  async isRealCertificate(certPem) {
    try {
      const certString = certPem.toString();
      const cert = forge.pki.certificateFromPem(certString);

      const subject = cert.subject.attributes;
      const issuer = cert.issuer.attributes;

      const subjectStr = subject.map(attr => `${attr.name}=${attr.value}`).sort().join(',');
      const issuerStr = issuer.map(attr => `${attr.name}=${attr.value}`).sort().join(',');

      if (subjectStr === issuerStr) return false;

      const orgName = subject.find(attr => attr.name === 'organizationName');
      if (orgName && orgName.value === 'Test') return false;

      return true;
    } catch (error) {
      this.logger.error('Error checking if certificate is real:', error);
      return false;
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
      const keys = forge.pki.rsa.generateKeyPair(2048);

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

      cert.sign(keys.privateKey, forge.md.sha256.create());

      const certPem = forge.pki.certificateToPem(cert);
      const keyPem = forge.pki.privateKeyToPem(keys.privateKey);

      return {
        cert: Buffer.from(certPem),
        key: Buffer.from(keyPem)
      };
    } catch (error) {
      this.logger.error('Failed to generate self-signed certificate:', error);

      const key = await acme.forge.createPrivateKey();
      const cert = `-----BEGIN CERTIFICATE-----
MIICljCCAX4CCQCKvJPJ9VJd8TANBgkqhkiG9w0BAQsFADA1MQswCQYDVQQGEwJV
UzELMAkGA1UECAwCQ0ExEzARBgNVBAcMCkxvcyBBbmdlbGVzMQswCQYDVQQKDAJJ
VDEQMBAGA1UEAwwJbG9jYWxob3N0MB4XDTE4MTEwNTE5MDUwNFoXDTI4MTEwMjE5
MDUwNFowNTELMAkGA1UEBhMCVVMxCzAJBgNVBAgMAkNBMRMwEQYDVQQHDApMb3Mg
QW5nZWxlczELMAkDA1UECgwCSVQxEDAOBgNVBAMMB2xvY2FsaG9zdDBcMA0GCSqG
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

  // Write a self-signed cert pair to disk under the .selfsigned.* filenames
  async _writeSelfSigned(domain, cert, key) {
    const certPath = path.join(this.certsDir, `${domain}.selfsigned.crt`);
    const keyPath = path.join(this.certsDir, `${domain}.selfsigned.key`);
    await fs.writeFile(certPath, cert);
    await fs.writeFile(keyPath, key);
  }

  // Generate, persist, and cache a self-signed cert; schedule upgrade check for public domains
  async _generateAndCacheSelfSigned(domain) {
    const { cert, key } = await this.generateSelfSignedCertificate(domain);
    await this._writeSelfSigned(domain, cert, key).catch(err =>
      this.logger.warn(`Failed to persist self-signed cert for ${domain}:`, err)
    );
    const entry = { cert, key, type: 'selfsigned' };
    this.certificates.set(domain, entry);
    if (this.isPublicDomain(domain)) this._checkForTrustedUpgrade(domain);
    return entry;
  }

  // Schedule a one-shot disk check 60s from now; re-arms itself until trusted cert appears
  _checkForTrustedUpgrade(domain) {
    if (this.upgradingDomains.has(domain)) return;
    this.upgradingDomains.add(domain);
    setTimeout(async () => {
      this.upgradingDomains.delete(domain);
      try {
        const certPath = path.join(this.certsDir, `${domain}.trusted.crt`);
        const keyPath = path.join(this.certsDir, `${domain}.trusted.key`);
        const cert = await fs.readFile(certPath);
        const key = await fs.readFile(keyPath);
        if (await this.isCertificateValid(cert)) {
          this.certificates.set(domain, { cert, key, type: 'trusted' });
          this.logger.info(`Upgraded ${domain} from self-signed to trusted cert`);
        }
        // If not valid yet, next request with selfsigned in cache will re-arm the check
      } catch (_) {
        // No trusted cert on disk yet — next request re-arms
      }
    }, TRUSTED_UPGRADE_INTERVAL_MS);
  }

  async getSNICallback() {
    return async (domain, callback) => {
      try {
        const domainMapping = await this.db.getMapping(domain, '/');
        const isDomainValidated = domainMapping !== null;

        let certDomain = domain;
        if (domainMapping && domainMapping.domain.startsWith('*.') && !domain.startsWith('*')) {
          certDomain = domainMapping.domain;
        }

        const certificate = await this.ensureCertificate(certDomain, isDomainValidated);

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
    if (domain.startsWith('*.')) {
      return await this.ensureWildcardCertificate(domain.replace('*.', ''), isDomainValidated);
    }

    // Memory cache
    if (this.certificates.has(domain)) {
      const cached = this.certificates.get(domain);
      if (await this.isCertificateValid(cached.cert)) {
        if (cached.type === 'trusted') return cached;
        // selfsigned: serve immediately, re-arm upgrade check in background
        this._checkForTrustedUpgrade(domain);
        return cached;
      }
      this.certificates.delete(domain);
    }

    // Wildcard fallback
    const mainDomain = this.getMainDomain(domain);
    if (domain !== mainDomain) {
      const wildcardCert = await this.getWildcardCertificate(mainDomain);
      if (wildcardCert) {
        this.logger.info(`Using wildcard certificate for ${domain} from *.${mainDomain}`);
        // Tag as trusted so it stays cached without upgrade checks (wildcard has its own path)
        this.certificates.set(domain, { ...wildcardCert, type: 'trusted' });
        return wildcardCert;
      }
    }

    // Disk: trusted first (.trusted.crt / .trusted.key)
    const certPath = path.join(this.certsDir, `${domain}.trusted.crt`);
    const keyPath = path.join(this.certsDir, `${domain}.trusted.key`);
    try {
      const cert = await fs.readFile(certPath);
      const key = await fs.readFile(keyPath);
      if (await this.isCertificateValid(cert)) {
        const entry = { cert, key, type: 'trusted' };
        this.certificates.set(domain, entry);
        return entry;
      }
    } catch (_) {}

    // Disk: self-signed (.selfsigned.crt / .selfsigned.key)
    const ssCertPath = path.join(this.certsDir, `${domain}.selfsigned.crt`);
    const ssKeyPath = path.join(this.certsDir, `${domain}.selfsigned.key`);
    try {
      const cert = await fs.readFile(ssCertPath);
      const key = await fs.readFile(ssKeyPath);
      if (await this.isCertificateValid(cert)) {
        const entry = { cert, key, type: 'selfsigned' };
        this.certificates.set(domain, entry);
        if (this.isPublicDomain(domain)) this._checkForTrustedUpgrade(domain);
        return entry;
      }
    } catch (_) {}

    // Domain not in DB — generate self-signed, no upgrade check
    if (!isDomainValidated) {
      this.logger.warn(`Domain ${domain} not validated - using self-signed certificate`);
      const { cert, key } = await this.generateSelfSignedCertificate(domain);
      await this._writeSelfSigned(domain, cert, key).catch(() => {});
      const entry = { cert, key, type: 'selfsigned' };
      this.certificates.set(domain, entry);
      return entry;
    }

    // Non-public domain — self-signed forever, no upgrade check needed
    if (!this.isPublicDomain(domain)) {
      this.logger.info(`Domain ${domain} is not a public FQDN — using self-signed certificate`);
      const { cert, key } = await this.generateSelfSignedCertificate(domain);
      await this._writeSelfSigned(domain, cert, key).catch(() => {});
      const entry = { cert, key, type: 'selfsigned' };
      this.certificates.set(domain, entry);
      return entry;
    }

    // HTTP-01 reachability check
    const capable = await this.testAcmeCapability(domain);
    if (!capable) {
      return await this._generateAndCacheSelfSigned(domain);
    }

    // Join in-flight ACME request
    if (this.pendingCerts.has(domain)) {
      this.logger.info(`Joining in-flight certificate request for ${domain}`);
      const timeoutPromise = new Promise(resolve => setTimeout(() => resolve(null), 30000));
      const cert = await Promise.race([this.pendingCerts.get(domain), timeoutPromise]);
      if (cert) return cert;
      this.logger.warn(`ACME stuck for ${domain} after 30s, giving up on this attempt`);
      this.pendingCerts.delete(domain);
      return await this._generateAndCacheSelfSigned(domain);
    }

    // Rate limiting
    const now = Date.now();
    const lastRequest = this.lastCertRequest.get(domain) || 0;
    if (now - lastRequest < 5 * 60 * 1000) {
      this.logger.warn(`Rate limit: Too soon to request certificate for ${domain} (${Math.round((now - lastRequest)/1000)}s since last request)`);
      return await this._generateAndCacheSelfSigned(domain);
    }
    const requestCount = this.certRequestCount.get(domain) || 0;
    if (requestCount >= 5) {
      this.logger.error(`Rate limit: Too many certificate requests for ${domain} this week`);
      return await this._generateAndCacheSelfSigned(domain);
    }

    // Start ACME
    this.lastCertRequest.set(domain, now);
    this.certRequestCount.set(domain, requestCount + 1);

    const certPromise = this.obtainCertificate(domain)
      .then(certificate => {
        const entry = { ...certificate, type: 'trusted' };
        this.certificates.set(domain, entry);
        return entry;
      })
      .catch(async (err) => {
        this.logger.error(`ACME failed for ${domain}, falling back to self-signed:`, err);
        return await this._generateAndCacheSelfSigned(domain);
      })
      .finally(() => {
        this.pendingCerts.delete(domain);
      });

    this.pendingCerts.set(domain, certPromise);
    return await certPromise;
  }

  async ensureWildcardCertificate(mainDomain, isDomainValidated = false) {
    const wildcardDomain = `*.${mainDomain}`;

    if (this.wildcardCerts.has(mainDomain)) {
      const cached = this.wildcardCerts.get(mainDomain);
      if (await this.isCertificateValid(cached.cert)) {
        return cached;
      }
      this.wildcardCerts.delete(mainDomain);
    }

    try {
      const certPath = path.join(this.certsDir, `wildcard.${mainDomain}.crt`);
      const keyPath = path.join(this.certsDir, `wildcard.${mainDomain}.key`);
      const cert = await fs.readFile(certPath);
      const key = await fs.readFile(keyPath);

      if (await this.isCertificateValid(cert)) {
        const certificate = { cert, key };
        this.wildcardCerts.set(mainDomain, certificate);
        this.logger.info(`Using cached wildcard certificate for ${wildcardDomain}`);
        return certificate;
      }
    } catch (error) {
    }

    if (!isDomainValidated) {
      this.logger.warn(`Wildcard domain ${wildcardDomain} not validated - using self-signed certificate`);
      const cert = await this.generateSelfSignedCertificate(wildcardDomain);
      this.wildcardCerts.set(mainDomain, cert);
      return cert;
    }

    if (!this.isPublicDomain(mainDomain)) {
      this.logger.info(`Domain ${wildcardDomain} is not a public FQDN — using self-signed certificate`);
      const cert = await this.generateSelfSignedCertificate(wildcardDomain);
      this.wildcardCerts.set(mainDomain, cert);
      return cert;
    }

    if (!this.acmeClient) {
      this.logger.warn(`ACME client not available for ${wildcardDomain} - using self-signed`);
      return await this.generateSelfSignedCertificate(wildcardDomain);
    }

    const pendingFile = path.join(this.certsDir, `wildcard.${mainDomain}.pending.json`);
    let pending = null;

    try {
      const data = await fs.readFile(pendingFile, 'utf8');
      pending = JSON.parse(data);
      if (new Date(pending.expiresAt) < new Date()) {
        this.logger.info(`Pending wildcard order for ${wildcardDomain} expired, creating new one`);
        pending = null;
        await fs.unlink(pendingFile).catch(() => {});
      }
    } catch (e) {
    }

    if (!pending) {
      if (this.processingDomains.has(wildcardDomain)) {
        await this.waitForCertificateProcessing(wildcardDomain);
        return this.wildcardCerts.get(mainDomain) || await this.generateSelfSignedCertificate(wildcardDomain);
      }
      this.processingDomains.add(wildcardDomain);
      try {
        pending = await this.createWildcardOrder(mainDomain);
        await fs.writeFile(pendingFile, JSON.stringify(pending, null, 2));
      } catch (e) {
        this.logger.error(`Failed to create wildcard ACME order for ${wildcardDomain}:`, e);
        return await this.generateSelfSignedCertificate(wildcardDomain);
      } finally {
        this.processingDomains.delete(wildcardDomain);
      }
    }

    const isReady = await this.checkDnsTxtRecord(pending.txtRecordName, pending.txtRecordValue);

    if (!isReady) {
      this.logger.error(`[ACTION REQUIRED] Add this DNS TXT record to issue a wildcard certificate for ${wildcardDomain}:`);
      this.logger.error(`  Type:  TXT`);
      this.logger.error(`  Name:  _acme-challenge`);
      this.logger.error(`  Value: ${pending.txtRecordValue}`);
      return await this.generateSelfSignedCertificate(wildcardDomain);
    }

    if (this.processingDomains.has(wildcardDomain)) {
      await this.waitForCertificateProcessing(wildcardDomain);
      return this.wildcardCerts.get(mainDomain) || await this.generateSelfSignedCertificate(wildcardDomain);
    }

    this.processingDomains.add(wildcardDomain);
    try {
      const certificate = await this.completePendingWildcardOrder(mainDomain, pending);
      this.wildcardCerts.set(mainDomain, certificate);
      await fs.unlink(pendingFile).catch(() => {});
      return certificate;
    } catch (e) {
      this.logger.error(`Failed to complete wildcard order for ${wildcardDomain}:`, e);
      await fs.unlink(pendingFile).catch(() => {});
      return await this.generateSelfSignedCertificate(wildcardDomain);
    } finally {
      this.processingDomains.delete(wildcardDomain);
    }
  }

  getMainDomain(domain) {
    const parts = domain.split('.');
    if (parts.length <= 2) return domain;

    const tldPatterns = [
      /\.(co|ac|gov|org|net|edu|mil)\.\w+$/,
      /\.\w+$/
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

    return parts.slice(-2).join('.');
  }

  isSubdomain(domain) {
    const mainDomain = this.getMainDomain(domain);
    return domain !== mainDomain && domain !== `www.${mainDomain}`;
  }

  isPublicDomain(domain) {
    if (!domain.includes('.')) return false;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(domain)) return false;

    const privateSuffixes = [
      '.local', '.localhost', '.internal', '.lan', '.test',
      '.example', '.invalid', '.home', '.corp', '.localdomain',
      '.intranet', '.private',
    ];
    const lower = domain.toLowerCase();
    if (privateSuffixes.some(s => lower.endsWith(s))) return false;

    return true;
  }

  async getWildcardCertificate(mainDomain) {
    if (this.wildcardCerts.has(mainDomain)) {
      return this.wildcardCerts.get(mainDomain);
    }

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
    }

    return null;
  }

  getTestChallenge(token) {
    return this.testChallenges.get(token) || null;
  }

  async testAcmeCapability(domain) {
    const FAILURE_TTL = 15 * 60 * 1000;

    if (this.acmeCapable.has(domain)) {
      const { capable, probedAt } = this.acmeCapable.get(domain);
      if (capable) return true;
      if (Date.now() - probedAt < FAILURE_TTL) return false;
      this._reprobeAcmeCapabilityBackground(domain);
      return false;
    }

    return await this._runProbe(domain);
  }

  _reprobeAcmeCapabilityBackground(domain) {
    if (this.reprobingDomains.has(domain)) return;
    this.reprobingDomains.add(domain);
    this._runProbe(domain)
      .then(async (capable) => {
        if (!capable) return;
        // ACME now reachable — evict selfsigned from memory so next handshake goes to ACME
        if (this.certificates.has(domain)) {
          const cached = this.certificates.get(domain);
          if (cached.type === 'selfsigned') {
            this.certificates.delete(domain);
            this.logger.info(`ACME capability restored for ${domain} — cleared self-signed cache`);
          }
        }
      })
      .catch(err => this.logger.warn(`Background ACME re-probe error for ${domain}:`, err))
      .finally(() => this.reprobingDomains.delete(domain));
  }

  async _runProbe(domain) {
    const token = crypto.randomBytes(16).toString('hex');
    const value = crypto.randomBytes(16).toString('hex');
    this.testChallenges.set(token, value);

    let capable = false;
    try {
      const http = require('http');
      const result = await new Promise((resolve) => {
        const req = http.get(
          `http://${domain}/.well-known/test-challenge/${token}`,
          { timeout: 5000 },
          (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => resolve({ status: res.statusCode, body }));
          }
        );
        req.on('error', () => resolve({ status: 0, body: '' }));
        req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
      });

      capable = result.status === 200 && result.body === value;
    } catch (e) {
      capable = false;
    } finally {
      this.testChallenges.delete(token);
    }

    if (capable) {
      this.logger.info(`ACME HTTP-01 reachability confirmed for ${domain}`);
    } else {
      this.logger.warn(`ACME HTTP-01 not reachable for ${domain}`);
    }

    this.acmeCapable.set(domain, { capable, probedAt: Date.now() });
    return capable;
  }

  async waitForCertificateProcessing(domain, maxWait = 30000) {
    const startTime = Date.now();
    while (this.processingDomains.has(domain) && (Date.now() - startTime) < maxWait) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  async obtainCertificate(domain) {
    this.logger.info(`Obtaining certificate for domain: ${domain}`);

    if (!this.acmeClient) {
      // Let the caller's .catch handle fallback to self-signed
      throw new Error(`ACME client not available for ${domain}`);
    }

    try {
      const privateKey = await acme.forge.createPrivateKey();

      const [key, csr] = await acme.forge.createCsr({
        commonName: domain,
        altNames: [domain]
      }, privateKey);

      const cert = await this.acmeClient.auto({
        csr,
        email: null,
        termsOfServiceAgreed: true,
        challengeCreateFn: this.challengeCreateFn.bind(this),
        challengeRemoveFn: this.challengeRemoveFn.bind(this)
      });

      const certPath = path.join(this.certsDir, `${domain}.trusted.crt`);
      const keyPath = path.join(this.certsDir, `${domain}.trusted.key`);

      await fs.writeFile(certPath, cert);
      await fs.writeFile(keyPath, key);

      this.logger.info(`Certificate obtained and saved for: ${domain}`);

      return { cert: Buffer.from(cert), key: Buffer.from(key) };
    } catch (error) {
      this.logger.error(`Failed to obtain certificate for ${domain}:`, error);
      throw error;
    }
  }

  async createWildcardOrder(mainDomain) {
    this.logger.info(`Creating wildcard ACME order for *.${mainDomain}`);

    const order = await this.acmeClient.createOrder({
      identifiers: [{ type: 'dns', value: `*.${mainDomain}` }]
    });

    const authorizations = await this.acmeClient.getAuthorizations(order);

    for (const authz of authorizations) {
      const challenge = authz.challenges.find(c => c.type === 'dns-01');
      if (challenge) {
        const txtValue = await this.acmeClient.getChallengeKeyAuthorization(challenge);
        return {
          mainDomain,
          txtRecordName: `_acme-challenge.${mainDomain}`,
          txtRecordValue: txtValue,
          createdAt: new Date().toISOString(),
          expiresAt: order.expires || new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString(),
          order: { url: order.url, finalize: order.finalize },
          authz: { url: authz.url, identifier: authz.identifier },
          challenge: { type: challenge.type, url: challenge.url, token: challenge.token, status: challenge.status }
        };
      }
    }

    throw new Error(`No dns-01 challenge found for *.${mainDomain}`);
  }

  async checkDnsTxtRecord(recordName, expectedValue) {
    try {
      const output = execSync(`dig +short TXT ${recordName}`, { timeout: 5000 }).toString();
      return output.includes(`"${expectedValue}"`);
    } catch (e) {
      return false;
    }
  }

  async completePendingWildcardOrder(mainDomain, pending) {
    this.logger.info(`DNS record verified — completing wildcard ACME order for *.${mainDomain}`);

    const privateKey = await acme.forge.createPrivateKey();
    const [key, csr] = await acme.forge.createCsr({
      commonName: `*.${mainDomain}`,
      altNames: [`*.${mainDomain}`]
    }, privateKey);

    await this.acmeClient.completeChallenge(pending.challenge);
    await this.acmeClient.waitForValidStatus(pending.authz);

    const finalizedOrder = await this.acmeClient.finalizeOrder(pending.order, csr);
    const cert = await this.acmeClient.getCertificate(finalizedOrder);

    const certPath = path.join(this.certsDir, `wildcard.${mainDomain}.crt`);
    const keyPath = path.join(this.certsDir, `wildcard.${mainDomain}.key`);
    await fs.writeFile(certPath, cert);
    await fs.writeFile(keyPath, key);

    this.logger.info(`Wildcard certificate obtained and saved for *.${mainDomain}`);
    return { cert: Buffer.from(cert), key: Buffer.from(key) };
  }

  async getChallenge(token) {
    if (this.challenges.has(token)) {
      return this.challenges.get(token);
    }

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
      this.challenges.set(challenge.token, keyAuthorization);

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
      this.challenges.delete(challenge.token);

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
          this.certificates.set(domain, { ...newCertificate, type: 'trusted' });
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
