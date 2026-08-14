import { RepoMemoryLedger, ProfileFlywheel } from '../packages/core/src/index.js';

const memory = new RepoMemoryLedger();
memory.recordSuccess('bytedance/flowgram.ai', {
  title: 'chore(ci): upgrade actions/checkout and actions/setup-node to v4',
  issueNumber: 1158,
  prNumber: 1159,
  prUrl: 'https://github.com/bytedance/flowgram.ai/pull/1159'
});

const flywheel = new ProfileFlywheel();
flywheel.saveRecord({
  id: 'bytedance/flowgram.ai#1159',
  repoFullName: 'bytedance/flowgram.ai',
  issueNumber: 1158,
  issueTitle: 'Upgrade deprecated actions/checkout@v3 and actions/setup-node@v3 to v4',
  prNumber: 1159,
  prUrl: 'https://github.com/bytedance/flowgram.ai/pull/1159',
  status: 'submitted',
  submittedAt: new Date().toISOString(),
  diffStat: '+4 -4 (2 files)',
  evidenceSummary: 'Passed full schema validation and workflow linting'
});

console.log('Flywheel synced successfully');
