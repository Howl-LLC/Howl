// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Tests for the apply-to-join backend flow.
 *
 * Covers:
 *  - PATCH /questions to configure the question schema
 *  - POST / to submit an application (incl. duplicate, banned, captcha bypass)
 *  - DELETE /me to withdraw a pending application
 *  - GET / to list applications (reviewer + perm gate)
 *  - PATCH /:appId to accept/reject (incl. ServerMember creation on accept)
 *  - invite-join short-circuit when joinMethod === 'apply_to_join'
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { prisma } from '../src/db.js';
import { createTestUser, createTestServer, createTestChannel, authHeader, cleanupTestData, type TestUser } from './helpers.js';

describe('apply-to-join backend flow', () => {
  let owner: TestUser;
  let applicant: TestUser;
  let stranger: TestUser;
  let serverId: string;

  beforeAll(async () => {
    owner = await createTestUser();
    applicant = await createTestUser();
    stranger = await createTestUser();

    const server = await createTestServer(owner.id);
    serverId = server.id;

    // Server must have a 'Member' role for accept-flow to assign correctly.
    await prisma.serverRole.create({
      data: {
        serverId,
        name: 'Member',
        position: 1,
        isEveryone: false,
        permissions: { sendMessages: true, viewChannels: true, readMessageHistory: true } as any,
      },
    });

    // Mark the server as apply_to_join.
    await prisma.serverSettings.upsert({
      where: { serverId },
      create: { serverId, joinMethod: 'apply_to_join' },
      update: { joinMethod: 'apply_to_join' },
    });
  });

  afterAll(cleanupTestData);

  it('PATCH /questions — owner configures question schema', async () => {
    const res = await request(app)
      .patch(`/api/v1/servers/${serverId}/applications/questions`)
      .set('Authorization', authHeader(owner.token))
      .send({
        questions: [
          { id: 'q1', prompt: 'Why join?', type: 'short_text', required: true, maxLength: 200 },
          { id: 'q2', prompt: 'Pick one', type: 'multiple_choice', required: false, maxLength: 100, choices: ['A', 'B'] },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.questions).toHaveLength(2);
  });

  it('PATCH /questions — non-owner without manageServer is rejected', async () => {
    const res = await request(app)
      .patch(`/api/v1/servers/${serverId}/applications/questions`)
      .set('Authorization', authHeader(stranger.token))
      .send({ questions: [] });
    expect(res.status).toBe(403);
  });

  it('PATCH /questions — multi-choice without choices is rejected', async () => {
    const res = await request(app)
      .patch(`/api/v1/servers/${serverId}/applications/questions`)
      .set('Authorization', authHeader(owner.token))
      .send({
        questions: [
          { id: 'qbad', prompt: 'pick', type: 'multiple_choice', required: true, maxLength: 100 },
        ],
      });
    expect(res.status).toBe(400);
  });

  it('GET /questions — authenticated read returns the configured questions', async () => {
    const res = await request(app)
      .get(`/api/v1/servers/${serverId}/applications/questions`)
      .set('Authorization', authHeader(applicant.token));
    expect(res.status).toBe(200);
    expect(res.body.joinMethod).toBe('apply_to_join');
    expect(res.body.questions).toHaveLength(2);
  });

  it('POST / — applicant submits application', async () => {
    const res = await request(app)
      .post(`/api/v1/servers/${serverId}/applications`)
      .set('Authorization', authHeader(applicant.token))
      .send({
        answers: [
          { questionId: 'q1', answer: 'I want to learn.' },
          { questionId: 'q2', answer: 'A' },
        ],
        captchaToken: 'unused-in-test',
      });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');
  });

  it('POST / — duplicate pending application is rejected with 409', async () => {
    const res = await request(app)
      .post(`/api/v1/servers/${serverId}/applications`)
      .set('Authorization', authHeader(applicant.token))
      .send({
        answers: [
          { questionId: 'q1', answer: 'second try' },
        ],
        captchaToken: 'unused-in-test',
      });
    expect(res.status).toBe(409);
  });

  it('POST / — banned user is rejected with 403', async () => {
    await prisma.serverBan.create({
      data: { serverId, userId: stranger.id, bannedById: owner.id, reason: 'test' },
    });
    const res = await request(app)
      .post(`/api/v1/servers/${serverId}/applications`)
      .set('Authorization', authHeader(stranger.token))
      .send({ answers: [{ questionId: 'q1', answer: 'plz' }], captchaToken: 'x' });
    expect(res.status).toBe(403);
    // Cleanup so later tests can use stranger as a non-banned user if needed.
    await prisma.serverBan.delete({ where: { serverId_userId: { serverId, userId: stranger.id } } });
  });

  it('GET / — owner lists pending applications', async () => {
    const res = await request(app)
      .get(`/api/v1/servers/${serverId}/applications?status=pending`)
      .set('Authorization', authHeader(owner.token));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.applications)).toBe(true);
    expect(res.body.applications.length).toBeGreaterThanOrEqual(1);
    expect(res.body.applications[0].applicant.id).toBe(applicant.id);
  });

  it('GET / — non-reviewer (manageServer/kickMembers required) is rejected', async () => {
    // stranger is not a member at all
    const res = await request(app)
      .get(`/api/v1/servers/${serverId}/applications`)
      .set('Authorization', authHeader(stranger.token));
    expect(res.status).toBe(403);
  });

  it('DELETE /me — applicant withdraws their pending application', async () => {
    const res = await request(app)
      .delete(`/api/v1/servers/${serverId}/applications/me`)
      .set('Authorization', authHeader(applicant.token));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('withdrawn');
  });

  it('POST / again after withdraw, then PATCH /:appId accept creates a ServerMember', async () => {
    // Re-apply (allowed because the previous one is withdrawn, not pending).
    const submit = await request(app)
      .post(`/api/v1/servers/${serverId}/applications`)
      .set('Authorization', authHeader(applicant.token))
      .send({ answers: [{ questionId: 'q1', answer: 'second go' }], captchaToken: 'x' });
    expect(submit.status).toBe(201);
    const appId = submit.body.id as string;

    const accept = await request(app)
      .patch(`/api/v1/servers/${serverId}/applications/${appId}`)
      .set('Authorization', authHeader(owner.token))
      .send({ decision: 'accept', note: 'welcome' });
    expect(accept.status).toBe(200);
    expect(accept.body.status).toBe('accepted');

    // Confirm the applicant is now a member of the server.
    const member = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: applicant.id, serverId } },
    });
    expect(member).not.toBeNull();

    // A notification row was created.
    const notif = await prisma.notification.findFirst({
      where: { userId: applicant.id, type: 'application_decision' },
    });
    expect(notif).not.toBeNull();
  });

  it('PATCH /:appId — re-decide on already-decided application is 409', async () => {
    // Find the decided application from the previous test.
    const app1 = await prisma.serverApplication.findFirst({
      where: { serverId, userId: applicant.id, status: 'accepted' },
      select: { id: true },
    });
    expect(app1).not.toBeNull();

    const res = await request(app)
      .patch(`/api/v1/servers/${serverId}/applications/${app1!.id}`)
      .set('Authorization', authHeader(owner.token))
      .send({ decision: 'reject' });
    expect(res.status).toBe(409);
  });

  it('PATCH /:appId — reviewer without permission is rejected', async () => {
    // Submit a fresh pending application by the stranger.
    const submit = await request(app)
      .post(`/api/v1/servers/${serverId}/applications`)
      .set('Authorization', authHeader(stranger.token))
      .send({ answers: [{ questionId: 'q1', answer: 'me too' }], captchaToken: 'x' });
    expect(submit.status).toBe(201);
    const appId = submit.body.id as string;

    // applicant (now a regular member, no kickMembers) tries to decide.
    const res = await request(app)
      .patch(`/api/v1/servers/${serverId}/applications/${appId}`)
      .set('Authorization', authHeader(applicant.token))
      .send({ decision: 'reject' });
    expect(res.status).toBe(403);
  });

  it('invite /join — short-circuits when joinMethod is apply_to_join', async () => {
    // Create an invite for the apply-to-join server.
    const invite = await prisma.invite.create({
      data: {
        code: `APPLY${Date.now().toString().slice(-5)}`,
        serverId,
        createdById: owner.id,
        useCount: 0,
      },
    });

    // Create a fresh user who is not yet a member.
    const fresh = await createTestUser();
    const res = await request(app)
      .post('/api/v1/invites/join')
      .set('Authorization', authHeader(fresh.token))
      .send({ code: invite.code });

    expect(res.status).toBe(202);
    expect(res.body.status).toBe('application_required');
    expect(res.body.serverId).toBe(serverId);
  });
});

describe('Application accept — auto-role assignment + welcome message', () => {
  let owner: TestUser;
  let applicant: TestUser;
  let serverId: string;
  let welcomeChannelId: string;
  let autoRoleId: string;

  beforeEach(async () => {
    await cleanupTestData();
    owner = await createTestUser();
    applicant = await createTestUser();
    const server = await createTestServer(owner.id);
    serverId = server.id;
    // Second text channel, configured as the welcome channel, so the
    // welcome-lands-in-welcomeChannelId assertion is non-vacuous (pre-wiring
    // the inline accept code posts to the FIRST text channel, not this one).
    const welcome = await createTestChannel(serverId, 'welcome');
    welcomeChannelId = welcome.id;

    // 'Member' role (low position, not hoisted) — the accept path seeds it.
    await prisma.serverRole.create({
      data: {
        serverId,
        name: 'Member',
        position: 1,
        isEveryone: false,
        displaySeparately: false,
        permissions: { sendMessages: true, viewChannels: true } as any,
      },
    });

    // Auto-role: hoisted so it wins the display-role pick over 'Member'.
    const autoRole = await prisma.serverRole.create({
      data: {
        serverId,
        name: 'Newcomer',
        position: 2,
        isEveryone: false,
        displaySeparately: true,
        permissions: { sendMessages: true } as any,
      },
    });
    autoRoleId = autoRole.id;
    await prisma.serverAutoRole.create({ data: { serverId, roleId: autoRoleId } });

    await prisma.serverSettings.create({
      data: {
        serverId,
        joinMethod: 'apply_to_join',
        welcomeEnabled: true,
        welcomeMessage: 'Welcome {user} to {server}!',
        welcomeChannelId,
      },
    });
  });

  afterAll(cleanupTestData);

  it('accept grants the auto-role, hoists it as display role, and posts the welcome system message', async () => {
    // Applicant submits, owner accepts.
    const submit = await request(app)
      .post(`/api/v1/servers/${serverId}/applications`)
      .set('Authorization', authHeader(applicant.token))
      .send({ answers: [], captchaToken: 'x' });
    expect(submit.status).toBe(201);
    const appId = submit.body.id as string;

    const accept = await request(app)
      .patch(`/api/v1/servers/${serverId}/applications/${appId}`)
      .set('Authorization', authHeader(owner.token))
      .send({ decision: 'accept' });
    expect(accept.status).toBe(200);

    // (a) MemberRole row for the auto-role exists.
    const memberRoleRow = await prisma.memberRole.findUnique({
      where: { userId_serverId_roleId: { userId: applicant.id, serverId, roleId: autoRoleId } },
    });
    expect(memberRoleRow).not.toBeNull();

    // (b) ServerMember.roleId == the hoisted auto-role.
    const member = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: applicant.id, serverId } },
    });
    expect(member?.roleId).toBe(autoRoleId);

    // (c) system member_join message in the configured welcome channel.
    const sysMsg = await prisma.message.findFirst({
      where: { channelId: welcomeChannelId, type: 'system' },
    });
    expect(sysMsg).not.toBeNull();
    expect((sysMsg?.systemPayload as any)?.kind).toBe('member_join');
  });
});
