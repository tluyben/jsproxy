//! Database manager for SQLite operations
//! Handles the mappings table with domain routing configurations

use anyhow::Result;
use parking_lot::Mutex;
use rusqlite::{Connection, params, OptionalExtension};
use std::path::Path;
use std::sync::Arc;
use uuid::Uuid;

/// Represents a domain mapping configuration
#[derive(Debug, Clone)]
pub struct Mapping {
    pub id: String,
    pub domain: String,
    pub front_uri: String,
    pub back_port: u16,
    pub back_uri: String,
    pub backend: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// Thread-safe database manager for SQLite operations
/// Uses a Mutex to ensure only one thread accesses the connection at a time
pub struct DatabaseManager {
    conn: Arc<Mutex<Connection>>,
    db_path: String,
}

// Implement Send and Sync manually since we're using Mutex
unsafe impl Send for DatabaseManager {}
unsafe impl Sync for DatabaseManager {}

impl DatabaseManager {
    /// Create a new database manager
    pub fn new<P: AsRef<Path>>(db_path: P) -> Result<Self> {
        let db_path_str = db_path.as_ref().to_string_lossy().to_string();

        // Create parent directory if it doesn't exist
        if let Some(parent) = db_path.as_ref().parent() {
            std::fs::create_dir_all(parent)?;
        }

        let conn = Connection::open(&db_path)?;

        // Enable WAL mode for better concurrent access
        conn.execute_batch("PRAGMA journal_mode=WAL;")?;

        let manager = Self {
            conn: Arc::new(Mutex::new(conn)),
            db_path: db_path_str,
        };

        manager.initialize()?;

        Ok(manager)
    }

    /// Initialize the database schema
    fn initialize(&self) -> Result<()> {
        let conn = self.conn.lock();

        conn.execute(
            "CREATE TABLE IF NOT EXISTS mappings (
                id TEXT PRIMARY KEY,
                domain TEXT NOT NULL,
                front_uri TEXT NOT NULL,
                back_port INTEGER NOT NULL,
                back_uri TEXT NOT NULL,
                backend TEXT DEFAULT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )",
            [],
        )?;

        // Create indexes for faster lookups
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_mappings_domain ON mappings(domain)",
            [],
        )?;

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_mappings_front_uri ON mappings(front_uri)",
            [],
        )?;

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_mappings_domain_front_uri ON mappings(domain, front_uri)",
            [],
        )?;

        Ok(())
    }

    /// Get the database path
    pub fn db_path(&self) -> &str {
        &self.db_path
    }

    /// Find a mapping for a given domain and path
    /// Uses longest-match-first algorithm for front_uri
    pub fn find_mapping(&self, domain: &str, path: &str) -> Result<Option<Mapping>> {
        let conn = self.conn.lock();

        let mut stmt = conn.prepare(
            "SELECT id, domain, front_uri, back_port, back_uri, backend, created_at, updated_at
             FROM mappings
             WHERE domain = ?1
             AND (?2 LIKE '/' || front_uri || '%' OR front_uri = '')
             ORDER BY LENGTH(front_uri) DESC
             LIMIT 1"
        )?;

        let mapping = stmt.query_row(params![domain, path], |row| {
            Ok(Mapping {
                id: row.get(0)?,
                domain: row.get(1)?,
                front_uri: row.get(2)?,
                back_port: row.get(3)?,
                back_uri: row.get(4)?,
                backend: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        }).optional()?;

        Ok(mapping)
    }

    /// Check if a domain exists in the mappings
    pub fn domain_exists(&self, domain: &str) -> Result<bool> {
        let conn = self.conn.lock();

        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM mappings WHERE domain = ?1",
            params![domain],
            |row| row.get(0),
        )?;

        Ok(count > 0)
    }

    /// Add a new mapping
    pub fn add_mapping(
        &self,
        domain: &str,
        front_uri: &str,
        back_port: u16,
        back_uri: &str,
        backend: Option<&str>,
    ) -> Result<Mapping> {
        let conn = self.conn.lock();
        let id = Uuid::new_v4().to_string();

        // Normalize URIs (remove leading/trailing slashes for consistency)
        let front_uri = front_uri.trim_start_matches('/').trim_end_matches('/');
        let back_uri = back_uri.trim_start_matches('/').trim_end_matches('/');

        conn.execute(
            "INSERT INTO mappings (id, domain, front_uri, back_port, back_uri, backend)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, domain, front_uri, back_port as i32, back_uri, backend],
        )?;

        Ok(Mapping {
            id,
            domain: domain.to_string(),
            front_uri: front_uri.to_string(),
            back_port,
            back_uri: back_uri.to_string(),
            backend: backend.map(|s| s.to_string()),
            created_at: chrono::Utc::now().to_rfc3339(),
            updated_at: chrono::Utc::now().to_rfc3339(),
        })
    }

    /// Update an existing mapping
    pub fn update_mapping(
        &self,
        id: &str,
        front_uri: Option<&str>,
        back_uri: Option<&str>,
        back_port: Option<u16>,
        backend: Option<&str>,
    ) -> Result<bool> {
        let conn = self.conn.lock();

        let mut updates = vec![];
        let mut values: Vec<String> = vec![];

        if let Some(uri) = front_uri {
            updates.push("front_uri = ?");
            values.push(uri.trim_start_matches('/').trim_end_matches('/').to_string());
        }

        if let Some(uri) = back_uri {
            updates.push("back_uri = ?");
            values.push(uri.trim_start_matches('/').trim_end_matches('/').to_string());
        }

        if let Some(port) = back_port {
            updates.push("back_port = ?");
            values.push(port.to_string());
        }

        if let Some(srv) = backend {
            updates.push("backend = ?");
            values.push(srv.to_string());
        }

        if updates.is_empty() {
            return Ok(false);
        }

        updates.push("updated_at = CURRENT_TIMESTAMP");
        values.push(id.to_string());

        let placeholders: Vec<String> = (1..=values.len()).map(|i| format!("?{}", i)).collect();
        let update_clauses: Vec<String> = updates.iter().enumerate().map(|(i, u)| {
            if *u == "updated_at = CURRENT_TIMESTAMP" {
                u.to_string()
            } else {
                u.replace("?", &format!("?{}", i + 1))
            }
        }).collect();

        let sql = format!(
            "UPDATE mappings SET {} WHERE id = ?{}",
            update_clauses.join(", "),
            values.len()
        );

        let params: Vec<&dyn rusqlite::ToSql> = values.iter().map(|v| v as &dyn rusqlite::ToSql).collect();
        let affected = conn.execute(&sql, params.as_slice())?;

        Ok(affected > 0)
    }

    /// Delete a mapping by domain and front_uri
    pub fn delete_mapping(&self, domain: &str, front_uri: Option<&str>) -> Result<usize> {
        let conn = self.conn.lock();

        let affected = if let Some(uri) = front_uri {
            let uri = uri.trim_start_matches('/').trim_end_matches('/');
            conn.execute(
                "DELETE FROM mappings WHERE domain = ?1 AND front_uri = ?2",
                params![domain, uri],
            )?
        } else {
            conn.execute(
                "DELETE FROM mappings WHERE domain = ?1",
                params![domain],
            )?
        };

        Ok(affected)
    }

    /// List all mappings, optionally filtered by domain
    pub fn list_mappings(&self, domain: Option<&str>) -> Result<Vec<Mapping>> {
        let conn = self.conn.lock();

        let mut mappings = Vec::new();

        let sql = if domain.is_some() {
            "SELECT id, domain, front_uri, back_port, back_uri, backend, created_at, updated_at
             FROM mappings WHERE domain = ?1 ORDER BY domain, front_uri"
        } else {
            "SELECT id, domain, front_uri, back_port, back_uri, backend, created_at, updated_at
             FROM mappings ORDER BY domain, front_uri"
        };

        let mut stmt = conn.prepare(sql)?;

        let rows = if let Some(d) = domain {
            stmt.query(params![d])?
        } else {
            stmt.query([])?
        };

        let mut rows = rows;
        while let Some(row) = rows.next()? {
            mappings.push(Mapping {
                id: row.get(0)?,
                domain: row.get(1)?,
                front_uri: row.get(2)?,
                back_port: row.get(3)?,
                back_uri: row.get(4)?,
                backend: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            });
        }

        Ok(mappings)
    }

    /// Get a mapping by ID
    pub fn get_mapping_by_id(&self, id: &str) -> Result<Option<Mapping>> {
        let conn = self.conn.lock();

        let mapping = conn.query_row(
            "SELECT id, domain, front_uri, back_port, back_uri, backend, created_at, updated_at
             FROM mappings WHERE id = ?1",
            params![id],
            |row| {
                Ok(Mapping {
                    id: row.get(0)?,
                    domain: row.get(1)?,
                    front_uri: row.get(2)?,
                    back_port: row.get(3)?,
                    back_uri: row.get(4)?,
                    backend: row.get(5)?,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                })
            },
        ).optional()?;

        Ok(mapping)
    }

    /// Find mapping by domain and front_uri
    pub fn find_by_domain_and_uri(&self, domain: &str, front_uri: &str) -> Result<Option<Mapping>> {
        let conn = self.conn.lock();
        let front_uri = front_uri.trim_start_matches('/').trim_end_matches('/');

        let mapping = conn.query_row(
            "SELECT id, domain, front_uri, back_port, back_uri, backend, created_at, updated_at
             FROM mappings WHERE domain = ?1 AND front_uri = ?2",
            params![domain, front_uri],
            |row| {
                Ok(Mapping {
                    id: row.get(0)?,
                    domain: row.get(1)?,
                    front_uri: row.get(2)?,
                    back_port: row.get(3)?,
                    back_uri: row.get(4)?,
                    backend: row.get(5)?,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                })
            },
        ).optional()?;

        Ok(mapping)
    }
}

impl Clone for DatabaseManager {
    fn clone(&self) -> Self {
        // Open a new connection for the clone
        let conn = Connection::open(&self.db_path).expect("Failed to open database");
        conn.execute_batch("PRAGMA journal_mode=WAL;").expect("Failed to set WAL mode");

        Self {
            conn: Arc::new(Mutex::new(conn)),
            db_path: self.db_path.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_create_database() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let db = DatabaseManager::new(&db_path).unwrap();
        assert!(db_path.exists());
    }

    #[test]
    fn test_add_and_find_mapping() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let db = DatabaseManager::new(&db_path).unwrap();

        db.add_mapping("example.com", "api/v1", 3000, "v1", None).unwrap();

        let mapping = db.find_mapping("example.com", "/api/v1/users").unwrap();
        assert!(mapping.is_some());
        let mapping = mapping.unwrap();
        assert_eq!(mapping.domain, "example.com");
        assert_eq!(mapping.front_uri, "api/v1");
        assert_eq!(mapping.back_port, 3000);
    }

    #[test]
    fn test_longest_match_first() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let db = DatabaseManager::new(&db_path).unwrap();

        db.add_mapping("example.com", "api", 3000, "", None).unwrap();
        db.add_mapping("example.com", "api/v1", 3001, "v1", None).unwrap();

        // Should match api/v1 (longer match)
        let mapping = db.find_mapping("example.com", "/api/v1/users").unwrap();
        assert!(mapping.is_some());
        assert_eq!(mapping.unwrap().back_port, 3001);

        // Should match api (shorter match)
        let mapping = db.find_mapping("example.com", "/api/v2/users").unwrap();
        assert!(mapping.is_some());
        assert_eq!(mapping.unwrap().back_port, 3000);
    }
}
