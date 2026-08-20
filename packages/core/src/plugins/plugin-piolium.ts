import type { OpenContribPlugin, PluginContext } from '../kernel/contract.js';
import { constructPoCForFinding, verifyFindingAdversarially } from '../probe/adapters/piolium.js';

export const pioliumPlugin: OpenContribPlugin = {
  name: '@opencontrib/plugin-piolium',
  version: '1.0.0',
  description: 'Vigolium Piolium 17-Phase adversarial audit and autonomous PoC constructor',
  activate: (ctx: PluginContext) => {
    ctx.probes.register({
      id: 'piolium',
      name: 'Vigolium Piolium Audit & PoC',
      category: 'security_cwe',
      description: 'Generates runnable reproduction PoCs and verifies findings with adversarial chambers',
      match: (fp) => {
        // Can run on any repository with test suites or code
        return fp.totalFiles > 0;
      },
      scan: async (targetPath, pointers, host) => {
        // When findings exist in pointer store, generate PoC artifacts for them
        const existingFindings = pointers.list('findings');
        for (const findingPtr of existingFindings) {
          const finding = {
            id: findingPtr.stub.id,
            probeName: 'piolium',
            category: findingPtr.stub.category,
            title: findingPtr.stub.title,
            description: findingPtr.slice?.ruleExplanation || '',
            file: findingPtr.stub.file,
            line: findingPtr.stub.line,
            severity: findingPtr.stub.severity,
            prPotentialScore: findingPtr.stub.confidence,
          };

          const poc = constructPoCForFinding(finding);
          const adv = verifyFindingAdversarially(finding);

          pointers.create({
            namespace: 'poc',
            id: `poc-${findingPtr.stub.id}`,
            title: `Reproducible Fail-First PoC for ${findingPtr.stub.title}`,
            category: findingPtr.stub.category,
            severity: findingPtr.stub.severity,
            file: poc.pocFileName,
            line: 1,
            confidence: adv.confidenceScore,
            slice: {
              codeSnippet: poc.pocCode,
              remediationSuggestion: `Run command: ${poc.executionCommand}`,
            },
            evidence: {
              pocCode: poc.pocCode,
              pocFileName: poc.pocFileName,
              executionCommand: poc.executionCommand,
              expectedFailurePattern: poc.expectedFailurePattern,
              rawPayload: adv as any,
            },
          });
        }
      },
    });
  },
};
