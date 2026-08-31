import os from 'os';

export interface AnonymousTelemetryPayload {
  command: string;
  os: string;
  arch: string;
  runtime: string;
  nodeVersion: string;
  cliVersion: string;
  timestamp: string;
}

/**
 * Checks whether telemetry is enabled.
 * Users can disable telemetry anytime by setting:
 *   OPENCONTRIB_TELEMETRY=0 or DO_NOT_TRACK=1
 */
export function isTelemetryEnabled(): boolean {
  if (
    process.env.OPENCONTRIB_TELEMETRY === '0' ||
    process.env.DO_NOT_TRACK === '1'
  ) {
    return false;
  }
  return true;
}

/**
 * Sends a lightweight, anonymous telemetry heartbeat to Scarf gateway.
 * Strictly anonymous: NO paths, NO file contents, NO user IDs, NO auth tokens.
 * Completely non-blocking and fails silently.
 */
export function sendAnonymousPing(commandName: string, cliVersion = '1.0.0'): void {
  if (!isTelemetryEnabled()) {
    return;
  }

  try {
    const isBun = typeof (globalThis as any).Bun !== 'undefined';
    const runtime = isBun ? 'bun' : 'node';

    const payload: AnonymousTelemetryPayload = {
      command: commandName || 'unknown',
      os: os.platform(),
      arch: os.arch(),
      runtime,
      nodeVersion: process.version,
      cliVersion,
      timestamp: new Date().toISOString(),
    };

    if (typeof fetch === 'function') {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timeoutId = controller ? setTimeout(() => controller.abort(), 1500) : null;

      // Scarf Gateway telemetry pixel endpoint
      const scarfUrl = `https://static.scarf.sh/a.png?x-pxid=p2L36r5iF7fAu6cd2J2Y41Cp6Z3YJHInGjzgouIZuLLHJhyoV9&package=@opencontrib/cli&cmd=${encodeURIComponent(payload.command)}&os=${encodeURIComponent(payload.os)}&arch=${encodeURIComponent(payload.arch)}&runtime=${encodeURIComponent(payload.runtime)}`;

      fetch(scarfUrl, {
        method: 'GET',
        signal: controller?.signal,
        headers: {
          'User-Agent': `@opencontrib/cli/${cliVersion} (${payload.os}; ${payload.arch}; ${payload.runtime})`,
        },
      })
        .catch(() => {
          // Fire-and-forget: silently ignore network timeouts/offline errors
        })
        .finally(() => {
          if (timeoutId) clearTimeout(timeoutId);
        });
    }
  } catch {
    // Top-level silent guard: never crash the CLI under any circumstance
  }
}
