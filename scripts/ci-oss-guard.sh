#!/usr/bin/env bash
# Lightweight publish guard for the public repository. Run from the repo root.
# Fails if an obvious secret or a developer's local path slips into the tracked
# tree. Comprehensive secret scanning runs separately via Gitleaks
# (see .github/workflows/security.yml).
set -uo pipefail
fail=0
SELF=':!scripts/ci-oss-guard.sh'

scan() { # $1 = label, $2 = PCRE pattern, rest = pathspecs
  local label="$1" pat="$2"; shift 2
  if git grep -anP "$pat" -- "$@" "$SELF"; then
    echo "  VIOLATION: $label"; fail=1
  fi
}

echo "== Obvious secrets =="
scan "possible live secret" \
  'sk_live_[0-9A-Za-z]|whsec_[0-9A-Za-z]{16}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----' \
  '*.ts' '*.tsx' '*.js' '*.mjs' '*.json' '*.yml' '*.yaml' '*.toml' '*.sh' ':!*.example' ':!*.example.*'

echo "== Local developer paths =="
scan "absolute home-directory path" \
  '/(Users|home)/[a-z][a-z0-9_.-]+' \
  '*.ts' '*.tsx' '*.js' '*.mjs' '*.json' '*.md' '*.yml' '*.yaml' '*.toml' '*.sh' '*.sql' '*.prisma' '*.html' '*.css' ':!package-lock.json'

[ "$fail" = 0 ] && echo "OSS GUARD: PASS" || echo "OSS GUARD: FAIL"
exit $fail
