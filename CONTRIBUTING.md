# Contributing to Howl

Thanks for your interest in contributing. This guide covers how to build, test,
and submit changes.

## Project layout

Howl is a single repository with three packages, each with its own package.json:

- Root: the React (Vite) frontend and the Electron desktop app.
- `backend/`: the Node.js + Express + Socket.IO + Prisma API server.
- `admin/`: the admin dashboard (React + Vite).

## Getting started

    npm install
    npm run dev            # frontend (Vite) on port 3000

    cd backend
    npm install
    npm run dev            # backend on port 5000

See `README.md` for prerequisites (Node.js, PostgreSQL, Redis, LiveKit) and
`docs/self-hosting.md` for a full local or self-host setup.

## Build, test, and lint

Before opening a pull request:

    # frontend (repo root)
    npm run lint
    npx tsc -p tsconfig.json --noEmit
    npm test

    # backend
    cd backend
    npm run build
    npm test

Backend tests require a running PostgreSQL instance and run against a dedicated
test database. They run sequentially.

## Pull request conventions

- Keep changes focused: one logical change per PR.
- Match the existing code style; the project uses ESLint and TypeScript.
- Add or update tests for behavior you change.
- Write clear commit messages.

## Protocol and schema changes (important)

Howl runs a realtime protocol over Socket.IO and a REST API consumed by clients
that may be older than the server. Schema evolution must be ADDITIVE and
backward compatible:

- Do not remove or rename existing Socket.IO event fields or REST payload fields
  that clients still send or read.
- Add new fields as optional; never make a previously optional field required in
  a way that breaks an older client.
- Do not apply strict or exact-shape validation to socket payloads.

See `docs/PROTOCOL_CHANGES.md` for the full checklist before changing any wire
format or E2EE crypto.

## Contributor License Agreement

Contributions are accepted under the Contributor License Agreement in `CLA.md`.
By opening a pull request you agree to its terms; a CLA check runs on your first
contribution. This lets Howl stay available under the AGPL while allowing the
project to also offer commercial terms.
