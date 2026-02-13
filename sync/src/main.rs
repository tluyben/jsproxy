use chrono::Utc;
use rusqlite::{params, Connection};
use std::fs;
use std::path::{Path, PathBuf};
use std::process;
use uuid::Uuid;

const EPOCH: &str = "1970-01-01 00:00:00";
const LASTSYNC_FILENAME: &str = ".lastsync";

const CREATE_TABLE_SQL: &str = "
    CREATE TABLE IF NOT EXISTS mappings (
        id TEXT PRIMARY KEY,
        domain TEXT NOT NULL,
        front_uri TEXT NOT NULL,
        back_port INTEGER NOT NULL,
        back_uri TEXT NOT NULL,
        backend TEXT DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )";

const CREATE_INDEXES_SQL: &[&str] = &[
    "CREATE INDEX IF NOT EXISTS idx_mappings_domain ON mappings(domain)",
    "CREATE INDEX IF NOT EXISTS idx_mappings_front_uri ON mappings(front_uri)",
    "CREATE INDEX IF NOT EXISTS idx_mappings_domain_front_uri ON mappings(domain, front_uri)",
];

#[derive(Debug, Clone, PartialEq)]
struct Mapping {
    id: String,
    domain: String,
    front_uri: String,
    back_port: i64,
    back_uri: String,
    backend: Option<String>,
    created_at: String,
    updated_at: String,
}

fn ensure_schema(conn: &Connection) {
    conn.execute_batch("PRAGMA journal_mode=WAL;").ok();
    conn.execute(CREATE_TABLE_SQL, [])
        .expect("Failed to create mappings table");
    for sql in CREATE_INDEXES_SQL {
        conn.execute(sql, []).expect("Failed to create index");
    }
}

fn lastsync_path(dir: &Path) -> PathBuf {
    dir.join(LASTSYNC_FILENAME)
}

fn read_lastsync(dir: &Path) -> String {
    let path = lastsync_path(dir);
    if path.exists() {
        fs::read_to_string(&path)
            .unwrap_or_else(|_| EPOCH.to_string())
            .trim()
            .to_string()
    } else {
        EPOCH.to_string()
    }
}

fn write_lastsync(dir: &Path, timestamp: &str) {
    let path = lastsync_path(dir);
    fs::write(&path, timestamp).expect("Failed to write .lastsync file");
}

fn get_changed_records(source: &Connection, since: &str) -> Vec<Mapping> {
    let mut stmt = source
        .prepare(
            "SELECT id, domain, front_uri, back_port, back_uri, backend, created_at, updated_at
             FROM mappings WHERE updated_at > ?1
             ORDER BY updated_at ASC",
        )
        .expect("Failed to prepare select statement");

    let rows = stmt
        .query_map(params![since], |row| {
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
        })
        .expect("Failed to query source mappings");

    rows.filter_map(|r| r.ok()).collect()
}

fn find_by_domain_and_front_uri(
    conn: &Connection,
    domain: &str,
    front_uri: &str,
) -> Option<Mapping> {
    let mut stmt = conn
        .prepare(
            "SELECT id, domain, front_uri, back_port, back_uri, backend, created_at, updated_at
             FROM mappings WHERE domain = ?1 AND front_uri = ?2",
        )
        .expect("Failed to prepare find statement");

    stmt.query_row(params![domain, front_uri], |row| {
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
    })
    .ok()
}

fn needs_update(source: &Mapping, target: &Mapping) -> bool {
    source.domain != target.domain
        || source.front_uri != target.front_uri
        || source.back_port != target.back_port
        || source.back_uri != target.back_uri
        || source.backend != target.backend
}

fn insert_mapping(conn: &Connection, m: &Mapping) {
    let new_id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO mappings (id, domain, front_uri, back_port, back_uri, backend, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            new_id,
            m.domain,
            m.front_uri,
            m.back_port,
            m.back_uri,
            m.backend,
            m.created_at,
            m.updated_at,
        ],
    )
    .expect("Failed to insert mapping");
}

fn update_mapping(conn: &Connection, target_id: &str, source: &Mapping) {
    conn.execute(
        "UPDATE mappings SET domain = ?1, front_uri = ?2, back_port = ?3, back_uri = ?4, backend = ?5, updated_at = ?6
         WHERE id = ?7",
        params![
            source.domain,
            source.front_uri,
            source.back_port,
            source.back_uri,
            source.backend,
            source.updated_at,
            target_id,
        ],
    )
    .expect("Failed to update mapping");
}

fn sync_databases(target_path: &str, source_path: &str, sync_dir: &Path) -> (usize, usize) {
    let source = Connection::open(source_path).expect("Failed to open source database");
    let target = Connection::open(target_path).expect("Failed to open target database");

    ensure_schema(&source);
    ensure_schema(&target);

    let since = read_lastsync(sync_dir);
    let changed = get_changed_records(&source, &since);

    let mut inserted = 0usize;
    let mut updated = 0usize;

    for record in &changed {
        match find_by_domain_and_front_uri(&target, &record.domain, &record.front_uri) {
            Some(existing) => {
                if needs_update(record, &existing) {
                    update_mapping(&target, &existing.id, record);
                    updated += 1;
                }
            }
            None => {
                insert_mapping(&target, record);
                inserted += 1;
            }
        }
    }

    let now = Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();
    write_lastsync(sync_dir, &now);

    (inserted, updated)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        eprintln!("Usage: {} <target_db> <source_db>", args[0]);
        eprintln!("  Syncs mappings from source to target SQLite database.");
        process::exit(1);
    }

    let target_path = &args[1];
    let source_path = &args[2];

    if !Path::new(source_path).exists() {
        eprintln!("Error: source database '{}' does not exist", source_path);
        process::exit(1);
    }

    if !Path::new(target_path).exists() {
        eprintln!("Error: target database '{}' does not exist", target_path);
        process::exit(1);
    }

    let cwd = std::env::current_dir().expect("Failed to get current directory");
    let (inserted, updated) = sync_databases(target_path, source_path, &cwd);

    println!(
        "Sync complete: {} inserted, {} updated",
        inserted, updated
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// Helper: create a temp DB file with schema
    fn create_test_db(dir: &Path, name: &str) -> String {
        let path = dir.join(name);
        let conn = Connection::open(&path).unwrap();
        ensure_schema(&conn);
        path.to_str().unwrap().to_string()
    }

    /// Helper: insert a mapping directly with explicit timestamps
    fn insert_test_mapping(
        path: &str,
        id: &str,
        domain: &str,
        front_uri: &str,
        back_port: i64,
        back_uri: &str,
        backend: Option<&str>,
        created_at: &str,
        updated_at: &str,
    ) {
        let conn = Connection::open(path).unwrap();
        conn.execute(
            "INSERT INTO mappings (id, domain, front_uri, back_port, back_uri, backend, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![id, domain, front_uri, back_port, back_uri, backend, created_at, updated_at],
        )
        .unwrap();
    }

    /// Helper: count all mappings in a DB
    fn count_mappings(path: &str) -> i64 {
        let conn = Connection::open(path).unwrap();
        conn.query_row("SELECT COUNT(*) FROM mappings", [], |row| row.get(0))
            .unwrap()
    }

    /// Helper: get a mapping by domain and front_uri
    fn get_mapping(path: &str, domain: &str, front_uri: &str) -> Option<Mapping> {
        let conn = Connection::open(path).unwrap();
        find_by_domain_and_front_uri(&conn, domain, front_uri)
    }

    #[test]
    fn test_ensure_schema_creates_table_and_indexes() {
        let tmp = TempDir::new().unwrap();
        let path = create_test_db(tmp.path(), "test.db");
        let conn = Connection::open(&path).unwrap();

        let table_exists: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name='mappings'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(table_exists);

        let index_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name LIKE 'idx_mappings%'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(index_count, 3);
    }

    #[test]
    fn test_first_sync_no_lastsync_copies_all_records() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();

        let source = create_test_db(dir, "source.db");
        let target = create_test_db(dir, "target.db");

        insert_test_mapping(
            &source, "id1", "example.com", "api/v1", 3000, "v1", None,
            "2024-01-01 00:00:00", "2024-01-01 00:00:00",
        );
        insert_test_mapping(
            &source, "id2", "test.com", "api/v2", 4000, "v2", Some("http://backend.com"),
            "2024-01-02 00:00:00", "2024-01-02 00:00:00",
        );

        let (inserted, updated) = sync_databases(&target, &source, dir);

        assert_eq!(inserted, 2);
        assert_eq!(updated, 0);
        assert_eq!(count_mappings(&target), 2);

        let m1 = get_mapping(&target, "example.com", "api/v1").unwrap();
        assert_eq!(m1.back_port, 3000);
        assert_eq!(m1.back_uri, "v1");
        assert!(m1.backend.is_none());
        assert_ne!(m1.id, "id1");

        let m2 = get_mapping(&target, "test.com", "api/v2").unwrap();
        assert_eq!(m2.back_port, 4000);
        assert_eq!(m2.backend, Some("http://backend.com".to_string()));
        assert_ne!(m2.id, "id2");

        assert!(lastsync_path(dir).exists());
    }

    #[test]
    fn test_sync_with_lastsync_only_copies_newer_records() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();

        let source = create_test_db(dir, "source.db");
        let target = create_test_db(dir, "target.db");

        insert_test_mapping(
            &source, "id1", "old.com", "api", 3000, "api", None,
            "2024-01-01 00:00:00", "2024-01-01 00:00:00",
        );
        insert_test_mapping(
            &source, "id2", "new.com", "api", 4000, "api", None,
            "2024-06-01 00:00:00", "2024-06-01 00:00:00",
        );

        write_lastsync(dir, "2024-03-01 00:00:00");

        let (inserted, updated) = sync_databases(&target, &source, dir);

        assert_eq!(inserted, 1);
        assert_eq!(updated, 0);
        assert_eq!(count_mappings(&target), 1);

        assert!(get_mapping(&target, "old.com", "api").is_none());
        assert!(get_mapping(&target, "new.com", "api").is_some());
    }

    #[test]
    fn test_sync_updates_existing_records_with_different_fields() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();

        let source = create_test_db(dir, "source.db");
        let target = create_test_db(dir, "target.db");

        insert_test_mapping(
            &source, "src-id", "example.com", "api", 5000, "new-api", Some("http://new-backend.com"),
            "2024-01-01 00:00:00", "2024-06-01 00:00:00",
        );

        insert_test_mapping(
            &target, "tgt-id", "example.com", "api", 3000, "old-api", None,
            "2024-01-01 00:00:00", "2024-01-01 00:00:00",
        );

        let (inserted, updated) = sync_databases(&target, &source, dir);

        assert_eq!(inserted, 0);
        assert_eq!(updated, 1);
        assert_eq!(count_mappings(&target), 1);

        let m = get_mapping(&target, "example.com", "api").unwrap();
        assert_eq!(m.id, "tgt-id");
        assert_eq!(m.back_port, 5000);
        assert_eq!(m.back_uri, "new-api");
        assert_eq!(m.backend, Some("http://new-backend.com".to_string()));
    }

    #[test]
    fn test_sync_does_not_update_identical_records() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();

        let source = create_test_db(dir, "source.db");
        let target = create_test_db(dir, "target.db");

        insert_test_mapping(
            &source, "src-id", "example.com", "api", 3000, "api", None,
            "2024-01-01 00:00:00", "2024-06-01 00:00:00",
        );
        insert_test_mapping(
            &target, "tgt-id", "example.com", "api", 3000, "api", None,
            "2024-01-01 00:00:00", "2024-01-01 00:00:00",
        );

        let (inserted, updated) = sync_databases(&target, &source, dir);

        assert_eq!(inserted, 0);
        assert_eq!(updated, 0);

        let m = get_mapping(&target, "example.com", "api").unwrap();
        assert_eq!(m.id, "tgt-id");
    }

    #[test]
    fn test_sync_handles_multiple_domains() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();

        let source = create_test_db(dir, "source.db");
        let target = create_test_db(dir, "target.db");

        insert_test_mapping(
            &source, "id1", "a.com", "api", 3000, "api", None,
            "2024-01-01 00:00:00", "2024-06-01 00:00:00",
        );
        insert_test_mapping(
            &source, "id2", "b.com", "api", 4000, "api", Some("http://b.com"),
            "2024-01-01 00:00:00", "2024-06-01 00:00:00",
        );
        insert_test_mapping(
            &source, "id3", "c.com", "v1", 5000, "v1", None,
            "2024-01-01 00:00:00", "2024-06-01 00:00:00",
        );

        insert_test_mapping(
            &target, "tgt1", "a.com", "api", 3000, "api", None,
            "2024-01-01 00:00:00", "2024-01-01 00:00:00",
        );

        let (inserted, updated) = sync_databases(&target, &source, dir);

        assert_eq!(inserted, 2);
        assert_eq!(updated, 0);
        assert_eq!(count_mappings(&target), 3);
    }

    #[test]
    fn test_sync_same_domain_different_front_uri() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();

        let source = create_test_db(dir, "source.db");
        let target = create_test_db(dir, "target.db");

        insert_test_mapping(
            &source, "id1", "example.com", "api/v1", 3000, "v1", None,
            "2024-01-01 00:00:00", "2024-06-01 00:00:00",
        );
        insert_test_mapping(
            &source, "id2", "example.com", "api/v2", 4000, "v2", None,
            "2024-01-01 00:00:00", "2024-06-01 00:00:00",
        );

        insert_test_mapping(
            &target, "tgt1", "example.com", "api/v1", 3000, "v1", None,
            "2024-01-01 00:00:00", "2024-01-01 00:00:00",
        );

        let (inserted, updated) = sync_databases(&target, &source, dir);

        assert_eq!(inserted, 1);
        assert_eq!(updated, 0);
        assert_eq!(count_mappings(&target), 2);
    }

    #[test]
    fn test_sync_updates_backend_field() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();

        let source = create_test_db(dir, "source.db");
        let target = create_test_db(dir, "target.db");

        insert_test_mapping(
            &source, "src-id", "example.com", "api", 3000, "api", Some("http://backend.com"),
            "2024-01-01 00:00:00", "2024-06-01 00:00:00",
        );
        insert_test_mapping(
            &target, "tgt-id", "example.com", "api", 3000, "api", None,
            "2024-01-01 00:00:00", "2024-01-01 00:00:00",
        );

        let (inserted, updated) = sync_databases(&target, &source, dir);

        assert_eq!(inserted, 0);
        assert_eq!(updated, 1);

        let m = get_mapping(&target, "example.com", "api").unwrap();
        assert_eq!(m.backend, Some("http://backend.com".to_string()));
    }

    #[test]
    fn test_sync_updates_port() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();

        let source = create_test_db(dir, "source.db");
        let target = create_test_db(dir, "target.db");

        insert_test_mapping(
            &source, "src-id", "example.com", "api", 9999, "api", None,
            "2024-01-01 00:00:00", "2024-06-01 00:00:00",
        );
        insert_test_mapping(
            &target, "tgt-id", "example.com", "api", 3000, "api", None,
            "2024-01-01 00:00:00", "2024-01-01 00:00:00",
        );

        let (inserted, updated) = sync_databases(&target, &source, dir);

        assert_eq!(inserted, 0);
        assert_eq!(updated, 1);

        let m = get_mapping(&target, "example.com", "api").unwrap();
        assert_eq!(m.back_port, 9999);
    }

    #[test]
    fn test_sync_updates_back_uri() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();

        let source = create_test_db(dir, "source.db");
        let target = create_test_db(dir, "target.db");

        insert_test_mapping(
            &source, "src-id", "example.com", "api", 3000, "new-backend-path", None,
            "2024-01-01 00:00:00", "2024-06-01 00:00:00",
        );
        insert_test_mapping(
            &target, "tgt-id", "example.com", "api", 3000, "old-backend-path", None,
            "2024-01-01 00:00:00", "2024-01-01 00:00:00",
        );

        let (inserted, updated) = sync_databases(&target, &source, dir);

        assert_eq!(inserted, 0);
        assert_eq!(updated, 1);

        let m = get_mapping(&target, "example.com", "api").unwrap();
        assert_eq!(m.back_uri, "new-backend-path");
    }

    #[test]
    fn test_lastsync_file_written_with_current_timestamp() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();

        let source = create_test_db(dir, "source.db");
        let target = create_test_db(dir, "target.db");

        let before = Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();
        sync_databases(&target, &source, dir);
        let after = Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();

        let lastsync = fs::read_to_string(lastsync_path(dir)).unwrap();
        let lastsync = lastsync.trim();

        assert!(lastsync >= before.as_str());
        assert!(lastsync <= after.as_str());
    }

    #[test]
    fn test_second_sync_only_picks_up_new_changes() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();

        let source = create_test_db(dir, "source.db");
        let target = create_test_db(dir, "target.db");

        insert_test_mapping(
            &source, "id1", "first.com", "api", 3000, "api", None,
            "2024-01-01 00:00:00", "2024-01-01 00:00:00",
        );

        let (inserted, _) = sync_databases(&target, &source, dir);
        assert_eq!(inserted, 1);

        let future_ts = "2099-01-01 00:00:00";
        insert_test_mapping(
            &source, "id2", "second.com", "api", 4000, "api", None,
            future_ts, future_ts,
        );

        let (inserted, updated) = sync_databases(&target, &source, dir);
        assert_eq!(inserted, 1);
        assert_eq!(updated, 0);
        assert_eq!(count_mappings(&target), 2);
    }

    #[test]
    fn test_empty_source_results_in_no_changes() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();

        let source = create_test_db(dir, "source.db");
        let target = create_test_db(dir, "target.db");

        let (inserted, updated) = sync_databases(&target, &source, dir);

        assert_eq!(inserted, 0);
        assert_eq!(updated, 0);
        assert_eq!(count_mappings(&target), 0);
    }

    #[test]
    fn test_sync_preserves_existing_target_records() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();

        let source = create_test_db(dir, "source.db");
        let target = create_test_db(dir, "target.db");

        insert_test_mapping(
            &target, "tgt-only", "target-only.com", "api", 8080, "api", None,
            "2024-01-01 00:00:00", "2024-01-01 00:00:00",
        );

        insert_test_mapping(
            &source, "src-only", "source-only.com", "api", 9090, "api", None,
            "2024-01-01 00:00:00", "2024-06-01 00:00:00",
        );

        let (inserted, updated) = sync_databases(&target, &source, dir);

        assert_eq!(inserted, 1);
        assert_eq!(updated, 0);
        assert_eq!(count_mappings(&target), 2);

        assert!(get_mapping(&target, "target-only.com", "api").is_some());
        assert!(get_mapping(&target, "source-only.com", "api").is_some());
    }

    #[test]
    fn test_needs_update_detects_all_field_changes() {
        let base = Mapping {
            id: "id".to_string(),
            domain: "example.com".to_string(),
            front_uri: "api".to_string(),
            back_port: 3000,
            back_uri: "api".to_string(),
            backend: None,
            created_at: "2024-01-01 00:00:00".to_string(),
            updated_at: "2024-01-01 00:00:00".to_string(),
        };

        // Identical - no update needed
        assert!(!needs_update(&base, &base));

        // Different back_port
        let mut m = base.clone();
        m.back_port = 9999;
        assert!(needs_update(&base, &m));

        // Different back_uri
        let mut m = base.clone();
        m.back_uri = "different".to_string();
        assert!(needs_update(&base, &m));

        // Different backend (None vs Some)
        let mut m = base.clone();
        m.backend = Some("http://backend.com".to_string());
        assert!(needs_update(&base, &m));

        // Different domain
        let mut m = base.clone();
        m.domain = "other.com".to_string();
        assert!(needs_update(&base, &m));

        // Different front_uri
        let mut m = base.clone();
        m.front_uri = "other".to_string();
        assert!(needs_update(&base, &m));

        // Different id only - should NOT trigger update
        let mut m = base.clone();
        m.id = "different-id".to_string();
        assert!(!needs_update(&base, &m));

        // Different timestamps only - should NOT trigger update
        let mut m = base.clone();
        m.created_at = "2025-01-01 00:00:00".to_string();
        m.updated_at = "2025-01-01 00:00:00".to_string();
        assert!(!needs_update(&base, &m));
    }

    #[test]
    fn test_read_lastsync_returns_epoch_when_no_file() {
        let tmp = TempDir::new().unwrap();
        let result = read_lastsync(tmp.path());
        assert_eq!(result, EPOCH);
    }

    #[test]
    fn test_read_lastsync_returns_stored_timestamp() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();

        let ts = "2024-06-15 12:30:00";
        write_lastsync(dir, ts);
        let result = read_lastsync(dir);
        assert_eq!(result, ts);
    }

    #[test]
    fn test_insert_mapping_generates_new_uuid() {
        let tmp = TempDir::new().unwrap();
        let path = create_test_db(tmp.path(), "test.db");

        let m = Mapping {
            id: "original-id".to_string(),
            domain: "example.com".to_string(),
            front_uri: "api".to_string(),
            back_port: 3000,
            back_uri: "api".to_string(),
            backend: None,
            created_at: "2024-01-01 00:00:00".to_string(),
            updated_at: "2024-01-01 00:00:00".to_string(),
        };

        let conn = Connection::open(&path).unwrap();
        insert_mapping(&conn, &m);

        let stored = get_mapping(&path, "example.com", "api").unwrap();
        assert_ne!(stored.id, "original-id");
        assert_eq!(stored.id.len(), 36);
        assert_eq!(stored.domain, "example.com");
        assert_eq!(stored.back_port, 3000);
    }

    #[test]
    fn test_sync_with_backend_null_and_some_variations() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();

        let source = create_test_db(dir, "source.db");
        let target = create_test_db(dir, "target.db");

        insert_test_mapping(
            &source, "id1", "null-backend.com", "api", 3000, "api", None,
            "2024-01-01 00:00:00", "2024-06-01 00:00:00",
        );
        insert_test_mapping(
            &source, "id2", "some-backend.com", "api", 4000, "api", Some("http://remote.com"),
            "2024-01-01 00:00:00", "2024-06-01 00:00:00",
        );

        let (inserted, _) = sync_databases(&target, &source, dir);
        assert_eq!(inserted, 2);

        let m1 = get_mapping(&target, "null-backend.com", "api").unwrap();
        assert!(m1.backend.is_none());

        let m2 = get_mapping(&target, "some-backend.com", "api").unwrap();
        assert_eq!(m2.backend, Some("http://remote.com".to_string()));
    }

    #[test]
    fn test_compatibility_with_project_db_schema() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("compat.db");
        let conn = Connection::open(&path).unwrap();

        conn.execute_batch("PRAGMA journal_mode=WAL;").unwrap();
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
        )
        .unwrap();

        let id = Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO mappings (id, domain, front_uri, back_port, back_uri, backend)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, "test.com", "api/v1", 3000, "v1", Option::<String>::None],
        )
        .unwrap();

        ensure_schema(&conn);
        let mut stmt = conn
            .prepare("SELECT id, domain, front_uri, back_port, back_uri, backend, created_at, updated_at FROM mappings")
            .unwrap();
        let mapping = stmt
            .query_row([], |row| {
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
            })
            .unwrap();

        assert_eq!(mapping.domain, "test.com");
        assert_eq!(mapping.front_uri, "api/v1");
        assert_eq!(mapping.back_port, 3000);
        assert!(mapping.backend.is_none());
        assert!(!mapping.created_at.is_empty());
        assert!(!mapping.updated_at.is_empty());
    }
}
