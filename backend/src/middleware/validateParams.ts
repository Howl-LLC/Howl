// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Request, Response, NextFunction } from 'express';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateUuidParams(...names: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    for (const name of names) {
      const val = req.params[name] as string | undefined;
      if (val !== undefined && !UUID_REGEX.test(val)) {
        return res.status(400).json({ error: `Invalid ${name} format` });
      }
    }
    next();
  };
}
