/**
 * Integration tests — WhatsApp webhook route
 *
 * Tests GET /api/whatsapp/webhook (health) and POST /api/whatsapp/webhook
 * Twilio validation and the WhatsApp message handler are both mocked.
 */

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockMessagingResponseMessage = jest.fn();
const mockMessagingResponseToString = jest
  .fn()
  .mockReturnValue('<Response><Message>Test response</Message></Response>');

jest.mock('twilio', () => ({
  validateRequest: jest.fn().mockReturnValue(true),
  twiml: {
    MessagingResponse: jest.fn().mockImplementation(() => ({
      message: mockMessagingResponseMessage,
      toString: mockMessagingResponseToString,
    })),
  },
}));

jest.mock('../../../src/whatsapp/handler', () => ({
  handleWhatsAppMessage: jest
    .fn()
    .mockResolvedValue({ body: 'Hello from mock handler' }),
}));

// DB mock (needed because app imports middleware that uses db)
const mockDb = {
  session: { findUnique: jest.fn() },
  user: { findUnique: jest.fn() },
  position: { findMany: jest.fn() },
  yieldSnapshot: { findMany: jest.fn() },
  transaction: { count: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn() },
  protocolRate: { findMany: jest.fn() },
  agentLog: { findFirst: jest.fn() },
};

jest.mock('../../../src/db', () => ({
  __esModule: true,
  default: mockDb,
  db: mockDb,
}));

import request from 'supertest';
import { validateRequest } from 'twilio';
import { handleWhatsAppMessage } from '../../../src/whatsapp/handler';
import app from '../../../src/index';

const mockValidateRequest = validateRequest as jest.Mock;
const mockHandleMessage = handleWhatsAppMessage as jest.Mock;

// A minimal Twilio webhook payload
const TWILIO_PAYLOAD = {
  From: 'whatsapp:+15550001234',
  Body: 'balance',
  AccountSid: 'ACtest',
  MessageSid: 'SMtest',
};

describe('WhatsApp webhook routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockValidateRequest.mockReturnValue(true);
    mockHandleMessage.mockResolvedValue({ body: 'Hello from mock handler' });
    mockMessagingResponseToString.mockReturnValue(
      '<Response><Message>Hello from mock handler</Message></Response>',
    );
    process.env.TWILIO_AUTH_TOKEN = 'test-twilio-auth-token';
  });

  afterAll(() => {
    delete process.env.TWILIO_AUTH_TOKEN;
  });

  // ── GET /api/whatsapp/webhook ─────────────────────────────────────────────

  describe('GET /api/whatsapp/webhook', () => {
    it('returns 200 with a health-check message', async () => {
      const res = await request(app).get('/api/whatsapp/webhook');
      expect(res.status).toBe(200);
      expect(res.text).toContain('alive');
    });
  });

  // ── POST /api/whatsapp/webhook ────────────────────────────────────────────

  describe('POST /api/whatsapp/webhook', () => {
    it('returns 403 when x-twilio-signature header is absent', async () => {
      const res = await request(app)
        .post('/api/whatsapp/webhook')
        .send(TWILIO_PAYLOAD);
      expect(res.status).toBe(403);
    });

    it('returns 403 when TWILIO_AUTH_TOKEN is not set', async () => {
      delete process.env.TWILIO_AUTH_TOKEN;
      const res = await request(app)
        .post('/api/whatsapp/webhook')
        .set('x-twilio-signature', 'sig')
        .send(TWILIO_PAYLOAD);
      expect(res.status).toBe(403);
    });

    it('returns TwiML XML response for a valid request', async () => {
      const res = await request(app)
        .post('/api/whatsapp/webhook')
        .set('x-twilio-signature', 'valid-signature')
        .send(TWILIO_PAYLOAD);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/xml/);
      expect(res.text).toContain('<Response>');
    });

    it('calls handleWhatsAppMessage with From and Body from payload', async () => {
      await request(app)
        .post('/api/whatsapp/webhook')
        .set('x-twilio-signature', 'valid-signature')
        .send(TWILIO_PAYLOAD);
      expect(mockHandleMessage).toHaveBeenCalledWith(
        TWILIO_PAYLOAD.From,
        TWILIO_PAYLOAD.Body,
      );
    });

    it('includes the handler reply in the TwiML message', async () => {
      mockHandleMessage.mockResolvedValue({ body: 'Your balance is 42 USDC' });
      await request(app)
        .post('/api/whatsapp/webhook')
        .set('x-twilio-signature', 'valid-signature')
        .send(TWILIO_PAYLOAD);
      expect(mockMessagingResponseMessage).toHaveBeenCalledWith(
        'Your balance is 42 USDC',
      );
    });

    it('returns a TwiML error response when handler throws', async () => {
      mockHandleMessage.mockRejectedValue(new Error('handler crash'));
      const res = await request(app)
        .post('/api/whatsapp/webhook')
        .set('x-twilio-signature', 'valid-signature')
        .send(TWILIO_PAYLOAD);
      // Route catches the error and still returns valid TwiML
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/xml/);
    });

    it('handles empty Body gracefully', async () => {
      const res = await request(app)
        .post('/api/whatsapp/webhook')
        .set('x-twilio-signature', 'valid-signature')
        .send({ ...TWILIO_PAYLOAD, Body: '' });
      expect(res.status).toBe(200);
      expect(mockHandleMessage).toHaveBeenCalledWith(TWILIO_PAYLOAD.From, '');
    });

    it('rejects invalid Twilio signature regardless of NODE_ENV', async () => {
      mockValidateRequest.mockReturnValue(false);
      const res = await request(app)
        .post('/api/whatsapp/webhook')
        .set('x-twilio-signature', 'bad-sig')
        .send(TWILIO_PAYLOAD);
      expect(res.status).toBe(403);
    });
  });
});
