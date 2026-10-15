import { describe, it, expect } from 'bun:test';
import { DockerSandboxProvider, getAutoSandboxProvider, SanitizedLocalSandboxProvider } from '../src/sandbox/sandbox-runtime.js';
import { DockerExecutionWorker } from '../src/run/docker-execution-worker.js';

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

  it('instantiates DockerExecutionWorker with default and custom container options', () => {
    const worker = new DockerExecutionWorker();
    expect(worker).toBeDefined();

    const customWorker = new DockerExecutionWorker({
      image: 'rust:latest',
      timeoutMs: 120_000,
    });
    expect(customWorker).toBeDefined();
  });
});
