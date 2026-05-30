// Prevent Prisma binary from starting — no real DB needed in these tests
jest.mock('../../db', () => ({ __esModule: true, default: {} }))

// Stub out custodial wallet creation to avoid Stellar network + DB dependency
jest.mock('../../stellar/wallet', () => ({
  createCustodialWallet: jest.fn().mockResolvedValue({
    publicKey: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  }),
  getWalletByUserId: jest.fn().mockResolvedValue({
    publicKey: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  }),
}))

// Prevent Anthropic SDK from making any network connections on initialization
jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    messages: {
      create: jest.fn().mockRejectedValue(new Error('Anthropic not available in tests')),
    },
  })),
}))

import express from 'express'
import request from 'supertest'
import crypto from 'crypto'

import { clearUsersForTests, getUserForTests } from '../userManager'

// Twilio signature helper (per https://www.twilio.com/docs/usage/security)
function computeTwilioSignature(authToken: string, url: string, params: Record<string, any>) {
  const keys = Object.keys(params).sort()
  const data = [url, ...keys.map((k) => `${k}${params[k]}`)].join('')
  return crypto.createHmac('sha1', authToken).update(data, 'utf8').digest('base64')
}

function createApp() {
  const app = express()
  app.use(express.urlencoded({ extended: false }))
  app.use(express.json())

  // Ensure we load whatsapp router after env is set for production signature validation.
  const { default: whatsappRouter } = require('../../routes/whatsapp')
  app.use('/api/whatsapp', whatsappRouter)

  return app
}

describe('WhatsApp webhook', () => {
  const authToken = 'test-token'
  const url = 'http://127.0.0.1/api/whatsapp/webhook'

  beforeEach(() => {
    process.env.TWILIO_AUTH_TOKEN = authToken
    process.env.NODE_ENV = 'production'
    process.env.WALLET_ENCRYPTION_KEY = 'a'.repeat(64)

    // Required env vars for config/env.ts
    process.env.STELLAR_NETWORK = 'testnet'
    process.env.STELLAR_RPC_URL = 'https://example.com'
    process.env.STELLAR_AGENT_SECRET_KEY = 'SBZVMB74Z76QZ3ZM67NZ7A6TPQ5FK7SAOSMAQVCHCLRUGSXWC5UKAAAA'
    process.env.VAULT_CONTRACT_ID = 'vault-contract'
    process.env.USDC_TOKEN_ADDRESS = 'usdc-token'
    process.env.ANTHROPIC_API_KEY = 'test'
    process.env.JWT_SEED = 'test-seed'
    process.env.JWT_SESSION_TTL_HOURS = '24'
    process.env.JWT_NONCE_TTL_MS = '300000'
    process.env.JWT_CLEANUP_INTERVAL_MS = '86400000'
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost/db'

    clearUsersForTests()
  })

  it('rejects invalid Twilio signature in production', async () => {
    const app = createApp()

    const res = await request(app)
      .post('/api/whatsapp/webhook')      .set('Host', '127.0.0.1')
      .set('X-Forwarded-Proto', 'http')      .set('X-Twilio-Signature', 'invalid')
      .send({ From: 'whatsapp:+10000000000', Body: 'balance' })

    expect(res.status).toBe(403)
  })

  it('accepts valid signature and sends OTP for new user', async () => {
    const app = createApp()
    const params = { From: 'whatsapp:+10000000000', Body: 'hello' }
    const signature = computeTwilioSignature(authToken, url, params)

    const res = await request(app)
      .post('/api/whatsapp/webhook')
      .set('Host', '127.0.0.1')
      .set('X-Forwarded-Proto', 'http')
      .set('X-Twilio-Signature', signature)
      .send(params)

    expect(res.status).toBe(200)
    expect(res.text).toContain('<Response>')
    expect(res.text).toContain('verification code')

    // Ensure user created and not verified
    const user = getUserForTests('+10000000000')
    expect(user).not.toBeNull()
    expect(user?.verified).toBe(false)
  })

  it('verifies OTP and allows balance queries', async () => {
    const app = createApp()
    const from = 'whatsapp:+10000000000'

    // First message creates user and sends OTP
    const firstParams = { From: from, Body: 'hello' }
    const signature1 = computeTwilioSignature(authToken, url, firstParams)
    const firstRes = await request(app)
      .post('/api/whatsapp/webhook')
      .set('Host', '127.0.0.1')
      .set('X-Forwarded-Proto', 'http')
      .set('X-Twilio-Signature', signature1)
      .send(firstParams)

    expect(firstRes.status).toBe(200)
    const otpMatch = firstRes.text.match(/(\d{6})/)
    expect(otpMatch).not.toBeNull()

    const otp = otpMatch?.[1] || ''

    // Reply with OTP
    const verifyParams = { From: from, Body: otp }
    const signature2 = computeTwilioSignature(authToken, url, verifyParams)
    const verifyRes = await request(app)
      .post('/api/whatsapp/webhook')
      .set('Host', '127.0.0.1')
      .set('X-Forwarded-Proto', 'http')
      .set('X-Twilio-Signature', signature2)
      .send(verifyParams)

    expect(verifyRes.status).toBe(200)
    expect(verifyRes.text).toContain('Your account is now verified')

    // Now ask for balance
    const balanceParams = { From: from, Body: 'balance' }
    const signature3 = computeTwilioSignature(authToken, url, balanceParams)
    const balanceRes = await request(app)
      .post('/api/whatsapp/webhook')
      .set('Host', '127.0.0.1')
      .set('X-Forwarded-Proto', 'http')
      .set('X-Twilio-Signature', signature3)
      .send(balanceParams)

    expect(balanceRes.status).toBe(200)
    expect(balanceRes.text).toContain('Your current balance')
  })
})
