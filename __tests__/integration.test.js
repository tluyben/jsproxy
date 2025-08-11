const DatabaseManager = require('../src/DatabaseManager');
const path = require('path');
const fs = require('fs').promises;

describe('Integration Tests', () => {
  let testDataDir;
  let dbManager;
  let logger;

  beforeAll(async () => {
    testDataDir = path.join(__dirname, 'integration-data');
    
    try {
      await fs.mkdir(testDataDir, { recursive: true });
    } catch (error) {
      // Directory already exists
    }

    logger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn()
    };
  });

  beforeEach(async () => {
    dbManager = new DatabaseManager(logger);
    dbManager.dbPath = path.join(testDataDir, 'test.db');
    await dbManager.initialize();
  });

  afterEach(async () => {
    if (dbManager) {
      await dbManager.close();
    }
  });

  afterAll(async () => {
    try {
      const files = await fs.readdir(testDataDir);
      for (const file of files) {
        const filePath = path.join(testDataDir, file);
        const stat = await fs.stat(filePath);
        if (stat.isDirectory()) {
          const subFiles = await fs.readdir(filePath);
          for (const subFile of subFiles) {
            await fs.unlink(path.join(filePath, subFile));
          }
          await fs.rmdir(filePath);
        } else {
          await fs.unlink(filePath);
        }
      }
      await fs.rmdir(testDataDir);
    } catch (error) {
      // Cleanup failed, ignore
    }
  });

  test('should create and query database mappings', async () => {
    await dbManager.addMapping('api.example.com', '', 3001, '');
    await dbManager.addMapping('admin.example.com', '', 3002, '');
    await dbManager.addMapping('app.example.com', 'api/v1', 3001, 'v1');
    await dbManager.addMapping('app.example.com', 'api/v2', 3002, 'v2');

    const mapping1 = await dbManager.getMapping('api.example.com', '/test');
    expect(mapping1).toBeDefined();
    expect(mapping1.back_port).toBe(3001);

    const mapping2 = await dbManager.getMapping('app.example.com', '/api/v1/users');
    expect(mapping2).toBeDefined();
    expect(mapping2.back_port).toBe(3001);
    expect(mapping2.back_uri).toBe('v1');

    const mapping3 = await dbManager.getMapping('app.example.com', '/api/v2/users');
    expect(mapping3).toBeDefined();
    expect(mapping3.back_port).toBe(3002);
    expect(mapping3.back_uri).toBe('v2');
  });

  test('should handle database hot replacement', async () => {
    // Add initial mappings
    await dbManager.addMapping('old.example.com', '', 3001, '');
    
    // Create new database
    const newDbPath = path.join(testDataDir, 'new.db');
    const newDbManager = new DatabaseManager(logger);
    newDbManager.dbPath = newDbPath;
    
    await newDbManager.initialize();
    await newDbManager.addMapping('new.example.com', '', 3001, '');
    await newDbManager.close();

    // Hot replace
    await dbManager.hotReplaceDatabase(newDbPath);

    // Verify new mapping exists
    const mapping = await dbManager.getMapping('new.example.com', '/');
    expect(mapping).toBeDefined();
    expect(mapping.domain).toBe('new.example.com');

    // Verify old mapping is gone
    const oldMapping = await dbManager.getMapping('old.example.com', '/');
    expect(oldMapping).toBeNull();
  });

  test('should return null for unmapped routes', async () => {
    const mapping = await dbManager.getMapping('unknown.com', '/test');
    expect(mapping).toBeNull();
  });

  test('should handle longest URI match correctly', async () => {
    await dbManager.addMapping('example.com', '', 3000, '');
    await dbManager.addMapping('example.com', 'api', 3001, 'v1');
    await dbManager.addMapping('example.com', 'api/users', 3002, 'v2');

    const mapping = await dbManager.getMapping('example.com', '/api/users/123');
    expect(mapping.back_port).toBe(3002);
    expect(mapping.front_uri).toBe('api/users');
  });
});