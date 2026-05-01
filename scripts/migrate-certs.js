#!/usr/bin/env node
/**
 * Migrates existing certs/ directory to the new naming scheme:
 *   domain.trusted.crt / domain.trusted.key   — Let's Encrypt certs
 *   domain.selfsigned.crt / domain.selfsigned.key — self-signed certs
 *
 * Before: all certs were domain.crt / domain.key regardless of type
 * Safe to re-run — already-migrated files (.trusted.crt / .selfsigned.crt) are skipped.
 */

const forge = require('node-forge');
const fs = require('fs');
const path = require('path');

const CERTS_DIR = process.env.CERTS_DIR || './certs';

function classify(certPem) {
  try {
    const cert = forge.pki.certificateFromPem(certPem);

    const subjectStr = cert.subject.attributes
      .map(a => `${a.name}=${a.value}`).sort().join(',');
    const issuerStr = cert.issuer.attributes
      .map(a => `${a.name}=${a.value}`).sort().join(',');

    if (subjectStr === issuerStr) return 'selfsigned';

    const org = cert.subject.attributes.find(a => a.name === 'organizationName');
    if (org && org.value === 'Test') return 'selfsigned';

    return 'trusted';
  } catch (e) {
    return 'unknown';
  }
}

let files;
try {
  files = fs.readdirSync(CERTS_DIR);
} catch (e) {
  console.error(`Cannot read certs directory: ${CERTS_DIR}`);
  process.exit(1);
}

// Only process bare .crt files — skip already-migrated, wildcards, and default
const toProcess = files.filter(f =>
  f.endsWith('.crt') &&
  !f.endsWith('.trusted.crt') &&
  !f.endsWith('.selfsigned.crt') &&
  !f.startsWith('wildcard.') &&
  f !== 'default.crt'
);

if (toProcess.length === 0) {
  console.log('No certificates to migrate (all already migrated or nothing found).');
  process.exit(0);
}

const counts = { trusted: 0, selfsigned: 0, skipped: 0, unknown: 0 };

for (const certFile of toProcess) {
  const domain = certFile.replace('.crt', '');
  const certPath = path.join(CERTS_DIR, certFile);
  const keyPath  = path.join(CERTS_DIR, `${domain}.key`);

  let certPem;
  try {
    certPem = fs.readFileSync(certPath, 'utf8');
  } catch (e) {
    console.log(`  SKIP     ${domain}  — cannot read cert: ${e.message}`);
    counts.skipped++;
    continue;
  }

  if (!fs.existsSync(keyPath)) {
    console.log(`  SKIP     ${domain}  — no matching .key file`);
    counts.skipped++;
    continue;
  }

  const type = classify(certPem);

  if (type === 'trusted') {
    fs.renameSync(certPath, path.join(CERTS_DIR, `${domain}.trusted.crt`));
    fs.renameSync(keyPath,  path.join(CERTS_DIR, `${domain}.trusted.key`));
    console.log(`  TRUSTED  ${domain}  →  ${domain}.trusted.{crt,key}`);
    counts.trusted++;
  } else if (type === 'selfsigned') {
    fs.renameSync(certPath, path.join(CERTS_DIR, `${domain}.selfsigned.crt`));
    fs.renameSync(keyPath,  path.join(CERTS_DIR, `${domain}.selfsigned.key`));
    console.log(`  SELFSIGN ${domain}  →  ${domain}.selfsigned.{crt,key}`);
    counts.selfsigned++;
  } else {
    console.log(`  UNKNOWN  ${domain}  — could not parse cert, leaving as-is`);
    counts.unknown++;
  }
}

console.log(`
Done:
  ${counts.trusted}   trusted (Let's Encrypt)  →  .trusted.*
  ${counts.selfsigned}   self-signed              →  .selfsigned.*
  ${counts.skipped}   skipped (missing key or unreadable)
  ${counts.unknown}   unknown (parse error, left as-is)`);
