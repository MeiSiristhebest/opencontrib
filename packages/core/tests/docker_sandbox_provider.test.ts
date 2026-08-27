import { describe, it, expect } from 'bun:test';
import { DockerSandboxProvider, getAutoSandboxProvider, SanitizedLocalSandboxProvider } from '../src/sandbox/sandbox-runtime.js';

describe('Docker Sandbox Provider & Auto Provider Selection', () => {
  it('instantiates DockerSandboxProvider with correct properties', () => {
    const provider = new DockerSandboxProvider();
    expect(provider.name).toBe('docker_container');
    const avail = provider.getAvailability();
    expect(typeof avail.available).toBe('boolean');
    expect(['CONTAINER_ISOLATION', 'UNAVAILABLE']).toContain(avail.isolationMode);
  });

  it('selects appropriate auto sandbox provider', () => {
    const provider = getAutoSandboxProvider(false);
    expect(provider).toBeInstanceOf(SanitizedLocalSandboxProvider);
  });
});
