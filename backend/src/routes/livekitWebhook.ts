// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Router, type Request, type Response } from 'express';
import { WebhookReceiver } from 'livekit-server-sdk';
import { DisconnectReason } from '@livekit/protocol';
import { logger } from '../logger.js';
import { getAllRegions } from '../services/livekitRegions.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const log = logger.child({ module: 'livekit-webhook' });
const router = Router();

// Each LiveKit region (a self-hosted SFU) has its own API key/secret pair. The webhook
// is signed with the secret of the region that emitted it, so we try every
// configured region's WebhookReceiver and accept the first that verifies.
function getReceivers(): { regionId: string; receiver: WebhookReceiver }[] {
  return getAllRegions()
    .filter((r) => r.apiKey && r.apiSecret)
    .map((r) => ({ regionId: r.id, receiver: new WebhookReceiver(r.apiKey, r.apiSecret) }));
}

router.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const authHeader = req.get('Authorization') ?? req.get('authorize') ?? '';
    const bodyBuf = req.body as Buffer | undefined;
    if (!Buffer.isBuffer(bodyBuf) || bodyBuf.length === 0) {
      log.warn({ event: 'livekit-webhook-bad-body' }, 'webhook body missing or not a Buffer');
      return res.status(400).send('bad body');
    }
    const bodyStr = bodyBuf.toString('utf8');

    const receivers = getReceivers();
    if (receivers.length === 0) {
      log.error({ event: 'livekit-webhook-no-regions' }, 'no LiveKit regions credentialed; cannot verify');
      return res.status(503).send('no regions configured');
    }

    let evt = null;
    let usedRegion: string | null = null;
    let lastErr: unknown = null;
    for (const { regionId, receiver } of receivers) {
      try {
        evt = await receiver.receive(bodyStr, authHeader);
        usedRegion = regionId;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!evt) {
      log.warn(
        {
          event: 'livekit-webhook-bad-sig',
          err: lastErr instanceof Error ? lastErr.message : String(lastErr),
          authHeaderPresent: Boolean(authHeader),
          bodyLen: bodyStr.length,
        },
        'webhook signature verification failed for all regions'
      );
      return res.status(401).send('signature verification failed');
    }

    if (evt.event === 'participant_left' || evt.event === 'participant_connection_aborted') {
      const p = evt.participant;
      const reasonInt = p?.disconnectReason ?? DisconnectReason.UNKNOWN_REASON;
      const reasonName = DisconnectReason[reasonInt] ?? `UNKNOWN(${reasonInt})`;
      log.info(
        {
          event: 'livekit-participant-left',
          regionId: usedRegion,
          type: evt.event,
          room: evt.room?.name,
          identity: p?.identity,
          participantSid: p?.sid,
          disconnectReason: reasonName,
          disconnectReasonInt: reasonInt,
          joinedAt: p ? Number(p.joinedAt) : undefined,
          eventCreatedAt: evt.createdAt ? Number(evt.createdAt) : undefined,
        },
        'LiveKit participant left'
      );
    } else {
      log.info(
        {
          event: 'livekit-webhook',
          regionId: usedRegion,
          type: evt.event,
          room: evt.room?.name,
          identity: evt.participant?.identity,
        },
        'LiveKit webhook'
      );
    }

    res.status(200).send('ok');
  })
);

export default router;
