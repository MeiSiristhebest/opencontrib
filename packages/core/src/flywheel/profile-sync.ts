import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { ContributionRecord } from '../contracts/schemas.js';

export class ProfileFlywheel {
  private ledgerPath: string;

  constructor() {
    const dir = join(homedir(), '.opencontrib');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.ledgerPath = join(dir, 'contributions.json');
  }

  loadRecords(): ContributionRecord[] {
    if (!existsSync(this.ledgerPath)) return [];
    try {
      return JSON.parse(readFileSync(this.ledgerPath, 'utf-8'));
    } catch {
      return [];
    }
  }

  saveRecord(record: ContributionRecord): void {
    const records = this.loadRecords();
    const existingIndex = records.findIndex((r) => r.id === record.id || (r.prUrl && r.prUrl === record.prUrl));
    if (existingIndex >= 0) {
      records[existingIndex] = record;
    } else {
      records.unshift(record);
    }
    writeFileSync(this.ledgerPath, JSON.stringify(records, null, 2), 'utf-8');
  }

  renderProfileMarkdown(records: ContributionRecord[] = this.loadRecords()): string {
    if (records.length === 0) {
      return `<!-- START_OPENCONTRIB_SECTION -->
### 🚀 Open Source Contributions
*No contributions recorded yet. Run \`contrib_scout\` or \`contrib_probe\` to begin!*
<!-- END_OPENCONTRIB_SECTION -->`;
    }

    const mergedCount = records.filter((r) => r.status === 'merged').length;
    const activeCount = records.filter((r) => r.status === 'in_review' || r.status === 'submitted').length;

    let md = `<!-- START_OPENCONTRIB_SECTION -->
### 🚀 Open Source Contributions (Live Flywheel)

> **Total PRs**: ${records.length} | **Merged**: 🌟 ${mergedCount} | **Active**: ⏳ ${activeCount}

| Repository | Issue / Contribution | PR | Status | Submitted |
| :--- | :--- | :--- | :--- | :--- |
`;

    for (const r of records.slice(0, 10)) {
      const statusIcon = r.status === 'merged' ? '🟣 **Merged**' : r.status === 'in_review' ? '🟡 **In Review**' : '🟢 **Open**';
      const issueText = r.issueNumber ? `#${r.issueNumber} ${r.issueTitle}` : r.issueTitle;
      const prText = r.prNumber ? `#${r.prNumber}` : 'View PR';
      md += `| [\`${r.repoFullName}\`](https://github.com/${r.repoFullName}) | ${issueText} | [${prText}](${r.prUrl}) | ${statusIcon} | \`${r.submittedAt.split('T')[0]}\` |\n`;
    }

    md += `\n*Updated automatically via [OpenContrib Engine](https://github.com/NianJiuZst/openmeta-cli)*\n<!-- END_OPENCONTRIB_SECTION -->`;

    return md;
  }

  renderBadgeSvg(records: ContributionRecord[] = this.loadRecords()): string {
    const mergedCount = records.filter((r) => r.status === 'merged').length;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="28" viewBox="0 0 180 28" fill="none">
  <rect width="180" height="28" rx="6" fill="#18181B"/>
  <text x="12" y="18" fill="#A1A1AA" font-family="system-ui, -apple-system, sans-serif" font-size="12" font-weight="500">OpenContrib</text>
  <rect x="95" y="4" width="75" height="20" rx="4" fill="#8B5CF6"/>
  <text x="132" y="18" fill="#FFFFFF" font-family="system-ui, -apple-system, sans-serif" font-size="12" font-weight="700" text-anchor="middle">★ ${mergedCount} Merged</text>
</svg>`;
  }
}
