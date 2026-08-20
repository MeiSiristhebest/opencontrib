import { Command } from 'commander';
import { SmartPointerStore, type PointerView } from '@opencontrib/core';
import { printJSON } from '../utils/output.js';
import * as path from 'path';

export const pointerCommand = new Command('pointer')
  .alias('ptr')
  .description('Interact with and dereference OpenContrib Smart Pointers (ptr://...)');

pointerCommand
  .command('list [namespace]')
  .description('List all available smart pointers (Level 1 stub metadata)')
  .option('--pretty', 'Pretty-print JSON output', false)
  .action((namespace, opts) => {
    try {
      const store = new SmartPointerStore(path.join(process.cwd(), '.opencontrib', 'pointers'));
      const pointers = store.list(namespace);

      printJSON(
        {
          status: 'success',
          count: pointers.length,
          pointers: pointers.map((p) => p.stub),
        },
        opts.pretty,
      );
    } catch (err: any) {
      console.error(`❌ Failed to list pointers: ${err.message}`);
      process.exit(1);
    }
  });

pointerCommand
  .command('resolve <uri>')
  .description('Dereference a smart pointer with progressive views: stub (Level 1), slice (Level 2), evidence (Level 3)')
  .option('--view <view>', 'Dereferencing view: stub, slice, evidence, all', 'slice')
  .option('--pretty', 'Pretty-print JSON output', false)
  .action((uri, opts) => {
    try {
      const store = new SmartPointerStore(path.join(process.cwd(), '.opencontrib', 'pointers'));
      const result = store.resolve(uri, opts.view as PointerView);

      printJSON(
        {
          status: 'success',
          uri,
          view: opts.view,
          data: result,
        },
        opts.pretty,
      );
    } catch (err: any) {
      console.error(`❌ Failed to resolve pointer: ${err.message}`);
      process.exit(1);
    }
  });
