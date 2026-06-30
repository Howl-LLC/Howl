// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import type { Request, Response, NextFunction } from 'express';
import { parseProtocolContext, isEnforceVersionGate, isHandshakeInsideWindow } from '../protocol.js';
import { logger } from '../logger.js';

// Paths that MUST never receive a 426 even when the version gate is enforced.
// A stale-build client must always be able to refresh its access token to
// recover; if refresh is gated, the user is bricked. Add new entries here
// only when the path is genuinely unrecoverable under enforcement.
const VERSION_GATE_EXEMPT_PATHS = new Set<string>([
  '/auth/refresh',
]);

function isExemptFromVersionGate(req: Request): boolean {
  if (VERSION_GATE_EXEMPT_PATHS.has(req.path)) return true;
  // Some routers strip the prefix; also check originalUrl ending so the
  // middleware works under either mount style.
  for (const exempt of VERSION_GATE_EXEMPT_PATHS) {
    if (req.originalUrl.endsWith(exempt)) return true;
  }
  return false;
}

declare global {
  namespace Express {
    interface Request {
      protocolContext?: {
        buildDate: string | null;
        protocolVersion: number | null;
        capabilities: string[];
      };
    }
  }
}

export function attachProtocolContextHttp(req: Request, _res: Response, next: NextFunction): void {
  const rawBuildDate = req.header('X-Client-Build-Date');
  const rawProtoVer = req.header('X-Protocol-Version');
  const rawCaps = req.header('X-Client-Capabilities');

  req.protocolContext = parseProtocolContext({
    buildDate: rawBuildDate,
    protocolVersion: rawProtoVer,
    capabilities: rawCaps ? rawCaps.split(',').map(s => s.trim()).filter(Boolean) : [],
  });
  next();
}

/**
 * REST enforcement gate: responds 426 Upgrade Required when the client is
 * outside the compat window. Only active when ENFORCE_VERSION_GATE=true.
 * Mount AFTER attachProtocolContextHttp on scoped mid-call routes.
 */
export function enforceVersionGateHttp(req: Request, res: Response, next: NextFunction): void {
  if (!isEnforceVersionGate()) return next();
  if (!req.protocolContext) return next(); // belt-and-suspenders; attach should run first
  const check = isHandshakeInsideWindow(
    req.protocolContext.buildDate,
    req.protocolContext.protocolVersion,
  );
  if (!check.ok) {
    if (isExemptFromVersionGate(req)) {
      // Telemetry: track which stale clients are hitting the exempt path so
      // we have visibility on stragglers without bricking them.
      logger.warn(
        { event: 'version-gate-skipped-refresh', path: req.path, reason: check.reason },
        'version gate skipped on exempt path',
      );
      return next();
    }
    res.status(426).json({ reason: check.reason, autoUpdateHint: true });
    return;
  }
  next();
}
