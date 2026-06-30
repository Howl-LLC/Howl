# cdn-signer

A Cloudflare Worker that fronts `cdn.howlpro.com` and validates HMAC-signed URLs before serving objects from your R2 uploads bucket (configured via wrangler.toml). The backend signs each URL with `HMAC-SHA256(secret, "${key}:${exp}")` and a 5-min expiry; this Worker re-computes the signature at the edge and rejects mismatched, expired, or unsigned requests. Valid responses are cached in the Cloudflare edge cache for the remainder of the URL's TTL.

## Deploy

```bash
npm install
npx wrangler login

# Paste the SAME value the backend uses as CDN_SIGNING_SECRET:
npx wrangler secret put HMAC_SIGNING_SECRET

npx wrangler deploy
```

## Fail-closed

Every request must carry a valid `sig`/`exp` pair; there is no unsigned or permissive mode. Any request without a valid signature returns 403.

## Secret rotation

```bash
npx wrangler secret put HMAC_SIGNING_SECRET
```

Update the backend's `CDN_SIGNING_SECRET` env var at the same time. There will be a short window where in-flight signed URLs issued under the old secret return 403 `bad_signature`; because URLs expire within 5 min this is self-healing. Coordinate rotation during a low-traffic window if possible.

## Local test

```bash
npm install
npx wrangler dev
```

In another terminal, craft a signed URL and hit the local Worker. Example using the same secret you set locally (replace `SECRET` and `KEY`):

```bash
SECRET='dev-secret'
KEY='avatars/abc123.png'
EXP=$(( $(date +%s) + 1800 ))
MSG="${KEY}:${EXP}"
SIG=$(printf '%s' "$MSG" | openssl dgst -sha256 -hmac "$SECRET" -binary | base64 | tr '+/' '-_' | tr -d '=')

# Valid (will 403 not_found unless the object exists in R2):
curl -i "http://127.0.0.1:8787/${KEY}?exp=${EXP}&sig=${SIG}"

# Expired:
curl -i "http://127.0.0.1:8787/${KEY}?exp=1&sig=${SIG}"

# Bad signature:
curl -i "http://127.0.0.1:8787/${KEY}?exp=${EXP}&sig=deadbeef"

# Missing params:
curl -i "http://127.0.0.1:8787/${KEY}"
```

Errors are returned as JSON: `{"error": "missing_params" | "expired" | "bad_signature" | "not_found" | "internal_error"}`.

## Observability

```bash
npx wrangler tail
```

Uncaught HMAC or R2 errors are logged with `console.log` (visible in `wrangler tail`). Validation rejections are not logged — they're expected behavior.
