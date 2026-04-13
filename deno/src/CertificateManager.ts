/**
 * CertificateManager — Deno edition.
 *
 * Identical logic to the Node.js version with two small adaptations:
 *   1. `require('child_process').execSync` → `new Deno.Command(…)` for `dig`
 *   2. `require('tls')` lazy-require inside getSNICallback → top-level import
 *
 * Everything else (ACME flow, wildcard certs, rate limiting, challenges) is
 * unchanged; all npm packages (acme-client, node-forge) are used as-is via
 * Deno's npm compatibility layer.
 */

// deno-lint-ignore-file no-explicit-any

import * as acme from "npm:acme-client@5";
import forge from "npm:node-forge@1";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as tls from "node:tls";
import { Buffer } from "node:buffer";

interface Logger {
  info(...a: unknown[]): void;
  warn(...a: unknown[]): void;
  error(...a: unknown[]): void;
}

export default class CertificateManager {
  logger: Logger;
  db: any;
  certificates: Map<string, any>;
  challenges: Map<string, string>;
  certsDir: string;
  acmeClient: any;
  accountKey: any;
  processingDomains: Set<string>;
  pendingCerts: Map<string, Promise<any>>;
  lastCertRequest: Map<string, number>;
  certRequestCount: Map<string, number>;
  wildcardCerts: Map<string, any>;
  acmeCapable: Map<string, boolean>;
  testChallenges: Map<string, string>;

  constructor(logger: Logger, dbManager: any) {
    this.logger = logger;
    this.db = dbManager;
    this.certificates = new Map();
    this.challenges = new Map();
    this.certsDir = "./certs";
    this.acmeClient = null;
    this.accountKey = null;
    this.processingDomains = new Set();
    this.pendingCerts = new Map();
    this.lastCertRequest = new Map();
    this.certRequestCount = new Map();
    this.wildcardCerts = new Map();
    this.acmeCapable = new Map();
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
    } catch {
      await fs.mkdir(this.certsDir, { recursive: true });
      this.logger.info(`Created certificates directory: ${this.certsDir}`);
    }
  }

  async initializeAcmeClient() {
    try {
      const accountKeyPath = path.join(this.certsDir, "account-key.pem");
      try {
        this.accountKey = await fs.readFile(accountKeyPath);
      } catch {
        this.logger.info("Generating new ACME account key");
        this.accountKey = await acme.forge.createPrivateKey();
        await fs.writeFile(accountKeyPath, this.accountKey);
      }

      const directoryUrl = acme.directory.letsencrypt.production;
      this.acmeClient = new acme.Client({ directoryUrl, accountKey: this.accountKey });

      await this.acmeClient.createAccount({ termsOfServiceAgreed: true, contact: [] });
      this.logger.info("ACME account ready");
    } catch (error) {
      this.logger.error("Failed to initialize ACME client:", error);
      this.acmeClient = null;
    }
  }

  async loadExistingCertificates() {
    try {
      const files = await fs.readdir(this.certsDir);
      for (const certFile of files.filter((f) => f.endsWith(".crt"))) {
        const domain = certFile.replace(".crt", "");
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
        } catch (error: any) {
          this.logger.warn(`Failed to load certificate for ${domain}:`, error.message);
        }
      }
    } catch (error) {
      this.logger.error("Error loading existing certificates:", error);
    }
  }

  async isCertificateValid(certPem: Buffer | string): Promise<boolean> {
    try {
      const cert = forge.pki.certificateFromPem(certPem.toString());
      const now = new Date();
      const notAfter = new Date(cert.validity.notAfter);
      const notBefore = new Date(cert.validity.notBefore);

      if (now < notBefore || now > notAfter) {
        this.logger.warn(`Certificate expired or not yet valid: ${notBefore} – ${notAfter}`);
        return false;
      }
      const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      if (notAfter < thirtyDaysFromNow) {
        this.logger.info(`Certificate expiring soon (${notAfter}), will renew`);
        return false;
      }
      return true;
    } catch (error) {
      this.logger.error("Error checking certificate validity:", error);
      return false;
    }
  }

  async isRealCertificate(certPem: Buffer | string): Promise<boolean> {
    try {
      const cert = forge.pki.certificateFromPem(certPem.toString());
      const subjectStr = cert.subject.attributes
        .map((a: any) => `${a.name}=${a.value}`)
        .sort()
        .join(",");
      const issuerStr = cert.issuer.attributes
        .map((a: any) => `${a.name}=${a.value}`)
        .sort()
        .join(",");
      if (subjectStr === issuerStr) return false;
      const orgName = cert.subject.attributes.find((a: any) => a.name === "organizationName");
      if (orgName && orgName.value === "Test") return false;
      return true;
    } catch {
      return false;
    }
  }

  async getDefaultCertificate(): Promise<{ cert: Buffer; key: Buffer }> {
    const defaultCertPath = path.join(this.certsDir, "default.crt");
    const defaultKeyPath = path.join(this.certsDir, "default.key");
    try {
      const cert = await fs.readFile(defaultCertPath);
      const key = await fs.readFile(defaultKeyPath);
      return { cert, key };
    } catch {
      this.logger.info("Generating self-signed default certificate");
      const { cert, key } = await this.generateSelfSignedCertificate("localhost");
      await fs.writeFile(defaultCertPath, cert);
      await fs.writeFile(defaultKeyPath, key);
      return { cert, key };
    }
  }

  async generateSelfSignedCertificate(
    commonName: string,
  ): Promise<{ cert: Buffer; key: Buffer }> {
    try {
      const keys = forge.pki.rsa.generateKeyPair(2048);
      const cert = forge.pki.createCertificate();
      cert.publicKey = keys.publicKey;
      cert.serialNumber = "01";
      cert.validity.notBefore = new Date();
      cert.validity.notAfter = new Date();
      cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);

      const attrs = [
        { name: "commonName", value: commonName || "localhost" },
        { name: "countryName", value: "US" },
        { shortName: "ST", value: "California" },
        { name: "localityName", value: "San Francisco" },
        { name: "organizationName", value: "Test" },
        { shortName: "OU", value: "Test" },
      ];

      cert.setSubject(attrs);
      cert.setIssuer(attrs);
      cert.setExtensions([
        { name: "basicConstraints", cA: true },
        {
          name: "keyUsage",
          keyCertSign: true,
          digitalSignature: true,
          nonRepudiation: true,
          keyEncipherment: true,
          dataEncipherment: true,
        },
        {
          name: "extKeyUsage",
          serverAuth: true,
          clientAuth: true,
          codeSigning: true,
          emailProtection: true,
          timeStamping: true,
        },
        {
          name: "nsCertType",
          client: true,
          server: true,
          email: true,
          objsign: true,
          sslCA: true,
          emailCA: true,
          objCA: true,
        },
        { name: "subjectAltName", altNames: [{ type: 2, value: commonName || "localhost" }] },
        { name: "subjectKeyIdentifier" },
      ]);

      cert.sign(keys.privateKey, forge.md.sha256.create());
      return {
        cert: Buffer.from(forge.pki.certificateToPem(cert)),
        key: Buffer.from(forge.pki.privateKeyToPem(keys.privateKey)),
      };
    } catch (error) {
      this.logger.error("Failed to generate self-signed certificate:", error);
      const key = await acme.forge.createPrivateKey();
      // Minimal valid-looking fallback cert (expired but structurally ok)
      const fallbackCert =
        "-----BEGIN CERTIFICATE-----\n" +
        "MIICljCCAX4CCQCKvJPJ9VJd8TANBgkqhkiG9w0BAQsFADA1MQswCQYDVQQGEwJV\n" +
        "UzELMAkGA1UECAwCQ0ExEzARBgNVBAcMCkxvcyBBbmdlbGVzMQswCQYDVQQKDAJJ\n" +
        "VDEQMBAGA1UEAwwJbG9jYWxob3N0MB4XDTE4MTEwNTE5MDUwNFoXDTI4MTEwMjE5\n" +
        "MDUwNFowNTELMAkGA1UEBhMCVVMxCzAJBgNVBAgMAkNBMRMwEQYDVQQHDApMb3Mg\n" +
        "QW5nZWxlczELMAkGA1UECgwCSVQxEDAOBgNVBAMMB2xvY2FsaG9zdDBcMA0GCSqG\n" +
        "SIb3DQEBAQUAA0sAMEgCQQC7VJTUt9Us8cKjMzEfYyjiWA4R4npB9c20HlsIuM5W\n" +
        "QWVT47ubqyP6L0NmuXtBDTyY1j8N6yibDcalB3Nc8wKdAgMBAAEwDQYJKoZIhvcN\n" +
        "AQELBQADQQAGo8h5J9l8QO2s0/7RGYQwV5o4Yb0w9fX/b8d0+X9sR2Y6NJkPLYy4\n" +
        "3cIIj+oQ/q9VoRkQ2i0XJE8R1Kw9v4JJhQ==\n" +
        "-----END CERTIFICATE-----";
      return { cert: Buffer.from(fallbackCert), key: Buffer.from(key) };
    }
  }

  async getSNICallback() {
    return async (domain: string, callback: (err: Error | null, ctx?: any) => void) => {
      try {
        const domainMapping = await this.db.getMapping(domain, "/");
        const isDomainValidated = domainMapping !== null;
        let certDomain = domain;
        if (domainMapping && domainMapping.domain.startsWith("*.") && !domain.startsWith("*")) {
          certDomain = domainMapping.domain;
        }
        const certificate = await this.ensureCertificate(certDomain, isDomainValidated);
        const context = tls.createSecureContext({ cert: certificate.cert, key: certificate.key });
        callback(null, context);
      } catch (error: any) {
        this.logger.error(`SNI callback error for ${domain}:`, error);
        callback(error);
      }
    };
  }

  async ensureCertificate(domain: string, isDomainValidated = false): Promise<any> {
    if (domain.startsWith("*.")) {
      return await this.ensureWildcardCertificate(domain.replace("*.", ""), isDomainValidated);
    }

    // Memory cache
    if (this.certificates.has(domain)) {
      const cached = this.certificates.get(domain)!;
      if (await this.isCertificateValid(cached.cert)) return cached;
      this.certificates.delete(domain);
    }

    // Wildcard fallback for subdomains
    const mainDomain = this.getMainDomain(domain);
    if (domain !== mainDomain) {
      const wildcardCert = await this.getWildcardCertificate(mainDomain);
      if (wildcardCert) {
        this.logger.info(`Using wildcard certificate for ${domain} from *.${mainDomain}`);
        this.certificates.set(domain, wildcardCert);
        return wildcardCert;
      }
    }

    // Disk
    const certPath = path.join(this.certsDir, `${domain}.crt`);
    const keyPath = path.join(this.certsDir, `${domain}.key`);
    try {
      const cert = await fs.readFile(certPath);
      const key = await fs.readFile(keyPath);
      if (await this.isCertificateValid(cert)) {
        const isRealCert = await this.isRealCertificate(cert);
        if (isRealCert) {
          this.certificates.set(domain, { cert, key });
          return { cert, key };
        }
        this.certificates.set(domain, { cert, key });
        return { cert, key };
      }
    } catch {
      if (this.certificates.has(domain)) {
        const cached = this.certificates.get(domain)!;
        if (await this.isCertificateValid(cached.cert)) return cached;
        this.certificates.delete(domain);
      }
    }

    if (!isDomainValidated) {
      this.logger.warn(`Domain ${domain} not validated — using self-signed certificate`);
      const cert = await this.generateSelfSignedCertificate(domain);
      this.certificates.set(domain, cert);
      return cert;
    }

    if (!this.isPublicDomain(domain)) {
      this.logger.info(`Domain ${domain} is not a public FQDN — using self-signed certificate`);
      const cert = await this.generateSelfSignedCertificate(domain);
      this.certificates.set(domain, cert);
      return cert;
    }

    const capable = await this.testAcmeCapability(domain);
    if (!capable) {
      const cert = await this.generateSelfSignedCertificate(domain);
      this.certificates.set(domain, cert);
      return cert;
    }

    if (this.pendingCerts.has(domain)) {
      this.logger.info(`Joining in-flight certificate request for ${domain}`);
      const timeout = new Promise<null>((r) => setTimeout(() => r(null), 30000));
      const cert = await Promise.race([this.pendingCerts.get(domain)!, timeout]);
      if (cert) return cert;
      this.logger.warn(`ACME stuck for ${domain} after 30s, giving up on this attempt`);
      this.pendingCerts.delete(domain);
      return await this.generateSelfSignedCertificate(domain);
    }

    const now = Date.now();
    const lastRequest = this.lastCertRequest.get(domain) ?? 0;
    if (now - lastRequest < 5 * 60 * 1000) {
      this.logger.warn(`Rate limit: too soon to request certificate for ${domain}`);
      const cert = await this.generateSelfSignedCertificate(domain);
      this.certificates.set(domain, cert);
      return cert;
    }

    const requestCount = this.certRequestCount.get(domain) ?? 0;
    if (requestCount >= 5) {
      this.logger.error(`Rate limit: too many certificate requests for ${domain} this week`);
      const cert = await this.generateSelfSignedCertificate(domain);
      this.certificates.set(domain, cert);
      return cert;
    }

    this.lastCertRequest.set(domain, now);
    this.certRequestCount.set(domain, requestCount + 1);

    const certPromise = this.obtainCertificate(domain)
      .then((certificate: any) => {
        this.certificates.set(domain, certificate);
        return certificate;
      })
      .catch(async (err: unknown) => {
        this.logger.error(`ACME failed for ${domain}, falling back to self-signed:`, err);
        return await this.generateSelfSignedCertificate(domain);
      })
      .finally(() => {
        this.pendingCerts.delete(domain);
      });

    this.pendingCerts.set(domain, certPromise);
    return await certPromise;
  }

  async ensureWildcardCertificate(mainDomain: string, isDomainValidated = false): Promise<any> {
    const wildcardDomain = `*.${mainDomain}`;

    if (this.wildcardCerts.has(mainDomain)) {
      const cached = this.wildcardCerts.get(mainDomain)!;
      if (await this.isCertificateValid(cached.cert)) return cached;
      this.wildcardCerts.delete(mainDomain);
    }

    try {
      const cert = await fs.readFile(path.join(this.certsDir, `wildcard.${mainDomain}.crt`));
      const key = await fs.readFile(path.join(this.certsDir, `wildcard.${mainDomain}.key`));
      if (await this.isCertificateValid(cert)) {
        const certificate = { cert, key };
        this.wildcardCerts.set(mainDomain, certificate);
        this.logger.info(`Using cached wildcard certificate for ${wildcardDomain}`);
        return certificate;
      }
    } catch { /* no disk cert */ }

    if (!isDomainValidated) {
      const cert = await this.generateSelfSignedCertificate(wildcardDomain);
      this.wildcardCerts.set(mainDomain, cert);
      return cert;
    }

    if (!this.isPublicDomain(mainDomain)) {
      const cert = await this.generateSelfSignedCertificate(wildcardDomain);
      this.wildcardCerts.set(mainDomain, cert);
      return cert;
    }

    if (!this.acmeClient) {
      this.logger.warn(`ACME client not available for ${wildcardDomain} — using self-signed`);
      return await this.generateSelfSignedCertificate(wildcardDomain);
    }

    const pendingFile = path.join(this.certsDir, `wildcard.${mainDomain}.pending.json`);
    let pending: any = null;
    try {
      const data = await fs.readFile(pendingFile, "utf8");
      pending = JSON.parse(data);
      if (new Date(pending.expiresAt) < new Date()) {
        pending = null;
        await fs.unlink(pendingFile).catch(() => {});
      }
    } catch { /* no pending file */ }

    if (!pending) {
      if (this.processingDomains.has(wildcardDomain)) {
        await this.waitForCertificateProcessing(wildcardDomain);
        return this.wildcardCerts.get(mainDomain) ??
          await this.generateSelfSignedCertificate(wildcardDomain);
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
      this.logger.error(
        `[ACTION REQUIRED] Add this DNS TXT record for ${wildcardDomain}:\n` +
          `  Type:  TXT\n  Name:  _acme-challenge\n  Value: ${pending.txtRecordValue}`,
      );
      return await this.generateSelfSignedCertificate(wildcardDomain);
    }

    if (this.processingDomains.has(wildcardDomain)) {
      await this.waitForCertificateProcessing(wildcardDomain);
      return this.wildcardCerts.get(mainDomain) ??
        await this.generateSelfSignedCertificate(wildcardDomain);
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

  getMainDomain(domain: string): string {
    const parts = domain.split(".");
    if (parts.length <= 2) return domain;
    const tldPatterns = [/\.(co|ac|gov|org|net|edu|mil)\.\w+$/, /\.\w+$/];
    for (const pattern of tldPatterns) {
      const match = domain.match(pattern);
      if (match) {
        const tld = match[0];
        const withoutTld = domain.slice(0, -tld.length);
        const domainParts = withoutTld.split(".");
        return domainParts[domainParts.length - 1] + tld;
      }
    }
    return parts.slice(-2).join(".");
  }

  isPublicDomain(domain: string): boolean {
    if (!domain.includes(".")) return false;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(domain)) return false;
    const privateSuffixes = [
      ".local", ".localhost", ".internal", ".lan", ".test",
      ".example", ".invalid", ".home", ".corp", ".localdomain",
      ".intranet", ".private",
    ];
    const lower = domain.toLowerCase();
    return !privateSuffixes.some((s) => lower.endsWith(s));
  }

  async getWildcardCertificate(mainDomain: string): Promise<any> {
    if (this.wildcardCerts.has(mainDomain)) return this.wildcardCerts.get(mainDomain)!;
    try {
      const cert = await fs.readFile(path.join(this.certsDir, `wildcard.${mainDomain}.crt`));
      const key = await fs.readFile(path.join(this.certsDir, `wildcard.${mainDomain}.key`));
      if (await this.isCertificateValid(cert)) {
        const certificate = { cert, key };
        this.wildcardCerts.set(mainDomain, certificate);
        this.logger.info(`Loaded wildcard certificate from disk for *.${mainDomain}`);
        return certificate;
      }
    } catch { /* no file */ }
    return null;
  }

  getTestChallenge(token: string): string | null {
    return this.testChallenges.get(token) ?? null;
  }

  async testAcmeCapability(domain: string): Promise<boolean> {
    if (this.acmeCapable.has(domain)) return this.acmeCapable.get(domain)!;

    const token = crypto.randomBytes(16).toString("hex");
    const value = crypto.randomBytes(16).toString("hex");
    this.testChallenges.set(token, value);

    let capable = false;
    try {
      const response = await fetch(
        `http://${domain}/.well-known/test-challenge/${token}`,
        { signal: AbortSignal.timeout(5000) },
      );
      const body = await response.text();
      capable = response.status === 200 && body === value;
    } catch {
      capable = false;
    } finally {
      this.testChallenges.delete(token);
    }

    if (capable) {
      this.logger.info(`ACME HTTP-01 reachability confirmed for ${domain}`);
    } else {
      this.logger.warn(
        `ACME HTTP-01 not reachable for ${domain} — will use self-signed certificate`,
      );
    }
    this.acmeCapable.set(domain, capable);
    return capable;
  }

  async waitForCertificateProcessing(domain: string, maxWait = 30000) {
    const start = Date.now();
    while (this.processingDomains.has(domain) && Date.now() - start < maxWait) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async obtainCertificate(domain: string): Promise<any> {
    this.logger.info(`Obtaining certificate for domain: ${domain}`);
    if (!this.acmeClient) {
      this.logger.warn(`ACME client not available, generating self-signed for ${domain}`);
      return await this.generateSelfSignedCertificate(domain);
    }

    const privateKey = await acme.forge.createPrivateKey();
    const [key, csr] = await acme.forge.createCsr(
      { commonName: domain, altNames: [domain] },
      privateKey,
    );

    const cert = await this.acmeClient.auto({
      csr,
      email: null,
      termsOfServiceAgreed: true,
      challengeCreateFn: this.challengeCreateFn.bind(this),
      challengeRemoveFn: this.challengeRemoveFn.bind(this),
    });

    const certPath = path.join(this.certsDir, `${domain}.crt`);
    const keyPath = path.join(this.certsDir, `${domain}.key`);
    await fs.writeFile(certPath, cert);
    await fs.writeFile(keyPath, key);

    this.logger.info(`Certificate obtained and saved for ${domain}`);
    return { cert: Buffer.from(cert), key: Buffer.from(key) };
  }

  async createWildcardOrder(mainDomain: string): Promise<any> {
    this.logger.info(`Creating wildcard ACME order for *.${mainDomain}`);
    const order = await this.acmeClient.createOrder({
      identifiers: [{ type: "dns", value: `*.${mainDomain}` }],
    });
    const authorizations = await this.acmeClient.getAuthorizations(order);
    for (const authz of authorizations) {
      const challenge = authz.challenges.find((c: any) => c.type === "dns-01");
      if (challenge) {
        const txtValue = await this.acmeClient.getChallengeKeyAuthorization(challenge);
        return {
          mainDomain,
          txtRecordName: `_acme-challenge.${mainDomain}`,
          txtRecordValue: txtValue,
          createdAt: new Date().toISOString(),
          expiresAt:
            order.expires ??
            new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString(),
          order: { url: order.url, finalize: order.finalize },
          authz: { url: authz.url, identifier: authz.identifier },
          challenge: {
            type: challenge.type,
            url: challenge.url,
            token: challenge.token,
            status: challenge.status,
          },
        };
      }
    }
    throw new Error(`No dns-01 challenge found for *.${mainDomain}`);
  }

  /**
   * Replaces Node.js execSync("dig …") with Deno.Command.
   * Requires --allow-run permission (baked in at compile time).
   */
  async checkDnsTxtRecord(recordName: string, expectedValue: string): Promise<boolean> {
    try {
      const cmd = new Deno.Command("dig", { args: ["+short", "TXT", recordName] });
      const { stdout } = await cmd.output();
      const output = new TextDecoder().decode(stdout);
      return output.includes(`"${expectedValue}"`);
    } catch {
      return false;
    }
  }

  async completePendingWildcardOrder(mainDomain: string, pending: any): Promise<any> {
    this.logger.info(`DNS record verified — completing wildcard ACME order for *.${mainDomain}`);
    const privateKey = await acme.forge.createPrivateKey();
    const [key, csr] = await acme.forge.createCsr(
      { commonName: `*.${mainDomain}`, altNames: [`*.${mainDomain}`] },
      privateKey,
    );

    await this.acmeClient.completeChallenge(pending.challenge);
    await this.acmeClient.waitForValidStatus(pending.authz);
    const finalizedOrder = await this.acmeClient.finalizeOrder(pending.order, csr);
    const cert = await this.acmeClient.getCertificate(finalizedOrder);

    await fs.writeFile(path.join(this.certsDir, `wildcard.${mainDomain}.crt`), cert);
    await fs.writeFile(path.join(this.certsDir, `wildcard.${mainDomain}.key`), key);

    this.logger.info(`Wildcard certificate obtained and saved for *.${mainDomain}`);
    return { cert: Buffer.from(cert), key: Buffer.from(key) };
  }

  async getChallenge(token: string): Promise<string | null> {
    if (this.challenges.has(token)) return this.challenges.get(token)!;
    const challengeFile = path.join(
      this.certsDir,
      ".well-known",
      "acme-challenge",
      token,
    );
    try {
      return await fs.readFile(challengeFile, "utf8");
    } catch {
      return null;
    }
  }

  async challengeCreateFn(authz: any, challenge: any, keyAuthorization: string) {
    this.logger.info(`Creating challenge for ${authz.identifier.value}: ${challenge.type}`);
    if (challenge.type === "http-01") {
      this.challenges.set(challenge.token, keyAuthorization);
      const challengePath = path.join(this.certsDir, ".well-known", "acme-challenge");
      await fs.mkdir(challengePath, { recursive: true });
      await fs.writeFile(path.join(challengePath, challenge.token), keyAuthorization);
      this.logger.info(`HTTP challenge created: token=${challenge.token}`);
    }
  }

  async challengeRemoveFn(authz: any, challenge: any) {
    this.logger.info(`Removing challenge for ${authz.identifier.value}: ${challenge.type}`);
    if (challenge.type === "http-01") {
      this.challenges.delete(challenge.token);
      try {
        await fs.unlink(
          path.join(this.certsDir, ".well-known", "acme-challenge", challenge.token),
        );
        this.logger.info(`HTTP challenge removed: token=${challenge.token}`);
      } catch (error) {
        this.logger.warn("Failed to remove challenge file:", error);
      }
    }
  }
}
