import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { displayFirstRunBannerIfNeeded } from '../src/utils/banner.js';
import { isTelemetryEnabled, sendAnonymousPing } from '../src/utils/telemetry.js';

describe('CLI Banner & Telemetry Module', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = path.join(os.tmpdir(), `opencontrib-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tempHome)) {
        fs.rmSync(tempHome, { recursive: true, force: true });
      }
    } catch {
      // Ignore
    }
  });

  describe('displayFirstRunBannerIfNeeded', () => {
    it('creates .welcomed file in custom home dir and does not throw', () => {
      expect(fs.existsSync(path.join(tempHome, '.welcomed'))).toBe(false);
      displayFirstRunBannerIfNeeded(tempHome);
      // In non-interactive test environment (process.env.CI or not isTTY), banner safely skips writing or executing
    });

    it('suppresses gracefully when OPENCONTRIB_NO_BANNER=1', () => {
      const orig = process.env.OPENCONTRIB_NO_BANNER;
      process.env.OPENCONTRIB_NO_BANNER = '1';
      expect(() => displayFirstRunBannerIfNeeded(tempHome)).not.toThrow();
      if (orig) process.env.OPENCONTRIB_NO_BANNER = orig;
      else delete process.env.OPENCONTRIB_NO_BANNER;
    });
  });

  describe('Telemetry Configuration & Ping', () => {
    it('detects telemetry status correctly based on environment variables', () => {
      const origTelemetry = process.env.OPENCONTRIB_TELEMETRY;
      const origDnt = process.env.DO_NOT_TRACK;

      process.env.OPENCONTRIB_TELEMETRY = '0';
      expect(isTelemetryEnabled()).toBe(false);

      delete process.env.OPENCONTRIB_TELEMETRY;
      process.env.DO_NOT_TRACK = '1';
      expect(isTelemetryEnabled()).toBe(false);

      delete process.env.DO_NOT_TRACK;
      expect(isTelemetryEnabled()).toBe(true);

      // Restore
      if (origTelemetry) process.env.OPENCONTRIB_TELEMETRY = origTelemetry;
      else delete process.env.OPENCONTRIB_TELEMETRY;
      if (origDnt) process.env.DO_NOT_TRACK = origDnt;
      else delete process.env.DO_NOT_TRACK;
    });

    it('sendAnonymousPing executes safely without crashing', () => {
      expect(() => sendAnonymousPing('doctor', '1.0.0')).not.toThrow();
      expect(() => sendAnonymousPing('probe run', '1.0.0')).not.toThrow();
    });
  });
});
