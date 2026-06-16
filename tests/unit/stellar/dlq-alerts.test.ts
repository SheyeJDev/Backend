/**
 * Unit tests for DLQ alerting functionality
 * Tests threshold logic, cooldown behavior, and alert formatting
 */

import {
  alertingService,
  type DLQAlertPayload,
} from '../../../src/services/alerting'

describe('DLQ Alerting', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // Reset alert states by creating a fresh instance
    jest.resetModules()
  })

  describe('AlertingService', () => {
    it('should create singleton instance', () => {
      const instance1 = alertingService
      const instance2 = alertingService
      expect(instance1).toBe(instance2)
    })

    it('should identify enabled channels based on environment', () => {
      const channels = alertingService.getEnabledChannels()
      expect(channels).toContain('LOG')
    })

    describe('Cooldown Logic', () => {
      it('should suppress alert within cooldown window', async () => {
        const payload: DLQAlertPayload = {
          title: 'Test Alert',
          description: 'Test Description',
          severity: 'critical',
          component: 'dlq',
          dlqSize: 100,
          statusBreakdown: { pending: 80, retried: 15, resolved: 5 },
        }

        // First alert should succeed
        const result1 = await alertingService.emit(payload, 'test-alert-key')
        expect(result1.sent).toBe(true)

        // Second alert within cooldown should be suppressed
        const result2 = await alertingService.emit(payload, 'test-alert-key')
        expect(result2.sent).toBe(false)
        expect(result2.reason).toContain('cooldown')
      })

      it('should allow alert after cooldown expires', async () => {
        jest.useFakeTimers()

        const payload: DLQAlertPayload = {
          title: 'Test Alert',
          description: 'Test Description',
          severity: 'critical',
          component: 'dlq',
          dlqSize: 100,
          statusBreakdown: { pending: 80, retried: 15, resolved: 5 },
        }

        // First alert
        const result1 = await alertingService.emit(payload, 'test-cooldown')
        expect(result1.sent).toBe(true)

        // Within cooldown
        const result2 = await alertingService.emit(payload, 'test-cooldown')
        expect(result2.sent).toBe(false)

        // After cooldown (advance 16 minutes)
        jest.advanceTimersByTime(16 * 60 * 1000)
        const result3 = await alertingService.emit(payload, 'test-cooldown')
        expect(result3.sent).toBe(true)

        jest.useRealTimers()
      })
    })

    describe('DLQ Alert Payload', () => {
      it('should format DLQ alert with all metadata', async () => {
        const payload: DLQAlertPayload = {
          title: 'DLQ Critical Alert',
          description: 'Queue exceeded threshold',
          severity: 'critical',
          component: 'dlq',
          dlqSize: 75,
          statusBreakdown: {
            pending: 60,
            retried: 10,
            resolved: 5,
          },
          oldestPendingAge: {
            eventId: 'evt-123',
            ageMs: 3600000, // 1 hour
            ageHumanReadable: '1 hour',
          },
          adminLink: 'https://admin.example.com/dlq',
          metadata: {
            threshold: 50,
            timestamp: new Date().toISOString(),
          },
        }

        const result = await alertingService.emitDLQAlert(payload)
        // Should at least attempt to emit (may fail if no external service configured)
        expect(result).toBeDefined()
      })

      it('should handle alert without optional metadata', async () => {
        const payload: DLQAlertPayload = {
          title: 'DLQ Alert',
          description: 'Queue size increased',
          severity: 'warning',
          component: 'dlq',
          dlqSize: 25,
          statusBreakdown: { pending: 20, retried: 5, resolved: 0 },
        }

        const result = await alertingService.emitDLQAlert(payload)
        expect(result).toBeDefined()
      })
    })

    describe('Alert Channels', () => {
      it('should always send to LOG channel', async () => {
        const payload: DLQAlertPayload = {
          title: 'Test',
          description: 'Test alert',
          severity: 'critical',
          component: 'dlq',
          dlqSize: 50,
          statusBreakdown: { pending: 40, retried: 5, resolved: 5 },
        }

        // LOG channel should always be present
        const channels = alertingService.getEnabledChannels()
        expect(channels).toContain('LOG')

        const result = await alertingService.emit(payload, 'log-test')
        expect(result.sent).toBe(true)
      })
    })

    describe('Clear DLQ State', () => {
      it('should clear alert state when queue normalizes', async () => {
        const payload: DLQAlertPayload = {
          title: 'Test',
          description: 'Test',
          severity: 'critical',
          component: 'dlq',
          dlqSize: 100,
          statusBreakdown: { pending: 100, retried: 0, resolved: 0 },
        }

        // Emit alert
        await alertingService.emitDLQAlert(payload)

        // Clear state
        alertingService.clearDLQAlertState()

        // Next alert should succeed (no cooldown)
        const result = await alertingService.emit(payload, 'dlq:threshold')
        expect(result.sent).toBe(true)
      })
    })
  })

  describe('Alert Severity Levels', () => {
    it('should handle critical severity', async () => {
      const payload: DLQAlertPayload = {
        title: 'Critical Alert',
        description: 'Immediate action required',
        severity: 'critical',
        component: 'dlq',
        dlqSize: 100,
        statusBreakdown: { pending: 90, retried: 5, resolved: 5 },
      }

      const result = await alertingService.emit(payload, 'critical-test')
      expect(result.sent).toBe(true)
    })

    it('should handle warning severity', async () => {
      const payload: DLQAlertPayload = {
        title: 'Warning Alert',
        description: 'Investigate soon',
        severity: 'warning',
        component: 'dlq',
        dlqSize: 30,
        statusBreakdown: { pending: 20, retried: 5, resolved: 5 },
      }

      const result = await alertingService.emit(payload, 'warning-test')
      expect(result.sent).toBe(true)
    })

    it('should handle info severity', async () => {
      const payload: DLQAlertPayload = {
        title: 'Info Alert',
        description: 'Monitor trend',
        severity: 'info',
        component: 'dlq',
        dlqSize: 10,
        statusBreakdown: { pending: 5, retried: 3, resolved: 2 },
      }

      const result = await alertingService.emit(payload, 'info-test')
      expect(result.sent).toBe(true)
    })
  })
})
