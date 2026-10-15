import { describe, expect, it } from 'bun:test';
import { deriveCollaborationPlaybook } from '../src/domain/collaboration-playbook.js';
import { qualifyIssue } from '../src/domain/qualification.js';

describe('Collaboration Playbook Engine & Anti-Poaching System', () => {
  it('selects Playbook 1 (Supportive Co-Authoring) when author expresses PR intent', () => {
    const playbook = deriveCollaborationPlaybook({
      isOpen: true,
      hasExistingPr: false,
      hasClaimant: false,
      authorFirstRightActive: true,
      authorLogin: 'YewFence',
      issueNumber: 10947,
      issueTitle: 'isProjectTrusted() ignores saved Do-not-trust decisions',
    });

    expect(playbook.playbook).toBe('supportive_coauthor');
    expect(playbook.title).toContain('Playbook 1');
    expect(playbook.coAuthorAttribution).toBeDefined();
    expect(playbook.coAuthorAttribution?.suggestedGitTrailer).toContain('Co-authored-by: @YewFence');
    expect(playbook.commentDraft).toContain('Hi @YewFence');
    expect(playbook.commentDraft).toContain('Co-authored-by: @YewFence');
  });

  it('selects Playbook 2 (Graceful Watchdog) when issue is claimed by another contributor', () => {
    const playbook = deriveCollaborationPlaybook({
      isOpen: true,
      hasExistingPr: false,
      hasClaimant: true,
      claimantDetails: '@alice active claim (3 days ago)',
      authorFirstRightActive: false,
      authorLogin: 'bob',
    });

    expect(playbook.playbook).toBe('graceful_watchdog');
    expect(playbook.title).toContain('Playbook 2');
    expect(playbook.rationale).toContain('30 天保护期');
  });

  it('selects Playbook 3 (Autonomous Strike) when issue is completely unclaimed and open', () => {
    const playbook = deriveCollaborationPlaybook({
      isOpen: true,
      hasExistingPr: false,
      hasClaimant: false,
      authorFirstRightActive: false,
      authorLogin: 'reporter',
    });

    expect(playbook.playbook).toBe('autonomous_strike');
    expect(playbook.title).toContain('Playbook 3');
    expect(playbook.actionableSteps[0]).toContain('RED 测试');
  });

  it('selects Playbook 4 (Sibling Variant Extension) when PR exists but lacks variants', () => {
    const playbook = deriveCollaborationPlaybook({
      isOpen: true,
      hasExistingPr: true,
      hasClaimant: false,
      authorFirstRightActive: false,
      hasVariantGap: true,
    });

    expect(playbook.playbook).toBe('variant_extension');
    expect(playbook.title).toContain('Playbook 4');
  });

  it('integrates seamlessly with qualifyIssue and returns actionable collaboration playbook', () => {
    const qualification = qualifyIssue({
      issueNumber: 10947,
      issueTitle: 'isProjectTrusted() ignores saved Do-not-trust decisions',
      issueBody: 'With no trust-requiring resources, store is never consulted. I am happy to submit a PR for that.',
      labels: ['bug'],
      isOpen: true,
      assignees: [],
      createdAt: new Date().toISOString(),
      authorLogin: 'YewFence',
      comments: [],
    });

    expect(qualification.isQualified).toBe(false);
    expect(qualification.authorFirstRightActive).toBe(true);
    expect(qualification.collaborationPlaybook).toBeDefined();
    expect(qualification.collaborationPlaybook?.playbook).toBe('supportive_coauthor');
    expect(qualification.collaborationPlaybook?.coAuthorAttribution?.suggestedGitTrailer).toContain('@YewFence');
  });
});
