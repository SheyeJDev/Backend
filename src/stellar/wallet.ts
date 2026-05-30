import { Keypair } from '@stellar/stellar-sdk';
import * as crypto from 'crypto';
import db from '../db';
import { logger } from '../utils/logger';

const ALGORITHM = 'aes-256-gcm';

function getEncryptionKey(): string {
  const key = process.env.WALLET_ENCRYPTION_KEY || '';
  if (!key || key.length !== 64) {
    throw new Error('WALLET_ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
  }
  return key;
}

function encryptSecret(secret: string): { encrypted: string; iv: string; authTag: string } {
  const key = Buffer.from(getEncryptionKey(), 'hex');
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(secret, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  return {
    encrypted,
    iv: iv.toString('hex'),
    authTag: cipher.getAuthTag().toString('hex'),
  };
}

function decryptSecret(encrypted: string, iv: string, authTag: string): string {
  const key = Buffer.from(getEncryptionKey(), 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(authTag, 'hex'));

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Create a custodial wallet for a user and persist it to the database.
 *
 * SECURITY NOTE: This is a custodial solution where the backend holds user keys.
 * Users trust the backend to secure their funds. Consider non-custodial alternatives
 * for production use cases requiring higher security guarantees.
 *
 * Key rotation / backup: rotate WALLET_ENCRYPTION_KEY by re-encrypting all rows
 * with the new key before deploying. Back up the database regularly; losing the
 * encryption key means wallets cannot be recovered.
 */
export async function createCustodialWallet(userId: string) {
  const existing = await db.custodialWallet.findUnique({ where: { userId } });
  if (existing) {
    throw new Error(`Wallet already exists for user ${userId}`);
  }

  const keypair = Keypair.random();
  const { encrypted, iv, authTag } = encryptSecret(keypair.secret());

  const wallet = await db.custodialWallet.create({
    data: {
      userId,
      publicKey: keypair.publicKey(),
      encryptedSecret: encrypted,
      iv,
      authTag,
    },
  });

  logger.info(`[Wallet] Created for user ${userId}: ${wallet.publicKey}`);
  return wallet;
}

/**
 * Get wallet record by user ID.
 */
export async function getWalletByUserId(userId: string) {
  return db.custodialWallet.findUnique({ where: { userId } });
}

/**
 * Decrypt and return the Stellar Keypair for a user.
 */
export async function getKeypairForUser(userId: string): Promise<Keypair> {
  const wallet = await getWalletByUserId(userId);

  if (!wallet) {
    throw new Error(`No wallet found for user ${userId}`);
  }

  const secret = decryptSecret(wallet.encryptedSecret, wallet.iv, wallet.authTag);
  return Keypair.fromSecret(secret);
}

/**
 * List all wallet public keys (for admin/debugging).
 */
export async function listWallets(): Promise<string[]> {
  const wallets = await db.custodialWallet.findMany({ select: { publicKey: true } });
  return wallets.map(w => w.publicKey);
}
