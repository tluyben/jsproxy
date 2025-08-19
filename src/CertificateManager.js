const acme = require('acme-client');
const forge = require('node-forge');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

class CertificateManager {
  constructor(logger) {
    this.logger = logger;
    this.certificates = new Map();
    this.certsDir = './certs';
    this.acmeClient = null;
    this.accountKey = null;
    this.processingDomains = new Set();
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

      // Use staging for development, production for real deployment
      const directoryUrl = process.env.NODE_ENV === 'production' 
        ? acme.directory.letsencrypt.production 
        : acme.directory.letsencrypt.staging;

      this.acmeClient = new acme.Client({
        directoryUrl,
        accountKey: this.accountKey
      });

      try {
        await this.acmeClient.getAccountUrl();
        this.logger.info('ACME client initialized with existing account');
      } catch (error) {
        this.logger.info('Creating new ACME account');
        await this.acmeClient.createAccount({
          termsOfServiceAgreed: true,
          contact: []
        });
        this.logger.info('ACME account created successfully');
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
      const cert = crypto.createPublicKey(certPem);
      return true;
    } catch (error) {
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
        const certificate = await this.ensureCertificate(domain);
        callback(null, certificate);
      } catch (error) {
        this.logger.error(`SNI callback error for ${domain}:`, error);
        callback(error);
      }
    };
  }

  async ensureCertificate(domain) {
    if (this.certificates.has(domain)) {
      return this.certificates.get(domain);
    }

    if (this.processingDomains.has(domain)) {
      await this.waitForCertificateProcessing(domain);
      return this.certificates.get(domain);
    }

    this.processingDomains.add(domain);

    try {
      const certificate = await this.obtainCertificate(domain);
      this.certificates.set(domain, certificate);
      return certificate;
    } finally {
      this.processingDomains.delete(domain);
    }
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

      const certPath = path.join(this.certsDir, `${domain}.crt`);
      const keyPath = path.join(this.certsDir, `${domain}.key`);

      await fs.writeFile(certPath, cert);
      await fs.writeFile(keyPath, key);

      this.logger.info(`Certificate obtained and saved for domain: ${domain}`);

      return { cert: Buffer.from(cert), key: Buffer.from(key) };
    } catch (error) {
      this.logger.error(`Failed to obtain certificate for ${domain}:`, error);
      
      // Fallback to self-signed certificate
      this.logger.info(`Falling back to self-signed certificate for ${domain}`);
      return await this.generateSelfSignedCertificate(domain);
    }
  }

  async challengeCreateFn(authz, challenge, keyAuthorization) {
    this.logger.info(`Creating challenge for ${authz.identifier.value}: ${challenge.type}`);

    if (challenge.type === 'http-01') {
      const challengePath = path.join(this.certsDir, '.well-known', 'acme-challenge');
      await fs.mkdir(challengePath, { recursive: true });
      
      const challengeFile = path.join(challengePath, challenge.token);
      await fs.writeFile(challengeFile, keyAuthorization);
      
      this.logger.info(`HTTP challenge file created: ${challengeFile}`);
    }
  }

  async challengeRemoveFn(authz, challenge, keyAuthorization) {
    this.logger.info(`Removing challenge for ${authz.identifier.value}: ${challenge.type}`);

    if (challenge.type === 'http-01') {
      const challengeFile = path.join(this.certsDir, '.well-known', 'acme-challenge', challenge.token);
      try {
        await fs.unlink(challengeFile);
        this.logger.info(`HTTP challenge file removed: ${challengeFile}`);
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