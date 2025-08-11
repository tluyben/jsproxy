const DatabaseManager = require('../src/DatabaseManager');
const fs = require('fs').promises;
const path = require('path');


describe('DatabaseManager', () => {
  let dbManager;
  let testDbPath;
  let logger;

  beforeEach(async () => {
    logger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn()
    };
    
    testDbPath = path.join(__dirname, 'test-data', 'test.db');
    
    dbManager = new DatabaseManager(logger);
    dbManager.dbPath = testDbPath;
    
    try {
      await fs.mkdir(path.dirname(testDbPath), { recursive: true });
    } catch (error) {
    }
  });

  afterEach(async () => {
    if (dbManager && dbManager.db) {
      await dbManager.close();
    }
    
    try {
      await fs.unlink(testDbPath);
      await fs.unlink(`${testDbPath}-wal`);
      await fs.unlink(`${testDbPath}-shm`);
    } catch (error) {
    }
  });

  afterAll(async () => {
    try {
      await fs.rmdir(path.dirname(testDbPath));
    } catch (error) {
    }
  });

  test('should initialize database and create mappings table', async () => {
    await dbManager.initialize();
    expect(dbManager.db).toBeDefined();
    
    const mappings = await dbManager.getAllMappings();
    expect(Array.isArray(mappings)).toBe(true);
  });

  test('should add and retrieve mapping', async () => {
    await dbManager.initialize();
    
    const mapping = await dbManager.addMapping('example.com', 'api', 3000, 'v1');
    expect(mapping.domain).toBe('example.com');
    expect(mapping.front_uri).toBe('api');
    expect(mapping.back_port).toBe(3000);
    expect(mapping.back_uri).toBe('v1');

    const retrieved = await dbManager.getMapping('example.com', '/api/users');
    expect(retrieved).toBeDefined();
    expect(retrieved.domain).toBe('example.com');
  });

  test('should find best matching mapping by URI length', async () => {
    await dbManager.initialize();
    
    await dbManager.addMapping('example.com', '', 3000, '');
    await dbManager.addMapping('example.com', 'api', 3001, 'v1');
    await dbManager.addMapping('example.com', 'api/users', 3002, 'v2');

    const mapping = await dbManager.getMapping('example.com', '/api/users/123');
    expect(mapping.back_port).toBe(3002);
    expect(mapping.front_uri).toBe('api/users');
  });

  test('should return null for non-existent mapping', async () => {
    await dbManager.initialize();
    
    const mapping = await dbManager.getMapping('nonexistent.com', '/api');
    expect(mapping).toBeNull();
  });

  test('should get all mappings', async () => {
    await dbManager.initialize();
    
    await dbManager.addMapping('example.com', 'api', 3000, 'v1');
    await dbManager.addMapping('test.com', 'web', 3001, '');

    const mappings = await dbManager.getAllMappings();
    expect(mappings).toHaveLength(2);
    expect(mappings.some(m => m.domain === 'example.com')).toBe(true);
    expect(mappings.some(m => m.domain === 'test.com')).toBe(true);
  });
});