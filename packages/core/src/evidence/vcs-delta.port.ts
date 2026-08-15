import { spawnSync } from 'child_process';

export interface VcsDeltaQuery {
  cwd: string;
  baselineCommitSha?: string;
  timeoutMs?: number;
}

export interface VcsDeltaPort {
  getDiff(query: VcsDeltaQuery): Promise<string | undefined>;
}

export class CliGitDeltaAdapter implements VcsDeltaPort {
  async getDiff(query: VcsDeltaQuery): Promise<string | undefined> {
    const { cwd, baselineCommitSha, timeoutMs = 5000 } = query;
    try {
      const args = baselineCommitSha
        ? ['diff', baselineCommitSha, '--unified=0']
        : ['diff', 'HEAD', '--unified=0'];

      const res = spawnSync('git', args, {
        cwd,
        encoding: 'utf-8',
        timeout: timeoutMs,
      });

      if (res.status === 0 && typeof res.stdout === 'string') {
        return res.stdout;
      }
    } catch {}
    return undefined;
  }
}

export const defaultVcsDeltaAdapter = new CliGitDeltaAdapter();
