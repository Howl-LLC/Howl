// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { APIClient } from './core';
import type { InstanceConfig } from '../../shared/instanceConfig';

declare module './core' {
  interface APIClient {
    getInstanceConfig(): Promise<InstanceConfig>;
  }
}

APIClient.prototype.getInstanceConfig = async function (this: APIClient) {
  return this.request<InstanceConfig>('/public/config');
};
