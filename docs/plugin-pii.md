# pii plugin

Detects PII (Personally Identifiable Information) fields in JSON request and response
bodies by matching field names against known patterns, then replaces the values with
realistic mock data — or redacts them — before the request reaches the backend /
the response reaches the client.

## Quick start

```bash
# Terminal 1 — plugin (mock mode, scrubs both directions)
node plugins/pii.js

# Terminal 2 — jsproxy
node scripts/add-mapping.js localhost 3000
PLUGIN=localhost:3005 node index.js
```

Or run the self-contained demo:

```bash
npm run demo:pii
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3005` | Plugin listen port |
| `PII_MODE` | `mock` | `mock` — realistic fake data · `redact` — `[… redacted]` markers |
| `PII_DIRECTION` | `both` | `request` · `response` · `both` |
| `PII_LOG_FIELDS` | `true` | Log detected field paths to stdout |

## How it works

```
/valid  → true for all requests (filtering happens on the payload content)
/before → parses JSON request body, scrubs PII fields, rewrites payload (if PII_DIRECTION ≠ response)
/after  → parses JSON response body, scrubs PII fields, rewrites payload (if PII_DIRECTION ≠ request)
```

Non-JSON bodies (binary, plain text, form-encoded) are passed through unchanged.
The plugin only rewrites the payload when at least one PII field is detected — otherwise
it returns `CONTINUE` with no allocation overhead.

Nested objects and arrays are walked recursively. A nested path like
`shipping.address` or `users[0].email` is fully scrubbed.

## Detected fields

Fields are matched by key name (case-insensitive). Separators (`-`, `_`, `.`) are
interchangeable in patterns. The first matching rule wins.

| Category | Key names matched |
|---|---|
| Email | `email`, `e_mail`, `e-mail`, `email_address`, `mail` |
| First name | `first_name`, `given_name`, `forename`, `fname` |
| Last name | `last_name`, `surname`, `family_name`, `lname` |
| Full name | `full_name`, `display_name`, `real_name`, `name` |
| Username | `username`, `user_name`, `login`, `handle` |
| Phone | `phone`, `phone_number`, `mobile`, `cell`, `telephone`, `tel`, `fax` |
| SSN | `ssn`, `social_security`, `social_security_number` |
| Address | `address`, `addr`, `street`, `street_address`, `billing_address`, `shipping_address`, … |
| Zip / Postal | `zip`, `zip_code`, `postal`, `postal_code`, `postcode` |
| City | `city`, `town`, `municipality` |
| State | `state`, `province`, `region` |
| Country | `country`, `country_code`, `nationality` |
| Date of birth | `dob`, `date_of_birth`, `birth_date`, `birthday` |
| IP address | `ip`, `ip_address`, `ipaddr`, `remote_addr`, `client_ip` |
| Credit card | `card_number`, `credit_card`, `cc_number`, `pan`, `card_num` |
| CVV / CVC | `cvv`, `cvc`, `security_code`, `card_security` |
| Password | `password`, `passwd`, `pwd`, `passphrase`, `pin` — always `[REDACTED]` |
| Token / secret | `token`, `access_token`, `auth_token`, `refresh_token`, `session_token`, `jwt` — always `[REDACTED]` |
| API keys | `secret`, `api_key`, `api_secret`, `private_key`, `client_secret`, `access_key` — always `[REDACTED]` |
| Avatar / photo | `avatar`, `profile_pic`, `profile_image`, `photo`, `picture`, `image_url` |

> **Passwords, tokens, and secrets are always redacted** regardless of `PII_MODE`.
> These should never be replaced with plausible fakes.

## Modes

### `PII_MODE=mock` (default)

Each detected field is replaced with a realistic but entirely fake value:

```json
"email": "jane@real.com"  →  "email": "user4271@sample.net"
"name":  "Jane Doe"       →  "name":  "Alice Williams"
"phone": "555-867-5309"   →  "phone": "+1-555-412-7823"
"ssn":   "123-45-6789"    →  "ssn":   "872-31-5648"
"zip":   "97201"          →  "zip":   "43719"
"ip":    "203.0.113.42"   →  "ip":    "192.0.2.187"
```

Mock IPs use the RFC 5737 documentation range (`192.0.2.0/24`) — guaranteed never to
route to a real host.

Mock credit card numbers start with `4111-` (Visa test prefix) and are otherwise random —
they will fail Luhn validation, which is intentional.

### `PII_MODE=redact`

Each detected field is replaced with a descriptive placeholder:

```json
"email":   "jane@real.com"  →  "email":   "[email redacted]"
"name":    "Jane Doe"       →  "name":    "[name redacted]"
"phone":   "555-867-5309"   →  "phone":   "[phone redacted]"
"password":"hunter2"        →  "password":"[REDACTED]"
```

Use `redact` when you want to make it obvious that data was removed (e.g. in audit logs).
Use `mock` when you want consumers to receive structurally valid data (e.g. staging).

## Direction

### `PII_DIRECTION=both` (default)

Scrubs both the request body (before it reaches the backend) and the response body
(before it reaches the client).

Use case: proxy sits between a client and a third-party data processor. Neither the
processor nor the client should see real PII.

### `PII_DIRECTION=request`

Only scrubs the outgoing request body. The response passes through unchanged.

Use case: forward anonymised data to an analytics backend without altering what the
client receives.

### `PII_DIRECTION=response`

Only scrubs the incoming response body. The request passes through unchanged.

Use case: backend returns user data; strip PII before it reaches the frontend or a
logging layer that captures responses.

## Examples

### Scrub a response body

```bash
# Backend returns real user data
curl http://localhost:8080/api/user/profile
# With pii plugin active (response direction):
# → { "name": "Emma Brown", "email": "user8231@example.com", "ssn": "441-92-3710", … }
```

### Scrub a request body

```bash
curl -X POST http://localhost:8080/api/register \
  -H "Content-Type: application/json" \
  -d '{"name":"Jane Doe","email":"jane@real.com","password":"hunter2","phone":"555-1234"}'

# Backend receives:
# { "name": "Henry Garcia", "email": "user5521@demo.io", "password": "[REDACTED]", "phone": "+1-555-204-7631" }
```

### Nested objects

```bash
curl -X POST http://localhost:8080/api/orders \
  -H "Content-Type: application/json" \
  -d '{
    "order_id": "ORD-001",
    "customer": { "name": "John Smith", "email": "john@real.com" },
    "shipping": { "address": "456 Oak Ave", "city": "Portland", "zip": "97201" }
  }'

# Plugin log:
#   [pii] POST /api/orders [req] — scrubbed 5 field(s): customer.name, customer.email,
#         shipping.address, shipping.city, shipping.zip
```

### Redact mode

```bash
PII_MODE=redact node plugins/pii.js
# Detected fields get clear markers instead of fake values:
# "email": "[email redacted]"
# "password": "[REDACTED]"
```

## Logging

When `PII_LOG_FIELDS=true` (default), the plugin logs a summary for each scrubbed body:

```
[pii] GET /api/user/profile [res] — scrubbed 9 field(s): name, email, phone, ssn, address, city, state, zip, ip_address
[pii] POST /api/register [req] — scrubbed 4 field(s): name, email, password, phone
```

Disable with `PII_LOG_FIELDS=false` to reduce noise in production.

## Chaining with other plugins

The PII plugin always returns `CONTINUE` after rewriting (it never cancels the request),
so it is safe to chain with any other plugin.

**Suggested ordering:**

```bash
# Rewrite the URL first, then strip PII from the (possibly rewritten) request
PLUGIN=localhost:3002,localhost:3005 node index.js

# Strip PII, then capture a telemetry span on the anonymised request
PLUGIN=localhost:3005,localhost:3004 node index.js
```

## False positives and customisation

The plugin matches by key name only — it cannot inspect the value to decide whether a
field truly contains PII. Some field names are broad (e.g. `name` matches any key
literally named `name`).

If you have false positives (e.g. `name` in a product catalogue, not a user record),
fork `plugins/pii.js` and remove or narrow the offending rule in `PII_RULES`. Each
rule is a plain `{ pattern, mock, redacted }` object — no magic.

If you need to add custom patterns (e.g. a field named `tax_id` or `nhs_number`),
append a new rule to `PII_RULES` following the same structure.

## Running the demo

```bash
npm run demo:pii
```

Starts the demo backend, the PII plugin in `mock` + `both` mode, and jsproxy.
Then runs several curl commands showing:

1. **Response scrubbing** — `GET /api/user/profile` returns a profile with name, email,
   SSN, address, card number, etc.; the plugin replaces all of them with mock data.

2. **Array scrubbing** — `GET /api/users` returns an array of user objects; the plugin
   walks each item and scrubs `name`, `email`, `phone` in all of them.

3. **Request scrubbing** — `POST /api/register` with a real name, email, password, etc.;
   the backend echoes back what it received — you'll see mock values, not the real ones.

4. **Nested object scrubbing** — `POST /api/orders` with a nested `customer` and
   `shipping` object; all PII in both nested objects is replaced.

Watch the plugin terminal for the field-level log lines showing what was detected.
