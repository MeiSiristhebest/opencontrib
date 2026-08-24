import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { homedir, platform, tmpdir } from 'os';
import { join } from 'path';

export const DISCOVERY_BUDGET_MS = 20_000;

export interface DockerDiscoveryResult {
  found: boolean;
  path?: string;
  method?: string;
  alternatives?: string[];
}

function run(cmd: string, args: string[], timeoutMs: number, cwd?: string): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync(cmd, args, {
    encoding: 'utf-8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(cwd ? { cwd } : {}),
    env: {
      ...process.env,
      TERM: process.env.TERM || 'xterm',
    },
  });
  return {
    ok: result.status === 0,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
  };
}

function verifyDaemon(dockerPath: string, remaining: () => number): boolean {
  // Verify daemon actually responds — avoids false positive when CLI exists but daemon is down
  if (remaining() > 0) {
    const result = spawnSync(dockerPath, ['info'], {
      encoding: 'utf-8',
      timeout: Math.min(5000, remaining()),
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return result.status === 0;
  }
  return false;
}

let cachedDockerResult: { result: DockerDiscoveryResult; expiresAt: number } | null = null;

export function clearDockerCache(): void {
  cachedDockerResult = null;
}

export function discoverDocker(forceRefresh = false): DockerDiscoveryResult {
  const now = Date.now();
  if (!forceRefresh && cachedDockerResult && cachedDockerResult.expiresAt > now) {
    return cachedDockerResult.result;
  }

  const isWindows = platform() === 'win32';
  const budget = DISCOVERY_BUDGET_MS;
  let elapsed = 0;
  const remaining = () => budget - elapsed;

  let found = false;
  let method: string | undefined;
  let path: string | undefined;

  // ── Layer 1: PATH ──
  if (remaining() > 0) {
    const start = Date.now();
    const result = run(isWindows ? 'where.exe' : 'command', ['-q', isWindows ? 'docker' : '-v', 'docker'].filter(Boolean), Math.min(3000, remaining()));
    if (result.ok) {
      if (verifyDaemon('docker', remaining)) {
        found = true;
        method = 'PATH';
      }
    }
    elapsed = Date.now() - start;
  }

  // ── Layer 2: Windows registry ──
  if (!found && isWindows && remaining() > 0) {
    const start = Date.now();
    const result = run('reg', ['query', 'HKLM\\SOFTWARE\\Docker Inc.', '/reg:32'], Math.min(3000, remaining()));
    if (result.ok) {
      const pathMatch = result.stdout.match(/InstallLocation\s+REG_SZ\s+(.+)/i);
      if (pathMatch) {
        const installDir = pathMatch[1].trim();
        const bin = join(installDir, 'resources', 'bin', 'docker.exe');
        if (existsSync(bin) && verifyDaemon(bin, remaining)) {
          found = true;
          path = bin;
          method = 'Windows Registry';
        }
      }
    }
    elapsed = Date.now() - start;
  }

  // ── Layer 3: PowerShell Get-Command ──
  if (!found && isWindows && remaining() > 0) {
    const start = Date.now();
    const result = run('powershell', ['-NoProfile', '-Command', 'Get-Command docker -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source'], Math.min(3000, remaining()));
    if (result.ok && result.stdout.length > 0) {
      const dockerPath = result.stdout.trim();
      if (existsSync(dockerPath) && verifyDaemon(dockerPath, remaining)) {
        found = true;
        path = dockerPath;
        method = 'PowerShell Get-Command';
      }
    }
    elapsed = Date.now() - start;
  }

  // ── Layer 4: Drive scan (Windows only) ──
  // Accepts both "C:" and "C:\\" from WMI — normalizes trailing backslash
  if (!found && isWindows && remaining() > 0) {
    const start = Date.now();
    const drives = run('powershell', ['-NoProfile', '-Command', 'Get-WmiObject Win32_LogicalDisk | Select-Object -ExpandProperty DeviceID'], Math.min(5000, remaining()));
    if (drives.ok) {
      const driveLetters = drives.stdout.split('\r\n').filter((d) => d.match(/^[A-Z]:\\?$/i));
      for (const rawDrive of driveLetters) {
        const drive = rawDrive.endsWith('\\') ? rawDrive : rawDrive + '\\';
        const candidates = [
          join(drive, 'Docker', 'Desktop', 'resources', 'bin', 'docker.exe'),
          join(drive, 'Program Files', 'Docker', 'Docker', 'resources', 'bin', 'docker.exe'),
          join(drive, 'Program Files (x86)', 'Docker', 'Docker', 'resources', 'bin', 'docker.exe'),
        ];
        for (const candidate of candidates) {
          if (existsSync(candidate) && verifyDaemon(candidate, remaining)) {
            found = true;
            path = candidate;
            method = `Drive scan (${rawDrive})`;
          }
        }
        if (found) break;
      }
    }
    elapsed = Date.now() - start;
  }

  // ── Layer 5: WSL ──
  if (!found && remaining() > 0) {
    const start = Date.now();
    const wslCheck = run('wsl', ['docker', 'info'], Math.min(5000, remaining()));
    if (wslCheck.ok) {
      found = true;
      method = 'WSL';
    }
    elapsed = Date.now() - start;
  }

  // ── Layer 6: Docker socket ──
  if (!found && remaining() > 0) {
    const socketCandidates = [
      join('/var/run', 'docker.sock'),
      join(homedir(), '.docker', 'docker.sock'),
      join(tmpdir(), 'docker.sock'),
    ];
    for (const socket of socketCandidates) {
      if (existsSync(socket)) {
        // Socket exists — verify daemon responds through it
        if (verifyDaemon('docker', remaining)) {
          found = true;
          path = socket;
          method = 'Docker socket';
        }
      }
    }
  }

  // ── Always collect alternatives for informational purposes ──
  const alternatives: string[] = [];

  if (isWindows ? run('where.exe', ['-q', 'nerdctl'], 2000).ok : run('command', ['-v', 'nerdctl'], 2000).ok) {
    alternatives.push('nerdctl (containerd native CLI) is available');
  }
  if (isWindows ? run('where.exe', ['-q', 'podman'], 2000).ok : run('command', ['-v', 'podman'], 2000).ok) {
    alternatives.push('podman is available');
  }
  if (!found) {
    alternatives.push('Native Git Worktree sandbox (opencontrib workspace)');
    if (isWindows) alternatives.push('WSL + native Docker inside WSL');
  }

  const result: DockerDiscoveryResult = { found, method, path, alternatives };
  cachedDockerResult = {
    result,
    expiresAt: Date.now() + 30000,
  };
  return result;
}
