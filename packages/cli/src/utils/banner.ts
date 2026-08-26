import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Renders an elegant first-run onboarding banner when OpenContrib is run interactively for the first time.
 * Strictly suppressed in CI, non-TTY pipes, or when DO_NOT_TRACK / OPENCONTRIB_NO_BANNER is set.
 */
export function displayFirstRunBannerIfNeeded(homeDir?: string): void {
  try {
    // 1. Strict suppression for automated, CI, and piped JSON environments
    if (
      process.env.CI ||
      process.env.GITHUB_ACTIONS ||
      process.env.CONTINUOUS_INTEGRATION ||
      process.env.OPENCONTRIB_NO_BANNER === '1' ||
      process.env.DO_NOT_TRACK === '1'
    ) {
      return;
    }

    // Must be an interactive TTY stream (prevents contaminating JSON/piped stdout)
    if (!process.stdout || !process.stdout.isTTY) {
      return;
    }

    const baseDir = homeDir || process.env.OPENCONTRIB_HOME || path.join(os.homedir(), '.opencontrib');
    const markerFile = path.join(baseDir, '.welcomed');

    if (fs.existsSync(markerFile)) {
      return;
    }

    if (!fs.existsSync(baseDir)) {
      fs.mkdirSync(baseDir, { recursive: true });
    }

    fs.writeFileSync(markerFile, new Date().toISOString(), 'utf-8');

    const repoUrl = process.env.OPENCONTRIB_REPO_URL || 'https://github.com/MeiSiristhebest/opencontrib';

    console.log(`
┌────────────────────────────────────────────────────────┐
│  🚀 Welcome to OpenContrib!                            │
│  The Deterministic Open-Source Contribution Engine      │
│  for Autonomous AI Coding Agents.                      │
│                                                        │
│  ⭐ Star us on GitHub if this tool saves your time:     │
│     ${repoUrl.padEnd(50, ' ')} │
│                                                        │
│  💡 Tip: Run 'opencontrib doctor' to audit your setup. │
└────────────────────────────────────────────────────────┘
`);
  } catch {
    // Silently ignore any filesystem or environment errors
  }
}
