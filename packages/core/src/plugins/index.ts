import { PluginHost } from '../kernel/plugin-host.js';
import { ocrPlugin } from './plugin-ocr.js';
import { pioliumPlugin } from './plugin-piolium.js';
import { astGrepPlugin } from './plugin-ast-grep.js';
import { hotspotPlugin } from './plugin-hotspot.js';
import { fuzzPlugin } from './plugin-fuzz.js';
import { workflowPlugin } from './plugin-workflow.js';

export * from './plugin-ocr.js';
export * from './plugin-piolium.js';
export * from './plugin-ast-grep.js';
export * from './plugin-hotspot.js';
export * from './plugin-fuzz.js';
export * from './plugin-workflow.js';

export const BUILTIN_PLUGINS = [
  ocrPlugin,
  pioliumPlugin,
  astGrepPlugin,
  hotspotPlugin,
  fuzzPlugin,
  workflowPlugin,
];

/**
 * Creates and initializes a PluginHost with all standard built-in plugins registered
 */
export async function createDefaultPluginHost(
  options: { workspacePath?: string; pluginsDir?: string } = {},
): Promise<PluginHost> {
  const host = new PluginHost(options);
  for (const plugin of BUILTIN_PLUGINS) {
    await host.registerPlugin(plugin);
  }
  return host;
}
