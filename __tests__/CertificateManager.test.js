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
});