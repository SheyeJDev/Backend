/**
 * webhook.test.ts
 *
 * Tests for Twilio webhook signature validation in whatsapp.ts.
 * Covers:
 *  - 403 when TWILIO_AUTH_TOKEN is not set (no token configured)
 *  - 403 when x-twilio-signature is invalid (staging-like config without production flag)
 *  - 200 when signature is valid
 */

import request from 'supertest'
import express from 'express'
import { validateRequest } from 'twilio'

// Mock twilio validateRequest so we can control the result
jest.mock('twilio', () => {
  const original = jest.requireActual('twilio')
  return {
    ...original,
    validateRequest: jest.fn(),
  }
})

// Mock the WhatsApp message handler to avoid deep dependencies
jest.mock('../../../src/whatsapp/handler', () => ({
  handleWhatsAppMessage: jest.fn().mockResolvedValue({ body: 'OK' }),
}))

const mockValidateRequest = validateRequest as jest.MockedFunction<typeof validateRequest>

// Build a single app whose route reads env vars at request time
import whatsappRouter from '../../../src/routes/whatsapp'

const app = express()
app.use(express.urlencoded({ extended: false }))
app.use(express.json())
app.use('/api/whatsapp', whatsappRouter)

afterEach(() => {
  jest.clearAllMocks()
  delete process.env.TWILIO_AUTH_TOKEN
})

describe('POST /api/whatsapp/webhook — signature validation', () => {
  it('returns 403 when TWILIO_AUTH_TOKEN is not set (no token configured)', async () => {
    delete process.env.TWILIO_AUTH_TOKEN

    const res = await request(app)
      .post('/api/whatsapp/webhook')
      .send({ From: '+1234', Body: 'hello' })

    expect(res.status).toBe(403)
    expect(res.text).toMatch(/TWILIO_AUTH_TOKEN not configured/)
    expect(mockValidateRequest).not.toHaveBeenCalled()
  })

  it('returns 403 for an invalid signature even when NODE_ENV is staging (not production)', async () => {
    const savedEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'staging'
    process.env.TWILIO_AUTH_TOKEN = 'test-auth-token'
    mockValidateRequest.mockReturnValue(false)

    const res = await request(app)
      .post('/api/whatsapp/webhook')
      .set('x-twilio-signature', 'bad-signature')
      .send({ From: '+1234', Body: 'hello' })

    expect(res.status).toBe(403)
    expect(res.text).toMatch(/invalid Twilio signature/)
    expect(mockValidateRequest).toHaveBeenCalledTimes(1)
    process.env.NODE_ENV = savedEnv
  })

  it('returns 403 for an invalid signature in development', async () => {
    const savedEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'development'
    process.env.TWILIO_AUTH_TOKEN = 'test-auth-token'
    mockValidateRequest.mockReturnValue(false)

    const res = await request(app)
      .post('/api/whatsapp/webhook')
      .set('x-twilio-signature', 'tampered')
      .send({ From: '+1234', Body: 'hello' })

    expect(res.status).toBe(403)
    expect(mockValidateRequest).toHaveBeenCalledTimes(1)
    process.env.NODE_ENV = savedEnv
  })

  it('returns 200 with TwiML when signature is valid', async () => {
    process.env.TWILIO_AUTH_TOKEN = 'valid-auth-token'
    mockValidateRequest.mockReturnValue(true)

    const res = await request(app)
      .post('/api/whatsapp/webhook')
      .set('x-twilio-signature', 'correct-signature')
      .send({ From: '+1234', Body: 'hello' })

    expect(res.status).toBe(200)
    expect(res.type).toMatch(/xml/)
    expect(mockValidateRequest).toHaveBeenCalledTimes(1)
  })

  it('calls validateRequest regardless of NODE_ENV value', async () => {
    for (const env of ['development', 'staging', 'production']) {
      jest.clearAllMocks()
      const savedEnv = process.env.NODE_ENV
      process.env.NODE_ENV = env
      process.env.TWILIO_AUTH_TOKEN = 'some-token'
      mockValidateRequest.mockReturnValue(false)

      const res = await request(app)
        .post('/api/whatsapp/webhook')
        .set('x-twilio-signature', 'invalid')
        .send({ From: '+1234', Body: 'hi' })

      expect(res.status).toBe(403)
      expect(mockValidateRequest).toHaveBeenCalledTimes(1)
      process.env.NODE_ENV = savedEnv
    }
  })
})
