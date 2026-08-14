import { RepoMemoryLedger, ProfileFlywheel } from '../packages/core/src/index.js';

const memory = new RepoMemoryLedger();
memory.recordSuccess('bytedance/flowgram.ai', {
  title: 'fix(utils): prevent falsy value cache bypass in ShortCache',
  issueNumber: 1160,
  prNumber: 1161,
  prUrl: 'https://github.com/bytedance/flowgram.ai/pull/1161'
});

const flywheel = new ProfileFlywheel();
flywheel.saveRecord({
  id: 'bytedance/flowgram.ai#1161',
  repoFullName: 'bytedance/flowgram.ai',
  issueNumber: 1160,
  issueTitle: 'createShortCache bypasses cache when value is falsy (false, 0, "")',
  prNumber: 1161,
  prUrl: 'https://github.com/bytedance/flowgram.ai/pull/1161',
  status: 'submitted',
  submittedAt: new Date().toISOString(),
  diffStat: '+20 -4 (2 files)',
  evidenceSummary: 'Subagent Maintainer review score: 96.8/100, 20x stress loops passed'
});

console.log('Flywheel synced successfully for PR #1161');
