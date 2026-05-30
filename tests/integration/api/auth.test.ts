/**
 * Integration tests — Auth API routes
 *
 * Tests POST /api/auth/challenge, /api/auth/verify, /api/auth/logout
 * Stellar signature verification and Prisma are mocked.
 */

// ─── Mocks (must be declared before imports) ──────────────────────────────────

// Mock JwtAdapter so tests don't need real JWT tokens
jest.mock('../../../src/config/jwt-adapter', () => ({
  JwtAdapter: {
    generateToken: jest.fn().mockResolvedValue('auth-test-token-valid'),
    validateToken: jest.fn().mockResolvedValue({ id: '550e8400-e29b-41d4-a716-446655440004' }),
  },
}));

// Mock stellar-verification so signature checks are fully controlled
jest.mock('../../../src/utils/stellar/stellar-verification', () => ({
  stellarVerification: {
    verifyStellarSignature: jest.fn().mockReturnValue(true),
    resolveNetwork: jest.fn().mockReturnValue('TESTNET'),
  },
}));

// Mock Stellar SDK so Keypair.fromPublicKey never throws in challenge
jest.mock('@stellar/stellar-sdk', () => ({
  Keypair: {
    fromPublicKey: jest.fn(), // succeeds by default (no throw)
    fromSecret: jest.fn().mockReturnValue({ publicKey: () => 'GMOCK' }),
    random: jest.fn().mockReturnValue({
      publicKey: () => 'GMOCKPUB',
      secret: () => 'SMOCKSEC',
    }),
  },
  Networks: {
    PUBLIC: 'Public Global Stellar Network ; September 2015',
    TESTNET: 'Test SDF Network ; September 2015',
  },
}));

const mockDb = {
  session: { findUnique: jest.fn(), create: jest.fn(), deleteMany: jest.fn(), delete: jest.fn() },
  user: { findUnique: jest.fn(), create: jest.fn() },
  authNonce: { findUnique: jest.fn(), upsert: jest.fn(), delete: jest.fn() },
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
import app from '../../../src/index';

const PUB_KEY = 'GABC_VALID_PUBLIC_KEY_FOR_AUTH_TESTS';
const USER_ID = '550e8400-e29b-41d4-a716-446655440004';
const TOKEN = 'auth-test-token-valid';

// A valid session record (used by logout + auth middleware)
const SESSION = {
  id: 'session-auth',
  userId: USER_ID,
  walletAddress: PUB_KEY,
  network: 'TESTNET',
  expiresAt: new Date(Date.now() + 3_600_000),
  user: { id: USER_ID, isActive: true },
};

describe('Auth routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default DB mocks
    mockDb.user.findUnique.mockResolvedValue({ id: USER_ID, walletAddress: PUB_KEY });
    mockDb.user.create.mockResolvedValue({ id: USER_ID, walletAddress: PUB_KEY });
    mockDb.session.create.mockResolvedValue({ token: TOKEN });
    mockDb.session.findUnique.mockResolvedValue(SESSION);
    mockDb.session.deleteMany.mockResolvedValue({ count: 1 });
    mockDb.authNonce.findUnique.mockResolvedValue(null); // default: no active nonce
    mockDb.authNonce.upsert.mockResolvedValue({});
    mockDb.authNonce.delete.mockResolvedValue({});
  });

  // ── POST /api/auth/challenge ───────────────────────────────────────────────

  describe('POST /api/auth/challenge', () => {
    it('returns 400 when stellarPubKey is missing', async () => {
      const res = await request(app).post('/api/auth/challenge').send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('stellarPubKey is required');
    });

    it('returns 400 when stellarPubKey is an invalid format', async () => {
      const { Keypair } = jest.requireMock('@stellar/stellar-sdk') as any;
      Keypair.fromPublicKey.mockImplementationOnce(() => {
        throw new Error('bad key');
      });
      const res = await request(app)
        .post('/api/auth/challenge')
        .send({ stellarPubKey: 'INVALID_KEY' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid Stellar public key');
    });

    it('returns 200 with nonce and expiresAt for a valid public key', async () => {
      const res = await request(app)
        .post('/api/auth/challenge')
        .send({ stellarPubKey: PUB_KEY });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        nonce: expect.stringMatching(/^nw-auth-/),
        expiresAt: expect.any(String),
      });
    });

    it('stores the nonce in the DB via upsert', async () => {
      await request(app)
        .post('/api/auth/challenge')
        .send({ stellarPubKey: PUB_KEY });
      expect(mockDb.authNonce.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { stellarPubKey: PUB_KEY } }),
      );
    });
  });

  // ── POST /api/auth/verify ─────────────────────────────────────────────────

  describe('POST /api/auth/verify', () => {
    it('returns 400 when stellarPubKey is missing', async () => {
      const res = await request(app)
        .post('/api/auth/verify')
        .send({ signature: 'sig' });
      expect(res.status).toBe(400);
    });

    it('returns 400 when signature is missing', async () => {
      const res = await request(app)
        .post('/api/auth/verify')
        .send({ stellarPubKey: PUB_KEY });
      expect(res.status).toBe(400);
    });

    it('returns 401 when no challenge nonce exists for the public key', async () => {
      // nonce store is empty
      const res = await request(app)
        .post('/api/auth/verify')
        .send({ stellarPubKey: PUB_KEY, signature: 'sig' });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('No active challenge for this public key');
    });

    it('returns 401 when the nonce has expired', async () => {
      mockDb.authNonce.findUnique.mockResolvedValueOnce({
        nonce: 'nw-auth-expired',
        expiresAt: new Date(Date.now() - 1_000), // already expired
        stellarPubKey: PUB_KEY,
      });
      const res = await request(app)
        .post('/api/auth/verify')
        .send({ stellarPubKey: PUB_KEY, signature: 'sig' });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Challenge nonce has expired');
    });

    it('returns 401 when the signature is invalid', async () => {
      const { stellarVerification } = jest.requireMock(
        '../../../src/utils/stellar/stellar-verification',
      ) as any;
      stellarVerification.verifyStellarSignature.mockReturnValueOnce(false);
      mockDb.authNonce.findUnique.mockResolvedValueOnce({
        nonce: 'nw-auth-valid-nonce',
        expiresAt: new Date(Date.now() + 60_000),
        stellarPubKey: PUB_KEY,
      });
      const res = await request(app)
        .post('/api/auth/verify')
        .send({ stellarPubKey: PUB_KEY, signature: 'bad-sig' });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Invalid signature');
    });

    it('returns 200 with token and userId on success', async () => {
      mockDb.authNonce.findUnique.mockResolvedValueOnce({
        nonce: 'nw-auth-valid-nonce',
        expiresAt: new Date(Date.now() + 60_000),
        stellarPubKey: PUB_KEY,
      });
      const res = await request(app)
        .post('/api/auth/verify')
        .send({ stellarPubKey: PUB_KEY, signature: 'valid-sig' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        token: expect.any(String),
        userId: expect.any(String),
        expiresAt: expect.any(String),
      });
    });

    it('creates a new user when none exists for this public key', async () => {
      mockDb.user.findUnique.mockResolvedValue(null);
      mockDb.authNonce.findUnique.mockResolvedValueOnce({
        nonce: 'nw-auth-new-user',
        expiresAt: new Date(Date.now() + 60_000),
        stellarPubKey: PUB_KEY,
      });
      await request(app)
        .post('/api/auth/verify')
        .send({ stellarPubKey: PUB_KEY, signature: 'valid-sig' });
      expect(mockDb.user.create).toHaveBeenCalled();
    });

    it('consumes the nonce so it cannot be reused', async () => {
      mockDb.authNonce.findUnique.mockResolvedValueOnce({
        nonce: 'nw-auth-one-time',
        expiresAt: new Date(Date.now() + 60_000),
        stellarPubKey: PUB_KEY,
      });
      await request(app)
        .post('/api/auth/verify')
        .send({ stellarPubKey: PUB_KEY, signature: 'valid-sig' });
      // nonce should have been deleted from DB
      expect(mockDb.authNonce.delete).toHaveBeenCalledWith({ where: { stellarPubKey: PUB_KEY } });
    });
  });

  // ── POST /api/auth/logout ─────────────────────────────────────────────────

  describe('POST /api/auth/logout', () => {
    it('returns 401 without an auth token', async () => {
      const res = await request(app).post('/api/auth/logout');
      expect(res.status).toBe(401);
    });

    it('returns 200 and deletes the session on valid token', async () => {
      const res = await request(app)
        .post('/api/auth/logout')
        .set({ Authorization: `Bearer ${TOKEN}` });
      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Logged out successfully');
    });

    it('calls session.deleteMany with the revoked token', async () => {
      await request(app)
        .post('/api/auth/logout')
        .set({ Authorization: `Bearer ${TOKEN}` });
      expect(mockDb.session.deleteMany).toHaveBeenCalledWith({
        where: { token: TOKEN },
      });
    });

    it('returns 401 when session is expired', async () => {
      mockDb.session.findUnique.mockResolvedValue({
        ...SESSION,
        expiresAt: new Date(Date.now() - 1_000),
      });
      // Clean up stale session
      mockDb.session.delete.mockResolvedValue({});
      const res = await request(app)
        .post('/api/auth/logout')
        .set({ Authorization: `Bearer ${TOKEN}` });
      expect(res.status).toBe(401);
    });
  });
});
