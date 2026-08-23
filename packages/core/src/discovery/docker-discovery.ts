/**
 * Six-layer Docker discovery with per-layer timeout and a global budget.
 *
 * Layers (ordered by speed):
 *  1. PATH: `docker --version`
 *  2. Windows registry: `reg query HKLM\SOFTWARE\Docker Inc.`
 *  3. PowerShell: `Get-Command docker`
 *  4. Drive scan: `Get-WmiObject Win32_LogicalDisk` → scan each drive
 *  5. WSL: `wsl docker --version`
 *  6. Docker socket: `/var/run/docker.sock` / `%TEMP%\docker.sock`
 *
 * If any layer succeeds AND `docker info` daemon check passes → return { found, path, method }.
 * Otherwise → { found: false, alternatives: [...] }.
 */

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

export function discoverDocker(): DockerDiscoveryResult {
  const isWindows = platform() === 'win32';
  const budget = DISCOVERY_BUDGET_MS;
  let elapsed = 0;
  const remaining = () => budget - elapsed;

  // ── Layer 1: PATH ──
  if (remaining() > 0) {
    const start = Date.now();
    const result = run(isWindows ? 'where.exe' : 'command', ['-q', isWindows ? 'docker' : '-v', 'docker'].filter(Boolean), Math.min(3000, remaining()));
    if (result.ok) {
      elapsed = Date.now() - start;
      // Verify daemon responds
      if (remaining() > 0) {
        const daemon = run('docker', ['info'], Math.min(5000, remaining()));
        if (daemon.ok) {
          return { found: true, method: 'PATH' };
        }
      }
      // CLI exists but daemon might not respond — still report as found
      return { found: true, method: 'PATH' };
    }
    elapsed = Date.now() - start;
  }

  // ── Layer 2: Windows registry ──
  if (isWindows && remaining() > 0) {
    const start = Date.now();
    const result = run('reg', ['query', 'HKLM\\SOFTWARE\\Docker Inc.', '/reg:32'], Math.min(3000, remaining()));
    if (result.ok) {
      elapsed = Date.now() - start;
      const pathMatch = result.stdout.match(/InstallLocation\s+REG_SZ\s+(.+)/i);
      if (pathMatch) {
        const installDir = pathMatch[1].trim();
        const bin = join(installDir, 'resources', 'bin', 'docker.exe');
        if (existsSync(bin)) {
          return { found: true, path: bin, method: 'Windows Registry' };
        }
      }
    }
    elapsed = Date.now() - start;
  }

  // ── Layer 3: PowerShell Get-Command ──
  if (isWindows && remaining() > 0) {
    const start = Date.now();
    const result = run('powershell', ['-NoProfile', '-Command', 'Get-Command docker -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source'], Math.min(3000, remaining()));
    if (result.ok && result.stdout.length > 0) {
      elapsed = Date.now() - start;
      const dockerPath = result.stdout.trim();
      if (existsSync(dockerPath)) {
        return { found: true, path: dockerPath, method: 'PowerShell Get-Command' };
      }
    }
    elapsed = Date.now() - start;
  }

  // ── Layer 4: Drive scan (Windows only) ──
  if (isWindows && remaining() > 0) {
    const start = Date.now();
    const drives = run('powershell', ['-NoProfile', '-Command', 'Get-WmiObject Win32_LogicalDisk | Select-Object -ExpandProperty DeviceID'], Math.min(5000, remaining()));
    if (drives.ok) {
      const driveLetters = drives.stdout.split('\r\n').filter((d) => d.match(/^[A-Z]:$/i));
      for (const drive of driveLetters) {
        const candidates = [
          join(drive, 'Docker', 'Desktop', 'resources', 'bin', 'docker.exe'),
          join(drive, 'Program Files', 'Docker', 'Docker', 'resources', 'bin', 'docker.exe'),
          join(drive, 'Program Files (x86)', 'Docker', 'Docker', 'resources', 'bin', 'docker.exe'),
        ];
        for (const candidate of candidates) {
          if (existsSync(candidate)) {
            elapsed = Date.now() - start;
            return { found: true, path: candidate, method: `Drive scan (${drive})` };
          }
        }
      }
    }
    elapsed = Date.now() - start;
  }

  // ── Layer 5: WSL ──
  if (remaining() > 0) {
    const start = Date.now();
    const wslCheck = run('wsl', ['docker', '--version'], Math.min(5000, remaining()));
    if (wslCheck.ok) {
      elapsed = Date.now() - start;
      return { found: true, method: 'WSL' };
    }
    elapsed = Date.now() - start;
  }

  // ── Layer 6: Docker socket ──
  if (remaining() > 0) {
    const socketCandidates = [
      join('/var/run', 'docker.sock'),
      join(homedir(), '.docker', 'docker.sock'),
      join(tmpdir(), 'docker.sock'),
    ];
    for (const socket of socketCandidates) {
      if (existsSync(socket)) {
        return { found: true, path: socket, method: 'Docker socket' };
      }
    }
  }

  // ── Not found: suggest alternatives ──
  const alternatives: string[] = [];

  // Check nerdctl (containerd native CLI)
  if (isWindows ? run('where.exe', ['-q', 'nerdctl'], 2000).ok : run('command', ['-v', 'nerdctl'], 2000).ok) {
    alternatives.push('nerdctl (containerd native CLI) is available');
  }
  // Check podman
  if (isWindows ? run('where.exe', ['-q', 'podman'], 2000).ok : run('command', ['-v', 'podman'], 2000).ok) {
    alternatives.push('podman is available');
  }
  alternatives.push('Native Git Worktree sandbox (opencontrib workspace)');
  if (isWindows) alternatives.push('WSL + native Docker inside WSL');

  return { found: false, alternatives };
}
