'use strict';

/**
 * pii plugin
 *
 * Detects PII (Personally Identifiable Information) fields in JSON request
 * and response bodies by matching field names against known patterns, then
 * replaces the values with realistic mock data (or "[REDACTED]") before the
 * request is forwarded to the backend / the response is returned to the client.
 *
 * Use cases:
 *   - Scrub PII before requests reach a third-party analytics or logging backend
 *   - Anonymise data flowing through a staging / test environment proxy
 *   - Log sanitised request/response bodies without exposing real user data
 *   - Protect PII before forwarding to external microservices
 *
 * Detected field names (case-insensitive, matched by key name):
 *   email, e_mail, email_address
 *   first_name, last_name, full_name, name, display_name, real_name
 *   username, login, handle
 *   phone, mobile, telephone, tel, cell, fax
 *   ssn, social_security, social_security_number
 *   address, addr, street, street_address, billing_address, shipping_address
 *   zip, zip_code, postal, postal_code, postcode
 *   city, town   |   state, province, region   |   country, country_code
 *   dob, date_of_birth, birth_date, birthday
 *   ip, ip_address, ipaddr, remote_addr, client_ip
 *   card_number, credit_card, cc_number, pan
 *   cvv, cvc, security_code
 *   password, passwd, pwd, passphrase, pin
 *   token, access_token, auth_token, refresh_token, session_token, jwt
 *   secret, api_key, api_secret, private_key, client_secret, access_key
 *   avatar, profile_pic, profile_image, photo, picture, image_url
 *
 * Environment variables:
 *   PORT             Plugin listen port                (default: 3005)
 *   PII_MODE         mock | redact                     (default: mock)
 *                      mock   — replace with realistic fake data
 *                      redact — replace with a "[… redacted]" marker
 *   PII_DIRECTION    request | response | both         (default: both)
 *   PII_LOG_FIELDS   true | false — log detected fields to stdout (default: true)
 *
 * Usage:
 *   node plugins/pii.js
 *   PII_MODE=redact PLUGIN=localhost:3005 node index.js
 *
 * How it works:
 *   /valid  → true for all requests (filters happen on payload content)
 *   /before → scrubs PII from the JSON request body (if PII_DIRECTION is request or both)
 *   /after  → scrubs PII from the JSON response body (if PII_DIRECTION is response or both)
 *
 * Non-JSON bodies (binary, text, form-encoded, …) are passed through unchanged.
 * Nested objects and arrays are walked recursively.
 */

const http = require('http');
const { readJson, readHook, sendValid, sendDecision } = require('./_protocol');

const PORT          = parseInt(process.env.PORT || '3005', 10);
const PII_MODE      = (process.env.PII_MODE || 'mock').toLowerCase();   // mock | redact
const PII_DIRECTION = (process.env.PII_DIRECTION || 'both').toLowerCase(); // request | response | both
const PII_LOG       = process.env.PII_LOG_FIELDS !== 'false';

// ── mock data helpers ─────────────────────────────────────────────────────────

const FIRST_NAMES = ['Alice', 'Bob', 'Carol', 'David', 'Emma', 'Frank', 'Grace', 'Henry', 'Iris', 'Jack'];
const LAST_NAMES  = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Wilson', 'Taylor'];
const CITIES      = ['Springfield', 'Shelbyville', 'Oakdale', 'Riverside', 'Lakewood', 'Hillcrest', 'Fairview'];
const STREETS     = ['Main St', 'Oak Ave', 'Maple Dr', 'Cedar Ln', 'Park Blvd', 'Elm St', 'Washington Ave'];
const DOMAINS     = ['example.com', 'test.org', 'sample.net', 'demo.io', 'placeholder.dev'];
const STATES      = ['CA', 'NY', 'TX', 'FL', 'WA', 'OR', 'IL', 'PA', 'OH', 'GA'];
const COUNTRIES   = ['US', 'GB', 'CA', 'AU', 'DE', 'FR', 'JP', 'NL'];

const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const rand = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const pad  = (n, l) => String(n).padStart(l, '0');

// ── PII rules ─────────────────────────────────────────────────────────────────
// Each rule matches a JSON key name (case-insensitive) and provides:
//   mock()    → a realistic fake value  (used when PII_MODE=mock)
//   redacted  → a static placeholder   (used when PII_MODE=redact)
//
// Patterns are tested in order; the first match wins.

const PII_RULES = [
  // Email
  {
    pattern: /^(e?[-_.]?mail|email[-_.]?address|e[-_]mail)$/i,
    mock:    () => `user${rand(1000, 9999)}@${pick(DOMAINS)}`,
    redacted: '[email redacted]',
  },
  // First name
  {
    pattern: /^(first[-_.]?name|given[-_.]?name|forename|fname)$/i,
    mock:    () => pick(FIRST_NAMES),
    redacted: '[first name redacted]',
  },
  // Last name
  {
    pattern: /^(last[-_.]?name|surname|family[-_.]?name|lname)$/i,
    mock:    () => pick(LAST_NAMES),
    redacted: '[last name redacted]',
  },
  // Full / display name (match before bare "name" so it takes priority)
  {
    pattern: /^(full[-_.]?name|display[-_.]?name|real[-_.]?name)$/i,
    mock:    () => `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`,
    redacted: '[name redacted]',
  },
  // Bare "name" — likely a person's name in API contexts
  {
    pattern: /^name$/i,
    mock:    () => `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`,
    redacted: '[name redacted]',
  },
  // Username / login
  {
    pattern: /^(username|user[-_.]?name|login|handle)$/i,
    mock:    () => `user_${rand(1000, 9999)}`,
    redacted: '[username redacted]',
  },
  // Phone
  {
    pattern: /^(phone|phone[-_.]?number|mobile|cell|telephone|tel|fax)$/i,
    mock:    () => `+1-555-${pad(rand(100, 999), 3)}-${pad(rand(1000, 9999), 4)}`,
    redacted: '[phone redacted]',
  },
  // SSN
  {
    pattern: /^(ssn|social[-_.]?security([-_.]?number)?)$/i,
    mock:    () => `${pad(rand(100, 999), 3)}-${pad(rand(10, 99), 2)}-${pad(rand(1000, 9999), 4)}`,
    redacted: '[SSN redacted]',
  },
  // Address lines
  {
    pattern: /^((mailing|billing|shipping|street|home|work)[-_.]?)?addr(ess)?([-_.]?line[_.]?[12])?$/i,
    mock:    () => `${rand(1, 9999)} ${pick(STREETS)}`,
    redacted: '[address redacted]',
  },
  // Zip / Postal code
  {
    pattern: /^(zip([-_.]?code)?|postal([-_.]?code)?|postcode)$/i,
    mock:    () => pad(rand(10000, 99999), 5),
    redacted: '[zip redacted]',
  },
  // City
  {
    pattern: /^(city|town|municipality)$/i,
    mock:    () => pick(CITIES),
    redacted: '[city redacted]',
  },
  // State / Province
  {
    pattern: /^(state|province|region)$/i,
    mock:    () => pick(STATES),
    redacted: '[state redacted]',
  },
  // Country
  {
    pattern: /^(country([-_.]?code)?|nationality)$/i,
    mock:    () => pick(COUNTRIES),
    redacted: '[country redacted]',
  },
  // Date of birth
  {
    pattern: /^(dob|date[-_.]?of[-_.]?birth|birth[-_.]?date|birthday|birth[-_.]?day)$/i,
    mock:    () => `${rand(1950, 2000)}-${pad(rand(1, 12), 2)}-${pad(rand(1, 28), 2)}`,
    redacted: '[DOB redacted]',
  },
  // IP address (documentation range RFC 5737)
  {
    pattern: /^(ip|ip[-_.]?address|ipaddr|remote[-_.]?addr|client[-_.]?ip)$/i,
    mock:    () => `192.0.2.${rand(1, 254)}`,
    redacted: '[IP redacted]',
  },
  // Credit card number
  {
    pattern: /^(card[-_.]?number|credit[-_.]?card|cc[-_.]?number|pan|card[-_.]?num)$/i,
    mock:    () => `4111-${pad(rand(1000, 9999), 4)}-${pad(rand(1000, 9999), 4)}-${pad(rand(1000, 9999), 4)}`,
    redacted: '[card number redacted]',
  },
  // CVV / CVC
  {
    pattern: /^(cvv|cvc|security[-_.]?code|card[-_.]?security)$/i,
    mock:    () => pad(rand(100, 999), 3),
    redacted: '[CVV redacted]',
  },
  // Password — always redact regardless of mode
  {
    pattern: /^(password|passwd|pwd|passphrase|pin)$/i,
    mock:    () => '[REDACTED]',
    redacted: '[REDACTED]',
  },
  // Tokens / secrets — always redact regardless of mode
  {
    pattern: /^(token|access[-_.]?token|auth[-_.]?token|refresh[-_.]?token|session[-_.]?token|jwt|bearer)$/i,
    mock:    () => '[REDACTED]',
    redacted: '[REDACTED]',
  },
  {
    pattern: /^(secret|api[-_.]?key|api[-_.]?secret|private[-_.]?key|client[-_.]?secret|access[-_.]?key)$/i,
    mock:    () => '[REDACTED]',
    redacted: '[REDACTED]',
  },
  // Avatar / profile image URLs
  {
    pattern: /^(avatar|profile[-_.]?(pic|image|photo)|photo|picture|image[-_.]?url)$/i,
    mock:    () => `https://example.com/avatars/${rand(1, 9999)}.png`,
    redacted: '[avatar redacted]',
  },
];

// ── scrubber ──────────────────────────────────────────────────────────────────

/**
 * Check a single key/value pair against the PII rules.
 * Returns the replacement value, or the original value if not PII.
 */
function scrubValue(key, value) {
  // Only scrub scalar values — leave nested objects to be walked recursively
  if (value !== null && typeof value === 'object') return value;
  for (const rule of PII_RULES) {
    if (rule.pattern.test(key)) {
      return PII_MODE === 'redact' ? rule.redacted : rule.mock();
    }
  }
  return value;
}

/**
 * Recursively walk a parsed JSON value and replace PII fields in-place.
 * Mutates `detectedFields` (an array) with the JSON paths of replaced keys.
 * Returns the (new) scrubbed object.
 */
function scrubObject(obj, path, detectedFields) {
  if (Array.isArray(obj)) {
    return obj.map((item, i) => scrubObject(item, `${path}[${i}]`, detectedFields));
  }

  if (obj !== null && typeof obj === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(obj)) {
      const fullPath    = path ? `${path}.${key}` : key;
      const replacement = scrubValue(key, value);

      if (replacement !== value) {
        // This key was matched as PII
        detectedFields.push(fullPath);
        out[key] = replacement;
      } else if (value !== null && typeof value === 'object') {
        // Not PII at this level — recurse
        out[key] = scrubObject(value, fullPath, detectedFields);
      } else {
        out[key] = value;
      }
    }
    return out;
  }

  return obj; // primitive, not an object key → pass through
}

/**
 * Attempt to scrub PII from a raw body Buffer (or string).
 * Returns { buffer, fields } where fields lists the JSON paths that were replaced.
 * If the body is empty or not valid JSON, returns a null buffer with empty fields
 * (signalling "keep the original body" to the caller).
 */
function scrubBody(payload, label) {
  if (!payload || payload.length === 0) return { buffer: null, fields: [] };

  const text = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload);

  let parsed;
  try { parsed = JSON.parse(text); } catch {
    return { buffer: null, fields: [] }; // not JSON — pass through unchanged
  }

  const fields = [];
  const scrubbed = scrubObject(parsed, '', fields);

  if (fields.length === 0) return { buffer: null, fields: [] }; // nothing to do

  if (PII_LOG) {
    console.log(`[pii] ${label} — scrubbed ${fields.length} field(s): ${fields.join(', ')}`);
  }

  return {
    buffer: Buffer.from(JSON.stringify(scrubbed)),
    fields,
  };
}

// ── plugin server ─────────────────────────────────────────────────────────────

http.createServer((req, res) => {
  // ── /valid ──────────────────────────────────────────────────────────────
  if (req.url === '/valid') {
    return readJson(req, (err) => {
      if (err) { res.writeHead(400); return res.end(); }
      // Claim every request — we check content at the body level in /before and /after
      sendValid(res, true);
    });
  }

  // ── /before ─────────────────────────────────────────────────────────────
  if (req.url === '/before') {
    return readHook(req, (err, meta, payload) => {
      if (err) { res.writeHead(400); return res.end(); }
      try {
        if (PII_DIRECTION === 'response') {
          return sendDecision(res, 'CONTINUE'); // nothing to do on the request side
        }

        const label = `${meta.method} ${meta.uri} [req]`;
        const { buffer, fields } = scrubBody(payload, label);

        if (fields.length === 0) {
          return sendDecision(res, 'CONTINUE'); // no PII found
        }

        return sendDecision(res, 'REWRITE_REQUEST', {
          uri:     null,    // null = keep original
          method:  null,
          headers: null,
        }, buffer);
      } catch (e) {
        console.error('[pii] plugin error:', e);
        sendDecision(res, 'CONTINUE'); // always fail-open
      }
    });
  }

  // ── /after ──────────────────────────────────────────────────────────────
  if (req.url === '/after') {
    return readHook(req, (err, meta, payload) => {
      if (err) { res.writeHead(400); return res.end(); }
      try {
        if (PII_DIRECTION === 'request') {
          return sendDecision(res, 'CONTINUE'); // nothing to do on the response side
        }

        const label = `${meta.statusCode} [res]`;
        const { buffer, fields } = scrubBody(payload, label);

        if (fields.length === 0) {
          return sendDecision(res, 'CONTINUE'); // no PII found
        }

        return sendDecision(res, 'REWRITE_RESPONSE', {
          statusCode: null,  // null = keep original
          headers:    null,
        }, buffer);
      } catch (e) {
        console.error('[pii] plugin error:', e);
        sendDecision(res, 'CONTINUE'); // always fail-open
      }
    });
  }

  res.writeHead(404);
  res.end();
}).listen(PORT, () => {
  console.log(`pii plugin listening on port ${PORT}`);
  console.log(`  Mode:      ${PII_MODE}`);
  console.log(`  Direction: ${PII_DIRECTION}`);
  console.log(`  Patterns:  ${PII_RULES.length} PII field patterns`);
  console.log(`  Log:       ${PII_LOG ? 'enabled' : 'disabled'}`);
});
