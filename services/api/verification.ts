// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { APIClient } from './core';

// Types

export type VerificationStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';

export interface VerificationRequestSummary {
  id: string;
  status: VerificationStatus;
  organizationName: string;
  websiteUrl: string;
  additionalNotes: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
  /** Cooldown end timestamp (ISO) when status === 'rejected'. Null otherwise. */
  cooldownUntil: string | null;
}

export interface VerificationStatusResponse {
  /** True for grandfathered admin-flipped servers — apply form should be hidden. */
  alreadyVerified: boolean;
  /** Most recent request (any status), or null if owner hasn't submitted any. */
  request: VerificationRequestSummary | null;
}

export interface SubmitVerificationRequestBody {
  organizationName: string;
  websiteUrl: string;
  additionalNotes?: string | null;
}

// Module augmentation

declare module './core' {
  interface APIClient {
    /** Owner-only. Returns the latest verification request and verified flag. */
    serverVerificationStatus(serverId: string): Promise<VerificationStatusResponse>;
    /** Owner-only. Submit a new application. 429 with retryAfter if in cooldown. */
    serverVerificationSubmit(
      serverId: string,
      body: SubmitVerificationRequestBody,
    ): Promise<VerificationRequestSummary>;
    /** Owner-only. Withdraw the pending request. 404 if none pending. */
    serverVerificationWithdraw(serverId: string): Promise<VerificationRequestSummary>;
  }
}

// Implementations

APIClient.prototype.serverVerificationStatus = async function (
  this: APIClient,
  serverId: string,
): Promise<VerificationStatusResponse> {
  return this.request<VerificationStatusResponse>(
    `/servers/${encodeURIComponent(serverId)}/verification`,
    { method: 'GET' },
  );
};

APIClient.prototype.serverVerificationSubmit = async function (
  this: APIClient,
  serverId: string,
  body: SubmitVerificationRequestBody,
): Promise<VerificationRequestSummary> {
  return this.request<VerificationRequestSummary>(
    `/servers/${encodeURIComponent(serverId)}/verification`,
    {
      method: 'POST',
      body: JSON.stringify({
        organizationName: body.organizationName,
        websiteUrl: body.websiteUrl,
        ...(body.additionalNotes ? { additionalNotes: body.additionalNotes } : {}),
      }),
    },
  );
};

APIClient.prototype.serverVerificationWithdraw = async function (
  this: APIClient,
  serverId: string,
): Promise<VerificationRequestSummary> {
  return this.request<VerificationRequestSummary>(
    `/servers/${encodeURIComponent(serverId)}/verification/me`,
    { method: 'DELETE' },
  );
};
