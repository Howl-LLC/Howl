// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
// scripts/check-schema-compat.ts
// CI compat gate. Fails the build (or warns when COMPAT_BREAK_APPROVED=true)
// on any of these violations:
// 1. .strict() reintroduced on socket schemas (signedVoiceJoinBlob and
//    stageHostBlob — the nested signed blobs whose signatures cover the exact
//    field set — are the sole allowlisted exceptions).
// 2. shared/protocol.ts and backend/src/protocol.ts drifted below their
//    AUTO-SYNCED headers.
// 3. A newly-added Prisma migration contains destructive changes
//    (DROP COLUMN, ALTER COLUMN ... TYPE, RENAME COLUMN, DROP TABLE).
//    The git diff used for this scan now FAILS LOUD when origin/main isn't
//    available (previously a silent skip on shallow clones could let
//    destructive SQL slip through).
// 4. Schema field shape regression on backend/src/socketSchemas.ts and
//    backend/src/schemas.ts vs origin/main: non-optional field added,
//    field type changed, field removed, schema removed.
// 5. Socket event handler removal in backend/src/socketHandlers/ vs
//    origin/main.
//
// Override: when the workflow detects the `compat-break-approved` PR label,
// it sets COMPAT_BREAK_APPROVED=true and we downgrade all errors to warnings.

import { execSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Schema field extraction (regex-based, tolerant)

export interface FieldShape {
  type: string;
  optional: boolean;
}

/**
 * Extract every `export const <name> = z.object({ ... })` block and return
 * the field shape map for each. Tolerant: skips on parse failure rather than
 * throwing, but the diff layer treats unknown shapes as "schema removed."
 */
export function extractSchemaFields(content: string): Map<string, Map<string, FieldShape>> {
  const out = new Map<string, Map<string, FieldShape>>();
  // Find all `export const <name> = z.object({` start points.
  const headerRe = /export\s+const\s+(\w+)\s*=\s*z\.object\(\s*\{/g;
  let header: RegExpExecArray | null;
  while ((header = headerRe.exec(content)) !== null) {
    const schemaName = header[1];
    const objStart = header.index + header[0].length; // position right after the '{'
    // Walk forward, tracking brace depth, to find the matching '}'.
    let depth = 1;
    let i = objStart;
    while (i < content.length && depth > 0) {
      const ch = content[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
      if (depth === 0) break;
    }
    if (depth !== 0) continue; // unbalanced — skip
    const body = content.slice(objStart, i - 1);
    const fields = parseSchemaBody(body);
    out.set(schemaName, fields);
  }
  return out;
}

function parseSchemaBody(body: string): Map<string, FieldShape> {
  const fields = new Map<string, FieldShape>();
  // Walk top-level entries only — descend into nested braces but record the
  // field name + its top-level z.<type>(...) call.
  let i = 0;
  while (i < body.length) {
    // Skip whitespace
    while (i < body.length && /\s/.test(body[i])) i++;
    // Comment line
    if (body[i] === '/' && body[i + 1] === '/') {
      while (i < body.length && body[i] !== '\n') i++;
      continue;
    }
    if (i >= body.length) break;
    // Field name: identifier or quoted
    const nameMatch = /^[A-Za-z_$][\w$]*/.exec(body.slice(i));
    if (!nameMatch) { i++; continue; }
    const fieldName = nameMatch[0];
    i += nameMatch[0].length;
    // Skip optional `?` and the colon
    while (i < body.length && /\s/.test(body[i])) i++;
    if (body[i] === '?') i++;
    while (i < body.length && /\s/.test(body[i])) i++;
    if (body[i] !== ':') {
      // Not a field declaration — skip to next comma at depth 0
      i = skipToNextTopLevelComma(body, i);
      continue;
    }
    i++; // consume ':'
    while (i < body.length && /\s/.test(body[i])) i++;
    // Capture value start
    const valueStart = i;
    // Walk to top-level comma (or end of body), respecting parens/braces/brackets
    let parens = 0, braces = 0, brackets = 0;
    let valueEnd = valueStart;
    while (valueEnd < body.length) {
      const c = body[valueEnd];
      if (c === '(') parens++;
      else if (c === ')') parens--;
      else if (c === '{') braces++;
      else if (c === '}') braces--;
      else if (c === '[') brackets++;
      else if (c === ']') brackets--;
      else if (c === ',' && parens === 0 && braces === 0 && brackets === 0) break;
      valueEnd++;
    }
    const value = body.slice(valueStart, valueEnd);
    const optional = /\.optional\s*\(\s*\)/.test(value);
    // Type: `z.<typeName>` (allow `z.coerce.number`, `z.array`, etc).
    const typeMatch = /^(z\.\w+)/.exec(value.trim());
    const type = typeMatch ? typeMatch[1] : 'unknown';
    fields.set(fieldName, { type, optional });
    i = valueEnd + 1; // consume comma
  }
  return fields;
}

function skipToNextTopLevelComma(s: string, from: number): number {
  let i = from;
  let parens = 0, braces = 0, brackets = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '(') parens++;
    else if (c === ')') parens--;
    else if (c === '{') braces++;
    else if (c === '}') braces--;
    else if (c === '[') brackets++;
    else if (c === ']') brackets--;
    else if (c === ',' && parens === 0 && braces === 0 && brackets === 0) return i + 1;
    i++;
  }
  return i;
}

// Socket event extraction

export function extractSocketEvents(content: string): Set<string> {
  const out = new Set<string>();
  const re = /socket\.on\(\s*['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    out.add(match[1]);
  }
  return out;
}

// Schema field diff

export function diffSchemaFields(
  oldSchemas: Map<string, Map<string, FieldShape>>,
  newSchemas: Map<string, Map<string, FieldShape>>,
  label: string,
): string[] {
  const violations: string[] = [];
  for (const [schemaName, oldFields] of oldSchemas) {
    const newFields = newSchemas.get(schemaName);
    if (!newFields) {
      violations.push(
        `${label}: schema '${schemaName}' was removed. Schema/event removals require a 60-day deprecation window. See PROTOCOL_CHANGES.md.`,
      );
      continue;
    }
    // Removed fields
    for (const [fieldName, oldShape] of oldFields) {
      const newShape = newFields.get(fieldName);
      if (!newShape) {
        violations.push(
          `${label}: ${schemaName}.${fieldName} was removed. Field removals require a 60-day deprecation window before .removal. See PROTOCOL_CHANGES.md.`,
        );
        continue;
      }
      if (oldShape.type !== newShape.type) {
        violations.push(
          `${label}: ${schemaName}.${fieldName} type changed from ${oldShape.type} to ${newShape.type}. Type changes are compat-breaking. See PROTOCOL_CHANGES.md.`,
        );
      }
    }
  }
  // Added fields
  for (const [schemaName, newFields] of newSchemas) {
    const oldFields = oldSchemas.get(schemaName);
    if (!oldFields) continue; // entirely new schema is fine
    for (const [fieldName, newShape] of newFields) {
      if (!oldFields.has(fieldName) && !newShape.optional) {
        violations.push(
          `${label}: ${schemaName}.${fieldName} was added without .optional(). New fields on existing payloads must be optional. See PROTOCOL_CHANGES.md.`,
        );
      }
    }
  }
  return violations;
}

// Main entry

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const COMPAT_BREAK_APPROVED = process.env.COMPAT_BREAK_APPROVED === 'true';

const errors: string[] = [];

function report(msg: string): void {
  errors.push(msg);
}

function readFromMain(repoRelPath: string): string | null {
  try {
    return execSync(`git show origin/main:${repoRelPath}`, {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
}

function gitDiffWorks(): boolean {
  try {
    execSync('git rev-parse origin/main', { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function main(): void {
  // 1. .strict() on socket schemas
  const SOCKET_SCHEMAS = resolve(ROOT, 'backend/src/socketSchemas.ts');
  if (existsSync(SOCKET_SCHEMAS)) {
    const schemaText = readFileSync(SOCKET_SCHEMAS, 'utf8');
    const schemaLines = schemaText.split('\n');
    const allowedStrictLineNumbers = new Set<number>();
    for (let i = 0; i < schemaLines.length; i++) {
      if (/(?:signedVoiceJoinBlob|stageHostBlob)\s*=\s*z\.object\(/.test(schemaLines[i])) {
        for (let j = i; j < Math.min(schemaLines.length, i + 20); j++) {
          if (/\.strict\(\)/.test(schemaLines[j])) {
            allowedStrictLineNumbers.add(j + 1);
            break;
          }
        }
      }
    }
    for (let i = 0; i < schemaLines.length; i++) {
      const lineNo = i + 1;
      if (/^\s*\/\//.test(schemaLines[i])) continue;
      if (/\.strict\(\)/.test(schemaLines[i]) && !allowedStrictLineNumbers.has(lineNo)) {
        report(
          `backend/src/socketSchemas.ts:${lineNo} — .strict() is disallowed on socket payloads (use .passthrough()). Override: compat-break-approved PR label + protocolVersion bump.`,
        );
      }
    }
  }

  // 2. protocol.ts byte-sync
  const SHARED_PROTO = resolve(ROOT, 'shared/protocol.ts');
  const BACKEND_PROTO = resolve(ROOT, 'backend/src/protocol.ts');
  if (existsSync(SHARED_PROTO) && existsSync(BACKEND_PROTO)) {
    const sharedText = readFileSync(SHARED_PROTO, 'utf8');
    const backendText = readFileSync(BACKEND_PROTO, 'utf8');
    const stripHeader = (s: string) =>
      s.split('\n').filter(line => !line.startsWith('// AUTO-SYNCED:')).join('\n');
    if (stripHeader(sharedText) !== stripHeader(backendText)) {
      report(
        'shared/protocol.ts and backend/src/protocol.ts have drifted below their AUTO-SYNCED headers. Update both files in the same PR to keep them byte-identical.',
      );
    }
  }

  // 3. Destructive migration scan
  // Failure mode: if `git diff` against origin/main fails (shallow clone, no
  // remote), FAIL LOUD instead of silently skipping. The workflow now uses
  // fetch-depth: 0 so this is the green path in CI; failure here means the
  // operator needs to fetch full history.
  const diffWorks = gitDiffWorks();
  if (!diffWorks) {
    report(
      'check-schema-compat: cannot reach origin/main. The migration + schema-shape diff scans cannot run on a shallow clone. ' +
      'Set actions/checkout fetch-depth: 0 in the CI workflow, or run `git fetch --unshallow origin main` locally.',
    );
  } else {
    try {
      const newMigrations = execSync(
        'git diff --name-only --diff-filter=AM origin/main...HEAD -- backend/prisma/migrations/',
        { cwd: ROOT, encoding: 'utf8' },
      ).trim().split('\n').filter(Boolean);

      for (const migration of newMigrations) {
        if (!migration.endsWith('.sql')) continue;
        const migrationPath = join(ROOT, migration);
        if (!existsSync(migrationPath)) continue;
        const content = readFileSync(migrationPath, 'utf8');
        const destructive = [
          { re: /DROP COLUMN/i, desc: 'DROP COLUMN' },
          { re: /ALTER COLUMN \S+ TYPE/i, desc: 'ALTER COLUMN ... TYPE' },
          { re: /RENAME COLUMN/i, desc: 'RENAME COLUMN' },
          { re: /DROP TABLE/i, desc: 'DROP TABLE' },
        ];
        for (const { re, desc } of destructive) {
          if (re.test(content)) {
            report(
              `${migration} contains a destructive change (${desc}). Requires the compat-break-approved PR label + a two-phase deploy plan in the PR description.`,
            );
            break;
          }
        }
      }
    } catch (err) {
      report(
        `check-schema-compat: migration diff against origin/main failed. ${(err as Error).message}`,
      );
    }
  }

  // 4. Schema field-shape diff (socket + REST)
  if (diffWorks) {
    for (const target of ['backend/src/socketSchemas.ts', 'backend/src/schemas.ts']) {
      const newPath = resolve(ROOT, target);
      if (!existsSync(newPath)) continue;
      const oldText = readFromMain(target);
      if (!oldText) continue; // file didn't exist on main — entirely new file is fine
      const newText = readFileSync(newPath, 'utf8');
      const oldSchemas = extractSchemaFields(oldText);
      const newSchemas = extractSchemaFields(newText);
      const violations = diffSchemaFields(oldSchemas, newSchemas, target);
      for (const v of violations) report(v);
    }
  }

  // 5. Socket event handler removal
  if (diffWorks) {
    const handlerDir = resolve(ROOT, 'backend/src/socketHandlers');
    if (existsSync(handlerDir)) {
      const oldEvents = new Set<string>();
      const newEvents = new Set<string>();
      const files = readdirSync(handlerDir).filter(f => f.endsWith('.ts'));
      for (const f of files) {
        const repoRel = `backend/src/socketHandlers/${f}`;
        const oldText = readFromMain(repoRel);
        if (oldText) for (const e of extractSocketEvents(oldText)) oldEvents.add(e);
        const newText = readFileSync(resolve(ROOT, repoRel), 'utf8');
        for (const e of extractSocketEvents(newText)) newEvents.add(e);
      }
      // Also need to scan files that may have been removed entirely
      // (file existed on main but not on HEAD).
      try {
        const removedFiles = execSync(
          'git diff --name-only --diff-filter=D origin/main...HEAD -- backend/src/socketHandlers/',
          { cwd: ROOT, encoding: 'utf8' },
        ).trim().split('\n').filter(Boolean);
        for (const f of removedFiles) {
          const oldText = readFromMain(f);
          if (oldText) for (const e of extractSocketEvents(oldText)) oldEvents.add(e);
        }
      } catch { /* best-effort */ }

      for (const event of oldEvents) {
        if (!newEvents.has(event)) {
          report(
            `backend/src/socketHandlers: socket.on('${event}') was removed. Event handler removals require a 60-day deprecation window. Override: compat-break-approved PR label.`,
          );
        }
      }
    }
  }

  // Output
  if (COMPAT_BREAK_APPROVED) {
    console.log('compat-break-approved override is ACTIVE.');
    if (errors.length > 0) {
      console.log('The following violations were waived:\n');
      for (const e of errors) console.log('  - [WARN] ' + e);
      console.log('\nSee docs/PROTOCOL_CHANGES.md for guidance.');
    } else {
      console.log('No violations detected; the label is harmlessly set on this PR.');
    }
    process.exit(0);
  }
  if (errors.length > 0) {
    console.error('Schema compat check FAILED:\n');
    for (const e of errors) console.error('  - ' + e);
    console.error('\nSee docs/PROTOCOL_CHANGES.md for guidance.');
    process.exit(1);
  }
  console.log('Schema compat check passed.');
}

// Only run main() when invoked directly, not when imported by tests.
const isDirectInvocation = (() => {
  try {
    const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
    const thisPath = fileURLToPath(import.meta.url);
    return invokedPath === thisPath;
  } catch {
    return false;
  }
})();

if (isDirectInvocation) {
  main();
}
