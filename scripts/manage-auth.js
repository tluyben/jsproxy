#!/usr/bin/env node

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'current.db');

const VALID_TYPES = ['basic', 'bearer', 'password'];

function printUsage() {
  console.log(`
Usage: node scripts/manage-auth.js <domain> <command> [options]

Commands:
  --list                          Show current auth config for domain
  --type <basic|bearer|password>  Set auth type (clears credentials if type changes)
  --add-basic <user:pass>         Add a basic-auth credential (user:pass)
  --add-bearer <token>            Add a bearer token credential
  --add-password <pass>           Add a password-only credential
  --remove <value>                Remove a credential by user (basic), token (bearer), or password
  --clear                         Remove all auth from this mapping

Options (for --add-* commands):
  --expires <ISO8601|YYYY-MM-DD>  Credential expiry date/time (optional)
  --max-uses <N>                  Remove credential after N successful uses (optional)

Auth types:
  basic     HTTP Basic Auth — client sends Authorization: Basic base64(user:pass)
  bearer    Bearer token — client sends Authorization: Bearer <token>
  password  Password only — client sends Authorization: Bearer <pass>
            (also accepts Basic auth with any username: Authorization: Basic base64(:pass))

Only one auth type is allowed per mapping at a time.
Multiple credentials of the same type can coexist — any one match grants access.

Examples:
  # Set up bearer auth with a token
  node scripts/manage-auth.js api.example.com --type bearer
  node scripts/manage-auth.js api.example.com --add-bearer mysecrettoken

  # Add bearer token that expires and auto-removes after 50 uses
  node scripts/manage-auth.js api.example.com --add-bearer temptoken --expires 2025-12-31 --max-uses 50

  # Set up basic auth
  node scripts/manage-auth.js api.example.com --type basic
  node scripts/manage-auth.js api.example.com --add-basic alice:s3cr3t
  node scripts/manage-auth.js api.example.com --add-basic bob:p@ssw0rd --max-uses 100

  # Set up password-only auth
  node scripts/manage-auth.js api.example.com --type password
  node scripts/manage-auth.js api.example.com --add-password mysharedpassword

  # List auth config
  node scripts/manage-auth.js api.example.com --list

  # Remove a specific credential
  node scripts/manage-auth.js api.example.com --remove alice
  node scripts/manage-auth.js api.example.com --remove mysecrettoken

  # Remove all auth (open access again)
  node scripts/manage-auth.js api.example.com --clear
`);
}

function connectDB() {
  const db = new sqlite3.Database(dbPath, (err) => {
    if (err) { console.error('Error opening database:', err.message); process.exit(1); }
  });
  return db;
}

function getMapping(db, domain, cb) {
  db.get('SELECT * FROM mappings WHERE domain = ?', [domain], (err, row) => {
    if (err) { console.error('DB error:', err.message); db.close(); process.exit(1); }
    cb(row);
  });
}

function saveCredentials(db, mappingId, authType, credentials, cb) {
  const json = credentials && credentials.length > 0 ? JSON.stringify(credentials) : null;
  const type = json ? authType : null;
  db.run(
    'UPDATE mappings SET auth_type = ?, auth_credentials = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [type, json, mappingId],
    (err) => { if (err) { console.error('DB error:', err.message); db.close(); process.exit(1); } cb(); }
  );
}

function parseCredentials(row) {
  if (!row.auth_credentials) return [];
  try { return JSON.parse(row.auth_credentials); } catch { return []; }
}

function maskCredential(cred, authType) {
  if (authType === 'basic') return `${cred.user}:${'*'.repeat(Math.min(cred.pass.length, 6))}`;
  if (authType === 'bearer') return cred.token.slice(0, 4) + '*'.repeat(Math.max(0, cred.token.length - 4));
  if (authType === 'password') return '*'.repeat(Math.min(cred.pass.length, 6));
  return '?';
}

function cmdList(domain) {
  const db = connectDB();
  getMapping(db, domain, (row) => {
    if (!row) { console.log(`No mapping found for domain: ${domain}`); db.close(); return; }
    if (!row.auth_type) {
      console.log(`\n${domain}: no auth configured (open access)`);
    } else {
      const creds = parseCredentials(row);
      console.log(`\n${domain}: auth_type=${row.auth_type}, ${creds.length} credential(s)`);
      creds.forEach((c, i) => {
        const extras = [];
        if (c.expires_at) extras.push(`expires: ${c.expires_at}`);
        if (c.max_uses) extras.push(`max_uses: ${c.max_uses}, used: ${c.uses || 0}`);
        const extra = extras.length ? `  [${extras.join(', ')}]` : '';
        console.log(`  [${i}] ${maskCredential(c, row.auth_type)}${extra}`);
      });
    }
    db.close();
  });
}

function cmdSetType(domain, type) {
  if (!VALID_TYPES.includes(type)) {
    console.error(`Invalid type "${type}". Must be one of: ${VALID_TYPES.join(', ')}`);
    process.exit(1);
  }
  const db = connectDB();
  getMapping(db, domain, (row) => {
    if (!row) { console.error(`No mapping found for domain: ${domain}`); db.close(); return; }
    const currentType = row.auth_type;
    let creds = parseCredentials(row);
    if (currentType && currentType !== type) {
      creds = [];
      console.log(`Auth type changed from ${currentType} to ${type} — credentials cleared.`);
    }
    saveCredentials(db, row.id, type, creds, () => {
      console.log(`✓ Auth type set to "${type}" for ${domain}`);
      db.close();
    });
  });
}

function cmdAdd(domain, addType, value, expires, maxUses) {
  const db = connectDB();
  getMapping(db, domain, (row) => {
    if (!row) { console.error(`No mapping found for domain: ${domain}`); db.close(); return; }

    const authType = row.auth_type || addType;
    if (row.auth_type && row.auth_type !== addType) {
      console.error(`Cannot add ${addType} credential — mapping uses auth_type="${row.auth_type}". Use --type ${addType} to switch (this clears existing credentials).`);
      db.close();
      return;
    }

    const creds = parseCredentials(row);
    const cred = {};

    if (addType === 'basic') {
      const colonIdx = value.indexOf(':');
      if (colonIdx < 0) { console.error('basic credential must be in user:pass format'); db.close(); return; }
      cred.user = value.slice(0, colonIdx);
      cred.pass = value.slice(colonIdx + 1);
      if (!cred.user || !cred.pass) { console.error('user and pass must both be non-empty'); db.close(); return; }
    } else if (addType === 'bearer') {
      if (!value) { console.error('bearer token must not be empty'); db.close(); return; }
      cred.token = value;
    } else if (addType === 'password') {
      if (!value) { console.error('password must not be empty'); db.close(); return; }
      cred.pass = value;
    }

    if (expires) {
      const d = new Date(expires);
      if (isNaN(d.getTime())) { console.error(`Invalid expiry date: ${expires}`); db.close(); return; }
      cred.expires_at = d.toISOString();
    }
    if (maxUses) {
      const n = parseInt(maxUses, 10);
      if (isNaN(n) || n < 1) { console.error('--max-uses must be a positive integer'); db.close(); return; }
      cred.max_uses = n;
    }

    creds.push(cred);
    saveCredentials(db, row.id, authType, creds, () => {
      const extras = [];
      if (cred.expires_at) extras.push(`expires ${cred.expires_at}`);
      if (cred.max_uses) extras.push(`max ${cred.max_uses} uses`);
      const extra = extras.length ? ` (${extras.join(', ')})` : '';
      console.log(`✓ Added ${addType} credential to ${domain}${extra}`);
      console.log('  Changes are active immediately - no reload needed');
      db.close();
    });
  });
}

function cmdRemove(domain, value) {
  const db = connectDB();
  getMapping(db, domain, (row) => {
    if (!row) { console.error(`No mapping found for domain: ${domain}`); db.close(); return; }
    if (!row.auth_type) { console.log('No auth configured for this mapping.'); db.close(); return; }

    let creds = parseCredentials(row);
    const before = creds.length;

    if (row.auth_type === 'basic') {
      creds = creds.filter(c => c.user !== value);
    } else if (row.auth_type === 'bearer') {
      creds = creds.filter(c => c.token !== value);
    } else if (row.auth_type === 'password') {
      creds = creds.filter(c => c.pass !== value);
    }

    if (creds.length === before) { console.log(`No matching credential found for: ${value}`); db.close(); return; }

    saveCredentials(db, row.id, row.auth_type, creds, () => {
      console.log(`✓ Removed credential from ${domain} (${before - creds.length} removed)`);
      if (creds.length === 0) console.log('  Warning: no credentials remain — all requests will be denied. Use --clear to remove auth entirely.');
      db.close();
    });
  });
}

function cmdClear(domain) {
  const db = connectDB();
  getMapping(db, domain, (row) => {
    if (!row) { console.error(`No mapping found for domain: ${domain}`); db.close(); return; }
    db.run(
      'UPDATE mappings SET auth_type = NULL, auth_credentials = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [row.id],
      (err) => {
        if (err) { console.error('DB error:', err.message); db.close(); return; }
        console.log(`✓ Auth removed from ${domain} — mapping is now open access`);
        db.close();
      }
    );
  });
}

// ── Argument parsing ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.length === 0 || args.includes('--help')) { printUsage(); process.exit(0); }

const domain = args[0];
if (!domain || domain.startsWith('--')) { console.error('Error: domain must be the first argument'); process.exit(1); }

let expires = null;
let maxUses = null;

for (let i = 1; i < args.length; i++) {
  if (args[i] === '--expires') expires = args[++i];
  if (args[i] === '--max-uses') maxUses = args[++i];
}

if (args.includes('--list')) { cmdList(domain); }
else if (args.includes('--clear')) { cmdClear(domain); }
else if (args.includes('--type')) {
  const idx = args.indexOf('--type');
  const type = args[idx + 1];
  if (!type) { console.error('--type requires a value'); process.exit(1); }
  cmdSetType(domain, type);
} else if (args.includes('--remove')) {
  const idx = args.indexOf('--remove');
  const value = args[idx + 1];
  if (!value) { console.error('--remove requires a value'); process.exit(1); }
  cmdRemove(domain, value);
} else if (args.includes('--add-basic')) {
  const idx = args.indexOf('--add-basic');
  const value = args[idx + 1];
  if (!value) { console.error('--add-basic requires user:pass'); process.exit(1); }
  cmdAdd(domain, 'basic', value, expires, maxUses);
} else if (args.includes('--add-bearer')) {
  const idx = args.indexOf('--add-bearer');
  const value = args[idx + 1];
  if (!value) { console.error('--add-bearer requires a token'); process.exit(1); }
  cmdAdd(domain, 'bearer', value, expires, maxUses);
} else if (args.includes('--add-password')) {
  const idx = args.indexOf('--add-password');
  const value = args[idx + 1];
  if (!value) { console.error('--add-password requires a password'); process.exit(1); }
  cmdAdd(domain, 'password', value, expires, maxUses);
} else {
  console.error('Unknown command. Run with --help for usage.');
  process.exit(1);
}
