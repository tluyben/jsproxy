const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs').promises;
const { v4: uuidv4 } = require('uuid');

class DatabaseManager {
  constructor(logger) {
    this.logger = logger;
    this.db = null;
    this.dbPath = './data/current.db';
  }

  async initialize() {
    await this.ensureDataDirectory();
    await this.connectToDatabase();
    await this.enableWALMode();
    await this.createMappingsTable();
  }

  async ensureDataDirectory() {
    const dataDir = path.dirname(this.dbPath);
    try {
      await fs.access(dataDir);
    } catch (error) {
      await fs.mkdir(dataDir, { recursive: true });
      this.logger.info(`Created data directory: ${dataDir}`);
    }
  }

  async connectToDatabase() {
    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(this.dbPath, (err) => {
        if (err) {
          this.logger.error('Error connecting to database:', err);
          reject(err);
        } else {
          this.logger.info(`Connected to SQLite database: ${this.dbPath}`);
          resolve();
        }
      });
    });
  }

  async enableWALMode() {
    return new Promise((resolve, reject) => {
      this.db.run('PRAGMA journal_mode=WAL;', (err) => {
        if (err) {
          this.logger.error('Error enabling WAL mode:', err);
          reject(err);
        } else {
          this.logger.info('WAL mode enabled');
          resolve();
        }
      });
    });
  }

  async createMappingsTable() {
    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS mappings (
        id TEXT PRIMARY KEY,
        domain TEXT NOT NULL,
        front_uri TEXT NOT NULL,
        back_port INTEGER NOT NULL,
        back_uri TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `;

    return new Promise((resolve, reject) => {
      this.db.run(createTableSQL, (err) => {
        if (err) {
          this.logger.error('Error creating mappings table:', err);
          reject(err);
        } else {
          this.logger.info('Mappings table ready');
          this.createIndexes().then(resolve).catch(reject);
        }
      });
    });
  }

  async createIndexes() {
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_mappings_domain ON mappings(domain)',
      'CREATE INDEX IF NOT EXISTS idx_mappings_front_uri ON mappings(front_uri)',
      'CREATE INDEX IF NOT EXISTS idx_mappings_domain_front_uri ON mappings(domain, front_uri)'
    ];

    for (const indexSQL of indexes) {
      await new Promise((resolve, reject) => {
        this.db.run(indexSQL, (err) => {
          if (err) {
            this.logger.error('Error creating index:', err);
            reject(err);
          } else {
            resolve();
          }
        });
      });
    }
  }

  async getMapping(domain, requestUrl) {
    const sql = `
      SELECT * FROM mappings 
      WHERE domain = ? AND (? LIKE '/' || front_uri || '%' OR front_uri = '')
      ORDER BY LENGTH(front_uri) DESC 
      LIMIT 1
    `;

    return new Promise((resolve, reject) => {
      this.db.get(sql, [domain, requestUrl], (err, row) => {
        if (err) {
          this.logger.error('Error getting mapping:', err);
          reject(err);
        } else {
          resolve(row || null);
        }
      });
    });
  }

  async getAllMappings() {
    const sql = 'SELECT * FROM mappings ORDER BY domain, front_uri';
    
    return new Promise((resolve, reject) => {
      this.db.all(sql, [], (err, rows) => {
        if (err) {
          this.logger.error('Error getting all mappings:', err);
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
  }

  async addMapping(domain, frontUri, backPort, backUri) {
    const id = uuidv4();
    const sql = `
      INSERT INTO mappings (id, domain, front_uri, back_port, back_uri)
      VALUES (?, ?, ?, ?, ?)
    `;

    return new Promise((resolve, reject) => {
      this.db.run(sql, [id, domain, frontUri, backPort, backUri], function(err) {
        if (err) {
          reject(err);
        } else {
          resolve({ id, domain, front_uri: frontUri, back_port: backPort, back_uri: backUri });
        }
      });
    });
  }

  async hotReplaceDatabase(newDbPath) {
    this.logger.info(`Starting hot database replacement from: ${newDbPath}`);
    
    try {
      // Verify new database exists
      await fs.access(newDbPath);
      
      // Create a new connection to the new database to verify it's valid
      const tempDb = new sqlite3.Database(newDbPath);
      await new Promise((resolve, reject) => {
        tempDb.get('SELECT name FROM sqlite_master WHERE type="table" AND name="mappings"', (err, row) => {
          tempDb.close();
          if (err) reject(err);
          else if (!row) reject(new Error('New database does not contain mappings table'));
          else resolve();
        });
      });

      // Close current connection
      await this.close();
      
      // Copy new database over current
      await fs.copyFile(newDbPath, this.dbPath);
      
      // Reconnect
      await this.connectToDatabase();
      await this.enableWALMode();
      
      this.logger.info('Database hot replacement completed successfully');
    } catch (error) {
      this.logger.error('Database hot replacement failed:', error);
      
      // Try to reconnect to original database
      try {
        await this.connectToDatabase();
        await this.enableWALMode();
      } catch (reconnectError) {
        this.logger.error('Failed to reconnect to original database:', reconnectError);
      }
      
      throw error;
    }
  }

  async close() {
    if (this.db) {
      return new Promise((resolve) => {
        this.db.close((err) => {
          if (err) {
            this.logger.error('Error closing database:', err);
          } else {
            this.logger.info('Database connection closed');
          }
          resolve();
        });
      });
    }
  }
}

module.exports = DatabaseManager;