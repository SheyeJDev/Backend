/**
 * wallet.test.ts
 *
 * Unit tests for custodial wallet operations.
 * Prisma is mocked so no real database is required.
 * Verifies create/read behaviour and encrypted-secret round-trip.
 */

import { Keypair } from '@stellar/stellar-sdk';
import * as cryptoMod from 'crypto';

// ── DB mock (must be defined before jest.mock factory runs via hoisting) ─────
// Use module-level jest.fn() calls inside the factory so they are accessible
// after import via the `mockedDb` reference below.

jest.mock('../../../src/db', () => {
  const mock = {
    custodialWallet: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
    },
  };
  return { __esModule: true, default: mock, db: mock };
});

// Provide a valid 64-hex WALLET_ENCRYPTION_KEY for tests
const TEST_KEY = 'a'.repeat(64);
process.env.WALLET_ENCRYPTION_KEY = TEST_KEY;

// Import AFTER mocks are registered
import db from '../../../src/db';
import {
  createCustodialWallet,
  getWalletByUserId,
  getKeypairForUser,
  listWallets,
} from '../../../src/stellar/wallet';

// Typed reference to the custodialWallet mock namespace
const mockCW = db.custodialWallet as jest.Mocked<typeof db.custodialWallet>;

// ── Helpers ──────────────────────────────────────────────────────────────────

function fakeWalletRow(userId: string) {
  const keypair = Keypair.random();
  const key = Buffer.from(TEST_KEY, 'hex');
  const iv = cryptoMod.randomBytes(16);
  const cipher = cryptoMod.createCipheriv('aes-256-gcm', key, iv);
  let enc = cipher.update(keypair.secret(), 'utf8', 'hex');
  enc += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  return {
    id: 'wallet-uuid-1',
    userId,
    publicKey: keypair.publicKey(),
    encryptedSecret: enc,
    iv: iv.toString('hex'),
    authTag,
    createdAt: new Date(),
    updatedAt: new Date(),
    _keypair: keypair,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('createCustodialWallet', () => {
  beforeEach(() => jest.clearAllMocks());

  it('throws when a wallet already exists for the user', async () => {
    const row = fakeWalletRow('user-1');
    mockCW.findUnique.mockResolvedValue(row as any);

    await expect(createCustodialWallet('user-1')).rejects.toThrow(
      'Wallet already exists for user user-1',
    );
    expect(mockCW.create).not.toHaveBeenCalled();
  });

  it('creates and persists a new wallet when none exists', async () => {
    mockCW.findUnique.mockResolvedValue(null);
    mockCW.create.mockImplementation(({ data }: any) => ({
      id: 'wallet-uuid-new',
      ...data,
      createdAt: new Date(),
      updatedAt: new Date(),
    }) as any);

    const result = await createCustodialWallet('user-2');

    expect(mockCW.create).toHaveBeenCalledTimes(1);
    const created = (mockCW.create as jest.Mock).mock.calls[0][0].data;
    expect(created.userId).toBe('user-2');
    expect(created.publicKey).toMatch(/^G/); // Stellar public keys start with G
    expect(created.encryptedSecret).toBeTruthy();
    expect(created.iv).toHaveLength(32);     // 16 bytes as hex
    expect(created.authTag).toHaveLength(32);
    expect(result.userId).toBe('user-2');
  });
});

describe('getWalletByUserId', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns null when no wallet exists', async () => {
    mockCW.findUnique.mockResolvedValue(null);
    await expect(getWalletByUserId('unknown')).resolves.toBeNull();
  });

  it('returns the wallet row when found', async () => {
    const row = fakeWalletRow('user-3');
    mockCW.findUnique.mockResolvedValue(row as any);
    const result = await getWalletByUserId('user-3');
    expect(result?.publicKey).toBe(row.publicKey);
  });

  it('simulates persistence across restarts: findUnique is called on DB each time', async () => {
    const row = fakeWalletRow('user-4');
    mockCW.findUnique
      .mockResolvedValueOnce(row as any) // "before restart"
      .mockResolvedValueOnce(row as any); // "after restart"

    const first = await getWalletByUserId('user-4');
    const second = await getWalletByUserId('user-4');
    expect(first?.publicKey).toBe(second?.publicKey);
    expect(mockCW.findUnique).toHaveBeenCalledTimes(2);
  });
});

describe('getKeypairForUser', () => {
  beforeEach(() => jest.clearAllMocks());

  it('throws when no wallet is found', async () => {
    mockCW.findUnique.mockResolvedValue(null);
    await expect(getKeypairForUser('no-wallet')).rejects.toThrow(
      'No wallet found for user no-wallet',
    );
  });

  it('returns a valid Keypair whose public key matches the stored one', async () => {
    const row = fakeWalletRow('user-5');
    mockCW.findUnique.mockResolvedValue(row as any);

    const keypair = await getKeypairForUser('user-5');
    expect(keypair.publicKey()).toBe(row.publicKey);
    expect(keypair.secret()).toBe(row._keypair.secret());
  });
});

describe('listWallets', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns an empty array when no wallets exist', async () => {
    mockCW.findMany.mockResolvedValue([] as any);
    await expect(listWallets()).resolves.toEqual([]);
  });

  it('returns all public keys', async () => {
    mockCW.findMany.mockResolvedValue([
      { publicKey: 'GABC' },
      { publicKey: 'GXYZ' },
    ] as any);
    await expect(listWallets()).resolves.toEqual(['GABC', 'GXYZ']);
  });
});
