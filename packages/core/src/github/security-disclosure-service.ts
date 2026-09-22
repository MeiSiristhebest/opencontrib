import {
  SecurityDisclosureArtifactSchema,
  type SecurityDisclosureArtifact,
} from "../contracts/schemas.js";
import type { ContributionRunManager } from "../run/run-manager.js";
import { saveCanonicalArtifact } from "../run/canonical-writer.js";

export interface SecurityPolicyProvider {
  getRepoTextFile(owner: string, repo: string, path: string): Promise<string | null>;
}

export interface VerifySecurityDisclosureInput {
  runId: string;
  repoFullName: string;
}

/**
 * Verifies the repository's private security channel through the provider and
 * records a fail-closed disclosure decision. Discovering SECURITY.md never
 * grants permission to publish a public issue or pull request.
 */
export class SecurityDisclosureService {
  constructor(
    private readonly runManager: ContributionRunManager,
    private readonly provider: SecurityPolicyProvider,
  ) {}

  async verifyPrivateChannel(
    input: VerifySecurityDisclosureInput,
  ): Promise<SecurityDisclosureArtifact> {
    const run = this.runManager.getRun(input.runId);
    if (!run) throw new Error(`Contribution run ${input.runId} does not exist`);
    if (run.manifest.repoFullName.toLowerCase() !== input.repoFullName.toLowerCase()) {
      throw new Error(
        "SecurityDisclosureTargetMismatchError: repository does not match the canonical run.",
      );
    }

    const existing = SecurityDisclosureArtifactSchema.safeParse(
      run.artifacts.securityDisclosure,
    );

    const [owner, repo] = input.repoFullName.split("/");
    if (!owner || !repo) {
      throw new Error("SecurityDisclosureInputError: repoFullName must be owner/repo.");
    }

    let policyContent: string | null = null;
    for (const policyPath of ["SECURITY.md", ".github/SECURITY.md"]) {
      policyContent = await this.provider.getRepoTextFile(owner, repo, policyPath);
      if (policyContent) break;
    }
    if (!policyContent || !/(?:private|security|vulnerabilit|contact)/i.test(policyContent)) {
      throw new Error(
        "SecurityDisclosureProviderError: provider did not return a verifiable private security channel.",
      );
    }

    const artifact = SecurityDisclosureArtifactSchema.parse({
      runId: input.runId,
      provider: "github",
      repoFullName: input.repoFullName,
      channel: "github_security_policy",
      channelUrl: `https://github.com/${input.repoFullName}/security/policy`,
      providerVerified: true,
      publicDisclosureAllowed: false,
      verifiedAt: new Date().toISOString(),
    });
    if (existing.success) {
      if (
        existing.data.runId !== artifact.runId ||
        existing.data.provider !== artifact.provider ||
        existing.data.repoFullName.toLowerCase() !== artifact.repoFullName.toLowerCase() ||
        existing.data.channel !== artifact.channel ||
        existing.data.channelUrl !== artifact.channelUrl ||
        existing.data.providerVerified !== true ||
        existing.data.publicDisclosureAllowed !== artifact.publicDisclosureAllowed
      ) {
        throw new Error(
          "SecurityDisclosureImmutableError: the stored disclosure record does not match the current provider policy.",
        );
      }
      return existing.data;
    }
    saveCanonicalArtifact(
      this.runManager,
      input.runId,
      "security_disclosure",
      artifact as any,
    );
    return artifact;
  }

  assertPublicSubmissionAllowed(runId: string): void {
    const run = this.runManager.getRun(runId);
    if (!run) throw new Error(`Contribution run ${runId} does not exist`);
    const workspace = run.artifacts.workspace as
      | { communityGate?: { policy?: { privateVulnerabilityDisclosure?: boolean } } }
      | undefined;
    if (!workspace?.communityGate?.policy?.privateVulnerabilityDisclosure) return;

    const disclosure = SecurityDisclosureArtifactSchema.safeParse(
      run.artifacts.securityDisclosure,
    );
    if (!disclosure.success || disclosure.data.providerVerified !== true) {
      throw new Error(
        "SecurityDisclosureRequiredError: private disclosure policy requires provider-verified security channel evidence before submission.",
      );
    }
    if (disclosure.data.publicDisclosureAllowed !== true) {
      throw new Error(
        "PublicDisclosureBlockedError: repository requires private vulnerability disclosure; public submission is not authorized.",
      );
    }
  }
}
