# Protocol payload fixtures

Each file is a known-good payload for a socket event as of the protocol
version in the directory name (`protocol-v1`). Tests assert every fixture
still parses cleanly under the current schema -- this is the regression
guard for additive-only evolution.

When a protocolVersion bump removes a field, copy this directory to
`protocol-vN/` (the new version) with the updated shape, and keep
`protocol-v1/` intact for the 60-day retirement window. Remove
`protocol-v1/` only after the next bump.
