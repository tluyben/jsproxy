const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { DiskCertStore, DbCertStore, createCertStore } = require('../src/CertStore');
const DatabaseManager = require('../src/DatabaseManager');
const CertificateManager = require('../src/CertificateManager');

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

let tmpDir;
let db;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'certstore-'));
  db = new DatabaseManager(logger);
  db.dbPath = path.join(tmpDir, 'test.db');
  await db.initialize();
});

afterEach(async () => {
  await db.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('DiskCertStore', () => {
  test('round-trips blobs, lists, deletes, and renames', async () => {
    const dir = path.join(tmpDir, 'certs');
    const store = new DiskCertStore(logger, () => dir);
    await store.init();

    expect(await store.read('missing.crt')).toBeNull();

    await store.write('a.trusted.crt', Buffer.from('CERT-A'));
    await store.write('a.trusted.key', Buffer.from('KEY-A'));
    expect((await store.read('a.trusted.crt')).toString()).toBe('CERT-A');
    expect(await store.readText('a.trusted.key')).toBe('KEY-A');

    const list = await store.list();
    expect(list).toEqual(expect.arrayContaining(['a.trusted.crt', 'a.trusted.key']));

    await store.rename('a.trusted.crt', 'b.trusted.crt');
    expect(await store.read('a.trusted.crt')).toBeNull();
    expect((await store.read('b.trusted.crt')).toString()).toBe('CERT-A');

    await store.delete('b.trusted.crt');
    expect(await store.read('b.trusted.crt')).toBeNull();
    await store.delete('b.trusted.crt'); // deleting absent key is a no-op
  });

  test('creates parent dirs for nested challenge keys', async () => {
    const dir = path.join(tmpDir, 'certs');
    const store = new DiskCertStore(logger, () => dir);
    await store.write('.well-known/acme-challenge/tok123', 'auth-value');
    expect(await store.readText('.well-known/acme-challenge/tok123')).toBe('auth-value');
  });
});

describe('DbCertStore', () => {
  test('round-trips blobs, lists, deletes, and renames', async () => {
    const store = new DbCertStore(logger, db);
    await store.init();

    expect(await store.read('missing.crt')).toBeNull();

    await store.write('a.trusted.crt', Buffer.from('CERT-A'));
    await store.write('a.trusted.key', Buffer.from('KEY-A'));
    expect((await store.read('a.trusted.crt')).toString()).toBe('CERT-A');
    expect(await store.readText('a.trusted.key')).toBe('KEY-A');

    // write is an upsert
    await store.write('a.trusted.crt', Buffer.from('CERT-A2'));
    expect((await store.read('a.trusted.crt')).toString()).toBe('CERT-A2');

    const list = await store.list();
    expect(list).toEqual(expect.arrayContaining(['a.trusted.crt', 'a.trusted.key']));

    await store.rename('a.trusted.crt', 'b.trusted.crt');
    expect(await store.read('a.trusted.crt')).toBeNull();
    expect((await store.read('b.trusted.crt')).toString()).toBe('CERT-A2');

    await store.delete('b.trusted.crt');
    expect(await store.read('b.trusted.crt')).toBeNull();
  });

  test('rename of an absent key throws', async () => {
    const store = new DbCertStore(logger, db);
    await store.init();
    await expect(store.rename('nope', 'other')).rejects.toThrow();
  });
});

describe('createCertStore', () => {
  test('defaults to disk and falls back to disk on unknown mode', () => {
    expect(createCertStore('disk', logger, null, () => '.')).toBeInstanceOf(DiskCertStore);
    expect(createCertStore(undefined, logger, null, () => '.')).toBeInstanceOf(DiskCertStore);
    expect(createCertStore('bogus', logger, null, () => '.')).toBeInstanceOf(DiskCertStore);
  });

  test('db mode returns DbCertStore and requires a db manager', () => {
    expect(createCertStore('db', logger, db, () => '.')).toBeInstanceOf(DbCertStore);
    expect(() => createCertStore('db', logger, null, () => '.')).toThrow();
  });
});

describe('CertificateManager with CERT_STORAGE=db', () => {
  test('persists a self-signed cert into the DB and reloads it', async () => {
    const cm = new CertificateManager(logger, db, { storage: 'db' });
    await cm.initialize();

    // Unknown (unvalidated) domain -> self-signed, persisted via the DB store.
    const cert = await cm.ensureCertificate('example.test', false);
    expect(cert.cert).toBeTruthy();
    expect(cert.type).toBe('selfsigned');

    // A fresh manager on the same DB (empty in-memory cache) loads it back.
    const cm2 = new CertificateManager(logger, db, { storage: 'db' });
    await cm2.loadExistingCertificates();
    expect(cm2.certificates.has('example.test')).toBe(true);
    expect(cm2.certificates.get('example.test').type).toBe('selfsigned');
  });

  test('challenge create/get/remove flow through the DB store', async () => {
    const cm = new CertificateManager(logger, db, { storage: 'db' });
    await cm.initialize();
    const authz = { identifier: { value: 'example.test' } };
    const challenge = { type: 'http-01', token: 'tokDB' };

    await cm.challengeCreateFn(authz, challenge, 'key-auth');
    // In-memory hit
    expect(await cm.getChallenge('tokDB')).toBe('key-auth');
    // Force a store read by clearing the in-memory map
    cm.challenges.clear();
    expect(await cm.getChallenge('tokDB')).toBe('key-auth');

    await cm.challengeRemoveFn(authz, challenge, 'key-auth');
    cm.challenges.clear();
    expect(await cm.getChallenge('tokDB')).toBeNull();
  });
});

describe('migration between backends', () => {
  test('disk -> db copies every blob', async () => {
    const dir = path.join(tmpDir, 'certs');
    const disk = new DiskCertStore(logger, () => dir);
    await disk.init();
    await disk.write('x.trusted.crt', Buffer.from('XC'));
    await disk.write('x.trusted.key', Buffer.from('XK'));
    await disk.write('account-key.pem', Buffer.from('ACCT'));

    const dbStore = new DbCertStore(logger, db);
    await dbStore.init();
    for (const key of await disk.list()) {
      const data = await disk.read(key);
      if (data != null) await dbStore.write(key, data);
    }

    expect((await dbStore.read('x.trusted.crt')).toString()).toBe('XC');
    expect((await dbStore.read('account-key.pem')).toString()).toBe('ACCT');
  });
});
