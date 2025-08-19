#!/usr/bin/env node

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { execSync } = require('child_process');

const dbPath = path.join(__dirname, '..', 'data', 'current.db');

function printUsage() {
  console.log(`
Usage: node scripts/add-mapping.js <domain> <port> [options]

Options:
  --frontend <path>    Add frontend URI mapping (e.g., /app)
  --backend <path>     Add backend URI mapping (e.g., /api)
  --both <path>        Add both frontend and backend with same path
  --delete             Delete the domain mapping instead of adding
  --list               List all current mappings
  --reload             Show confirmation that changes are active (automatic)
  --help               Show this help message

Examples:
  # Add domain with port only
  node scripts/add-mapping.js example.com 3000

  # Add domain with frontend mapping
  node scripts/add-mapping.js example.com 3000 --frontend /app

  # Add domain with backend mapping  
  node scripts/add-mapping.js example.com 3000 --backend /api

  # Add domain with both frontend and backend
  node scripts/add-mapping.js example.com 3000 --frontend / --backend /api

  # Add domain with same path for both
  node scripts/add-mapping.js example.com 3000 --both /

  # Delete a domain mapping
  node scripts/add-mapping.js example.com --delete

  # List all mappings
  node scripts/add-mapping.js --list

  # Add and reload the proxy
  node scripts/add-mapping.js example.com 3000 --frontend / --reload
`);
}

function connectDB() {
  return new sqlite3.Database(dbPath, (err) => {
    if (err) {
      console.error('Error opening database:', err.message);
      process.exit(1);
    }
  });
}

function listMappings() {
  const db = connectDB();
  
  console.log('\nCurrent domain mappings:\n');
  console.log('%-30s %-10s %-15s %-15s %s'.replace(/%(-?\d+)s/g, (match, width) => {
    return `%${width}s`;
  }), 'Domain', 'Port', 'Frontend', 'Backend', 'Created');
  console.log('-'.repeat(80));
  
  db.all(`
    SELECT domain, back_port, front_uri, back_uri, created_at 
    FROM mappings 
    ORDER BY domain
  `, (err, rows) => {
    if (err) {
      console.error('Error listing mappings:', err.message);
      db.close();
      process.exit(1);
    }
    
    if (rows.length === 0) {
      console.log('No mappings found.');
    } else {
      rows.forEach(row => {
        console.log(
          '%-30s %-10s %-15s %-15s %s'
            .replace('%-30s', row.domain.padEnd(30))
            .replace('%-10s', (row.back_port || '-').toString().padEnd(10))
            .replace('%-15s', (row.front_uri || '-').padEnd(15))
            .replace('%-15s', (row.back_uri || '-').padEnd(15))
            .replace('%s', new Date(row.created_at).toLocaleString())
        );
      });
    }
    
    db.close();
  });
}

function deleteDomain(domain) {
  const db = connectDB();
  
  db.run('DELETE FROM mappings WHERE domain = ?', [domain], function(err) {
    if (err) {
      console.error('Error deleting domain:', err.message);
      db.close();
      process.exit(1);
    }
    
    if (this.changes > 0) {
      console.log(`✓ Deleted mapping for domain: ${domain}`);
    } else {
      console.log(`No mapping found for domain: ${domain}`);
    }
    
    db.close();
  });
}

function addMapping(domain, port, frontendPath, backendPath) {
  const db = connectDB();
  
  // First check if domain exists
  db.get('SELECT * FROM mappings WHERE domain = ?', [domain], (err, row) => {
    if (err) {
      console.error('Error checking domain:', err.message);
      db.close();
      process.exit(1);
    }
    
    if (row) {
      // Update existing
      const updates = [];
      const params = [];
      
      if (port) {
        updates.push('back_port = ?');
        params.push(port);
      }
      if (frontendPath !== undefined) {
        updates.push('front_uri = ?');
        params.push(frontendPath || '');
      }
      if (backendPath !== undefined) {
        updates.push('back_uri = ?');
        params.push(backendPath || '');
      }
      
      updates.push('updated_at = CURRENT_TIMESTAMP');
      params.push(domain);
      
      db.run(
        `UPDATE mappings SET ${updates.join(', ')} WHERE domain = ?`,
        params,
        (err) => {
          if (err) {
            console.error('Error updating mapping:', err.message);
            db.close();
            process.exit(1);
          }
          
          console.log(`✓ Updated mapping for domain: ${domain}`);
          if (port) console.log(`  Port: ${port}`);
          if (frontendPath) console.log(`  Frontend: ${frontendPath}`);
          if (backendPath) console.log(`  Backend: ${backendPath}`);
          console.log('\n✓ Changes are active immediately - no reload needed');
          
          db.close();
        }
      );
    } else {
      // Insert new - need to generate an ID
      const id = require('crypto').randomUUID();
      db.run(
        `INSERT INTO mappings (id, domain, back_port, front_uri, back_uri, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [id, domain, port || 0, frontendPath || '', backendPath || ''],
        (err) => {
          if (err) {
            console.error('Error adding mapping:', err.message);
            db.close();
            process.exit(1);
          }
          
          console.log(`✓ Added mapping for domain: ${domain}`);
          if (port) console.log(`  Port: ${port}`);
          if (frontendPath) console.log(`  Frontend: ${frontendPath}`);
          if (backendPath) console.log(`  Backend: ${backendPath}`);
          console.log('\n✓ Changes are active immediately - no reload needed');
          
          db.close();
        }
      );
    }
  });
}

function reloadProxy() {
  console.log('\n✓ Database updated - new mappings are active immediately');
  console.log('  (The proxy automatically reads the latest data on each request)');
}

// Parse arguments
const args = process.argv.slice(2);

if (args.length === 0 || args.includes('--help')) {
  printUsage();
  process.exit(0);
}

if (args.includes('--list')) {
  listMappings();
  process.exit(0);
}

const domain = args[0];
const shouldDelete = args.includes('--delete');
const shouldReload = args.includes('--reload');

if (shouldDelete) {
  deleteDomain(domain);
  if (shouldReload) {
    setTimeout(reloadProxy, 100);
  }
  process.exit(0);
}

// Parse port and paths
const port = args[1] ? parseInt(args[1]) : null;
let frontendPath = null;
let backendPath = null;

for (let i = 2; i < args.length; i++) {
  switch (args[i]) {
    case '--frontend':
      frontendPath = args[++i] || '/';
      break;
    case '--backend':
      backendPath = args[++i] || '/api';
      break;
    case '--both':
      const path = args[++i] || '/';
      frontendPath = path;
      backendPath = path;
      break;
  }
}

if (!port && !frontendPath && !backendPath) {
  console.error('Error: Must provide at least a port or path mapping');
  printUsage();
  process.exit(1);
}

addMapping(domain, port, frontendPath, backendPath);

if (shouldReload) {
  setTimeout(reloadProxy, 100);
}