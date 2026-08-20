import { Command } from 'commander';
import {
  createDefaultPluginHost,
  AutonomousPoCVerifier,
  type PointerStub,
} from '@opencontrib/core';
import { printJSON } from '../utils/output.js';
import * as path from 'path';

export const verifyCommand = new Command('verify')
  .description('Verify a discovered finding pointer in an isolated clean-room worktree sandbox')
  .argument('<pointerUri>', 'Smart Pointer URI to verify (e.g. ptr://findings/...)')
  .option('-w, --workspace <path>', 'Path to target repository workspace', '.')
  .option('-c, --command <testCmd>', 'Custom test runner command')
  .option('--pretty', 'Pretty-print JSON output', false)
  .action(async (pointerUri: string, opts) => {
    try {
      const resolved = path.resolve(opts.workspace);
      const host = await createDefaultPluginHost({ workspacePath: resolved });

      // Dereference pointer from store or construct synthetic verification target
      const stub = host.pointers.resolve(pointerUri);

      const targetFinding: PointerStub = stub || {
        namespace: 'findings',
        id: pointerUri.replace(/^ptr:\/\/[^/]+\//, ''),
        title: `Verification target: ${pointerUri}`,
        category: 'protocol_drift',
        severity: 'medium',
        file: 'src/index.ts',
        line: 1,
        confidence: 90,
      };

      console.log(`🧪 Initiating clean-room verification for ${pointerUri}...`);

      const report = await AutonomousPoCVerifier.verifyFinding(resolved, targetFinding, {
        testCommand: opts.command,
      });

      printJSON(
        {
          status: 'success',
          verification: report,
        },
        opts.pretty,
      );
    } catch (err: any) {
      console.error(`❌ Verification failed: ${err.message}`);
      process.exit(1);
    }
  });
