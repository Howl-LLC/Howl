// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Zod validation middleware for Express routes.
 *
 * Usage:
 *   import { validate } from '../middleware/validate.js';
 *   import { z } from 'zod';
 *
 *   const schema = z.object({ body: z.object({ name: z.string().min(1) }) });
 *   router.post('/foo', validate(schema), handler);
 *
 * Validates req.body, req.query, and req.params against the schema.
 * On failure, returns 400 with structured field-level errors.
 */

import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';

export function validate(schema: z.ZodType<any>) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse({
      body: req.body,
      query: req.query,
      params: req.params,
    });

    if (!result.success) {
      const INTERNAL_PREFIXES = new Set(['body', 'query', 'params']);
      const fields: Record<string, string> = {};
      for (const issue of result.error.issues) {
        const segments = issue.path;
        const cleaned = segments.length > 1 && INTERNAL_PREFIXES.has(String(segments[0]))
          ? segments.slice(1)
          : segments;
        const path = cleaned.join('.') || '_';
        // Keep only the first error message per field for clean UX
        if (!fields[path]) fields[path] = issue.message;
      }
      return res.status(400).json({ error: 'Validation failed', fields });
    }

    const data = result.data as Record<string, unknown>;
    const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
    const stripProto = (obj: Record<string, unknown>): Record<string, unknown> => {
      const clean: Record<string, unknown> = {};
      for (const k of Object.keys(obj)) {
        if (DANGEROUS_KEYS.has(k)) continue;
        const v = obj[k];
        if (Array.isArray(v)) {
          clean[k] = v.map(function recurse(item: unknown): unknown {
            if (Array.isArray(item)) return item.map(recurse);
            if (item !== null && typeof item === 'object')
              return stripProto(item as Record<string, unknown>);
            return item;
          });
        } else if (v !== null && typeof v === 'object') {
          clean[k] = stripProto(v as Record<string, unknown>);
        } else {
          clean[k] = v;
        }
      }
      return clean;
    };
    if (data.body !== undefined) req.body = typeof data.body === 'object' && data.body !== null ? stripProto(data.body as Record<string, unknown>) : data.body;
    if (data.query !== undefined) {
      const parsed = stripProto(data.query as Record<string, unknown>);
      // Express 5 makes `req.query` a getter that returns a freshly-parsed object
      // on each access, so mutations don't persist across reads. Replace the
      // getter with a plain property holding our validated/coerced/defaulted
      // values. This is what downstream handlers (and the schema's `.default()`
      // values) need to be visible.
      Object.defineProperty(req, 'query', { value: parsed, writable: true, configurable: true, enumerable: true });
    }
    if (data.params !== undefined) Object.assign(req.params, stripProto(data.params as Record<string, unknown>));

    next();
  };
}
