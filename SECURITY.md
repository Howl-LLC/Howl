# Security Policy

Security matters to Howl, especially because Howl is built around end-to-end
encryption for direct messages and calls.

## Reporting a vulnerability

Please report security issues privately. Do not open a public GitHub issue for a
suspected vulnerability.

- Email: support@howlpro.com (subject line "SECURITY")
- Include a description of the issue, steps to reproduce, the affected components
  or endpoints, and any proof-of-concept you can share.

We will acknowledge your report, investigate, and keep you updated on
remediation. Please give us a reasonable amount of time to address the issue
before any public disclosure.

## Scope

This policy covers the code in this repository: the web and desktop client, the
backend API and realtime server, and the admin dashboard. Vulnerabilities in
third-party dependencies should generally be reported upstream, though we
welcome a heads-up when they affect Howl directly.

## Encryption

Direct messages and group DMs are end-to-end encrypted with MLS (RFC 9420). For
users on the default Self recovery mode, the server relays ciphertext it cannot
read. See docs/howl-dm-encryption-spec.md for the design and the exact trust
boundary (including the opt-in Server recovery escrow path).
