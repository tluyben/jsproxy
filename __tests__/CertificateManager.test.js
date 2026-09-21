const CertificateManager = require('../src/CertificateManager');
const fs = require('fs').promises;
const path = require('path');

jest.mock('acme-client', () => ({
  forge: {
    createPrivateKey: jest.fn().mockResolvedValue('mock-private-key'),
    createCsr: jest.fn().mockResolvedValue(['mock-key', 'mock-csr'])
  },
  directory: {
    letsencrypt: {
      staging: 'https://acme-staging-v02.api.letsencrypt.org/directory',
      production: 'https://acme-v02.api.letsencrypt.org/directory'
    }
  },
  Client: jest.fn().mockImplementation(() => ({
    getAccountUrl: jest.fn().mockResolvedValue('account-url'),
    createAccount: jest.fn().mockResolvedValue(),
    auto: jest.fn().mockResolvedValue('mock-certificate')
  }))
}));


describe('CertificateManager', () => {
  let certManager;
  let testCertsDir;
  let logger;

  beforeEach(async () => {
    logger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn()
    };

    testCertsDir = path.join(__dirname, 'test-certs');
    
    certManager = new CertificateManager(logger);
    certManager.certsDir = testCertsDir;

    try {
      await fs.mkdir(testCertsDir, { recursive: true });
    } catch (error) {
    }
  });

  afterEach(async () => {
    try {
      const files = await fs.readdir(testCertsDir);
      for (const file of files) {
        await fs.unlink(path.join(testCertsDir, file));
      }
      await fs.rmdir(testCertsDir);
    } catch (error) {
    }
  });

  test('should initialize certificate manager', async () => {
    await certManager.initialize();
    expect(certManager.acmeClient).toBeDefined();
  });

  test('should generate self-signed default certificate', async () => {
    const { cert, key } = await certManager.generateSelfSignedCertificate('localhost');
    expect(cert).toBeDefined();
    expect(key).toBeDefined();
  });

  test('should get default certificate', async () => {
    await certManager.initialize();
    const defaultCert = await certManager.getDefaultCertificate();
    
    expect(defaultCert.cert).toBeDefined();
    expect(defaultCert.key).toBeDefined();
  });

  test('should ensure certificate for domain', async () => {
    await certManager.initialize();
    
    const certificate = await certManager.ensureCertificate('example.com');
    expect(certificate).toBeDefined();
    expect(certificate.cert).toBeDefined();
    expect(certificate.key).toBeDefined();
    
    expect(certManager.certificates.has('example.com')).toBe(true);
  });

  test('should return existing certificate if available', async () => {
    await certManager.initialize();
    
    const mockCert = { cert: 'existing-cert', key: 'existing-key' };
    certManager.certificates.set('example.com', mockCert);
    jest.spyOn(certManager, 'isCertificateValid').mockResolvedValue(true);
    
    const certificate = await certManager.ensureCertificate('example.com');
    expect(certificate).toBe(mockCert);
  });

  test('should handle concurrent certificate requests', async () => {
    await certManager.initialize();
    
    const promises = [
      certManager.ensureCertificate('concurrent.com'),
      certManager.ensureCertificate('concurrent.com'),
      certManager.ensureCertificate('concurrent.com')
    ];
    
    const results = await Promise.all(promises);
    
    expect(results[0]).toBeDefined();
    expect(results[1]).toBe(results[0]);
    expect(results[2]).toBe(results[0]);
  });

  test('should create challenge files for http-01', async () => {
    await certManager.initialize();
    
    const authz = { identifier: { value: 'example.com' } };
    const challenge = { type: 'http-01', token: 'test-token' };
    const keyAuthorization = 'test-key-auth';
    
    await certManager.challengeCreateFn(authz, challenge, keyAuthorization);
    
    const challengePath = path.join(testCertsDir, '.well-known', 'acme-challenge', 'test-token');
    const content = await fs.readFile(challengePath, 'utf8');
    expect(content).toBe(keyAuthorization);
  });

  test('should remove challenge files', async () => {
    await certManager.initialize();
    
    const challengePath = path.join(testCertsDir, '.well-known', 'acme-challenge');
    await fs.mkdir(challengePath, { recursive: true });
    const challengeFile = path.join(challengePath, 'test-token');
    await fs.writeFile(challengeFile, 'test-content');
    
    const authz = { identifier: { value: 'example.com' } };
    const challenge = { type: 'http-01', token: 'test-token' };
    
    await certManager.challengeRemoveFn(authz, challenge, 'test-key-auth');
    
    let exists = true;
    try {
      await fs.access(challengeFile);
    } catch (error) {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  test('a wildcard only covers names exactly one label below it', () => {
    expect(certManager.wildcardParentOf('a.example.com')).toBe('example.com');
    expect(certManager.wildcardParentOf('a.b.example.com')).toBe('b.example.com');
    expect(certManager.wildcardParentOf('example.com')).toBeNull();
    expect(certManager.wildcardParentOf('localhost')).toBeNull();
    expect(certManager.wildcardCovers('*.example.com', 'a.example.com')).toBe(true);
    expect(certManager.wildcardCovers('*.example.com', 'a.b.example.com')).toBe(false);
    expect(certManager.wildcardCovers('*.b.example.com', 'a.b.example.com')).toBe(true);
    expect(certManager.wildcardCovers('*', 'a.example.com')).toBe(false);
  });

  test('ensureCertificate serves a wildcard only to the names it covers', async () => {
    await certManager.initialize();
    certManager.wildcardCerts.set('example.com', { cert: 'WILDCARD-CERT', key: 'WILDCARD-KEY' });
    jest.spyOn(certManager, 'isCertificateValid').mockResolvedValue(true);

    const direct = await certManager.ensureCertificate('a.example.com', true);
    expect(direct.cert).toBe('WILDCARD-CERT');

    // Two labels down: NOT the wildcard (it would fail the handshake).
    const nested = await certManager.ensureCertificate('a.b.example.com', false);
    expect(nested.cert).not.toBe('WILDCARD-CERT');
    expect(nested.type).toBe('selfsigned');

    certManager.certificates.delete('a.b.example.com');
    certManager.wildcardCerts.set('b.example.com', { cert: 'NESTED-WILDCARD', key: 'k' });
    const covered = await certManager.ensureCertificate('a.b.example.com', true);
    expect(covered.cert).toBe('NESTED-WILDCARD');

    expect(await certManager.hasCertificateFor('zzz.example.com')).toBe(true);
    expect(await certManager.hasCertificateFor('zzz.q.example.com')).toBe(false);
  });

  test('the SNI callback uses the mapping wildcard cert only for a direct child', async () => {
    await certManager.initialize();
    const mappings = { 'a.example.com': { domain: '*.example.com' }, 'a.b.example.com': { domain: '*.example.com' } };
    certManager.db = { getMapping: async (d) => mappings[d] || null };
    const asked = [];
    jest.spyOn(certManager, 'ensureCertificate').mockImplementation(async (d) => { asked.push(d); return { cert: 'c', key: 'k' }; });
    jest.spyOn(require('tls'), 'createSecureContext').mockReturnValue({});
    const sni = await certManager.getSNICallback();
    await new Promise((r) => sni('a.example.com', () => r()));
    await new Promise((r) => sni('a.b.example.com', () => r()));
    expect(asked).toEqual(['*.example.com', 'a.b.example.com']);
  });
});
