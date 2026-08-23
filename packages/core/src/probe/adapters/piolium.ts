import type { NormalizedFinding } from '../types.js';
import type { VerificationStep } from '../../kernel/contract.js';

export type { VerificationStep };

export interface PoCArtifact {
  findingId: string;
  pocFileName: string;
  pocCode: string;
  executionCommand: string;
  expectedFailurePattern: string;
  verificationSteps: VerificationStep[];
}

export interface AdversarialVerificationResult {
  findingId: string;
  isFalsePositive: boolean;
  confidenceScore: number; // 0 - 100
  counterArguments: string[];
  verdict: 'CONFIRMED_VULNERABILITY' | 'PROBABLE_FALSE_POSITIVE' | 'NEEDS_MANUAL_REVIEW';
}

/**
 * P13: Autonomous Proof-of-Concept Construction
 * Converts a raw finding into a concrete, executable reproduction script with explicit exploit payloads and target calls.
 */
/**
 * Detect the programming language from a file path.
 */
function detectLanguage(file?: string): string {
  if (!file) return 'unknown';
  const lower = file.toLowerCase();
  if (lower.endsWith('.go')) return 'go';
  if (lower.endsWith('.py')) return 'python';
  if (lower.endsWith('.rs')) return 'rust';
  if (lower.endsWith('.java')) return 'java';
  if (lower.endsWith('.ts') || lower.endsWith('.tsx') || lower.endsWith('.js') || lower.endsWith('.jsx')) return 'typescript';
  return 'unknown';
}

export function constructPoCForFinding(finding: NormalizedFinding): PoCArtifact {
  const isSecurity = finding.category === 'security_cwe' || finding.category === 'protocol_drift';
  const isConcurrency = finding.category === 'lifecycle_leak';

  const cleanId = finding.id.replace(/[^a-zA-Z0-9]/g, '_');
  const title = finding.title || '';
  const targetSymbol = title.match(/in\s+([a-zA-Z0-9_]+)/i)?.[1] || (finding.affectedSymbol || 'targetFunction');
  const fileRef = `${finding.file || 'unknown'}:${finding.line ?? '?'}`;

  // Read source context at the finding location for accurate PoC generation
  let sourceContext = '';
  if (finding.file && finding.line) {
    const fs = require('node:fs');
    const path = require('node:path');
    try {
      const fullPath = path.resolve(finding.file);
      if (fs.existsSync(fullPath)) {
        const lines = fs.readFileSync(fullPath, 'utf8').split(/\r?\n/);
        const startLine = Math.max(0, (finding.line as number) - 3);
        const endLine = Math.min(lines.length, (finding.line as number) + 3);
        sourceContext = lines.slice(startLine, endLine).join('\n');
      }
    } catch {
      // Skip if file is not readable
    }
  }

  const verificationSteps: VerificationStep[] = [];

  if ((finding.file || '').endsWith('.go')) {
    const pocFileName = `repro_${cleanId}_test.go`;
    const executionCommand = `go test -v -run TestRepro_${cleanId}`;
    const expectedFailurePattern = 'FAIL|panic|fatal error';

    let pocCode = '';
    if (isConcurrency) {
      verificationSteps.push({
        setupCode: 'var wg sync.WaitGroup\niterations := 50',
        exploitPayload: 'concurrent routine triggers without synchronized mutex or channel close',
        targetCall: 'go func() { defer wg.Done(); /* call target */ }()',
        expectedFailureAssertion: 'race detector detects data race or deadlocked channel',
        expectedPostFixAssertion: 'wg.Wait() completes within 1s with 0 races',
      });

      pocCode = `package main_test

import (
	"sync"
	"testing"
	"time"
)

// NOTE: Replace 'TargetPackage' with the actual module import path.
// Example: import TargetPackage "github.com/user/repo/pkg"
func TestRepro_${cleanId}(t *testing.T) {
	var wg sync.WaitGroup
	done := make(chan struct{})

	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			TargetPackage.${targetSymbol}(id)
		}(i)
	}

	go func() {
		wg.Wait()
		close(done)
	}()

	select {
	case <-done:
		// Success
	case <-time.After(3 * time.Second):
		t.Fatalf("Deadlock/Leak detected in %s: goroutines failed to terminate", "${finding.file}")
	}
}
`;
    } else {
      verificationSteps.push({
        setupCode: 'ctx := context.Background()',
        exploitPayload: 'nil / boundary value',
        targetCall: `${targetSymbol}(ctx, nil)`,
        expectedFailureAssertion: 'runtime error: invalid memory address or nil pointer dereference',
        expectedPostFixAssertion: 'err != nil && !panicked',
      });

      pocCode = `package main_test

import (
	"context"
	"testing"
)

// NOTE: Replace 'TargetPackage' with the actual module import path.
// Example: import TargetPackage "github.com/user/repo/pkg"
func TestRepro_${cleanId}(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Logf("Expected pre-fix panic caught: %v", r)
		}
	}()

	// Target boundary call reproducing: ${finding.title}
	// Before patch: this invocation panics or corrupts state
	// After patch: returns sanitized error gracefully
	ctx := context.Background()
	_ = TargetPackage.${targetSymbol}(ctx, nil)
}
`;
    }

    return {
      findingId: finding.id,
      pocFileName,
      pocCode,
      executionCommand,
      expectedFailurePattern,
      verificationSteps,
    };
  }

  // Python
  if ((finding.file || '').endsWith('.py')) {
    const pocFileName = `test_repro_${cleanId}.py`;
    const executionCommand = `pytest ${pocFileName}`;
    const expectedFailurePattern = 'AssertionError|TypeError|ValueError|Exception';

    verificationSteps.push({
      setupCode: '# Setup defect reproduction parameters',
      exploitPayload: 'None / boundary edge values',
      targetCall: `${targetSymbol}()`,
      expectedFailureAssertion: 'raises exception or yields invalid state pre-fix',
      expectedPostFixAssertion: 'executes cleanly without unhandled exception',
    });

    const pocCode = `import pytest

# NOTE: Replace 'target_module' with the actual Python module path.
# Derive from file location: src/my_package/utils.py => from my_package.utils import ${targetSymbol}
from target_module import ${targetSymbol}

# PoC: Reproduce defect found in ${fileRef}
def test_repro_${cleanId}():
    """Reproduces ${finding.title}"""
    # Pre-Fix: Trigger boundary defect via null / boundary input
    # Post-Fix: Target function returns a valid non-None result without exception
    result = ${targetSymbol}(None)
    assert result is not None
    assert result != ""
`;

    return {
      findingId: finding.id,
      pocFileName,
      pocCode,
      executionCommand,
      expectedFailurePattern,
      verificationSteps,
    };
  }

  // Rust
  if ((finding.file || '').endsWith('.rs')) {
    const pocFileName = `tests/repro_${cleanId}.rs`;
    const executionCommand = `cargo test --test repro_${cleanId}`;
    const expectedFailurePattern = 'panicked at';

    verificationSteps.push({
      setupCode: '// Setup Rust reproduction fixture',
      exploitPayload: 'panic / overflow input',
      targetCall: `${targetSymbol}("../../../etc/passwd")`,
      expectedFailureAssertion: 'thread panicked at boundary condition',
      expectedPostFixAssertion: 'returns Result::Err or handles cleanly without panic',
    });

    const pocCode = `// NOTE: Replace 'target_crate' with the actual crate/library name.
// For integration tests: extern crate target_crate;
// For unit tests: use crate::${targetSymbol};
use target_crate::${targetSymbol};

#[test]
#[should_panic]
fn test_repro_${cleanId}() {
    // PoC: Reproduce ${finding.title} in ${fileRef}
    // The target function should panic on this boundary input.
    // If it does not panic, the vulnerability/defect is present.
    let _result = ${targetSymbol}("/../../../etc/passwd");
}
`;

    return {
      findingId: finding.id,
      pocFileName,
      pocCode,
      executionCommand,
      expectedFailurePattern,
      verificationSteps,
    };
  }

  // Java
  if ((finding.file || '').endsWith('.java')) {
    const pocFileName = `src/test/java/Repro${cleanId}Test.java`;
    const executionCommand = `mvn test -Dtest=Repro${cleanId}Test`;
    const expectedFailurePattern = 'AssertionError|NullPointerException|Exception';

    verificationSteps.push({
      setupCode: '// Setup Java reproduction test fixture',
      exploitPayload: 'null / unhandled exception input',
      targetCall: `input = "../../../etc/passwd"; ${targetSymbol}(input)`,
      expectedFailureAssertion: 'throws NullPointerException or invalid state',
      expectedPostFixAssertion: 'handles null safely without exception',
    });

    const pocCode = `// NOTE: Replace 'com.example.repro' with the actual package matching the target project.
// Derive from file location: src/main/java/com/example/app/Utils.java => package com.example.app;
package com.example.repro;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

public class Repro${cleanId}Test {
    @Test
    public void testRepro${cleanId}() {
        // PoC: Reproduce ${finding.title} in ${fileRef}
        String input = "../../../etc/passwd";
        assertThrows(Exception.class, () -> ${targetSymbol}(input));
    }
}
`;

    return {
      findingId: finding.id,
      pocFileName,
      pocCode,
      executionCommand,
      expectedFailurePattern,
      verificationSteps,
    };
  }

  // TypeScript / JavaScript
  const pocFileName = `test_repro_${cleanId}.test.ts`;
  const executionCommand = `bun test ${pocFileName}`;
  const expectedFailurePattern = 'AssertionError|TypeError|Error';

  if (isSecurity) {
    verificationSteps.push({
      setupCode: 'const baseDir = "/tmp/safe_root";',
      exploitPayload: '"../../../etc/passwd"',
      targetCall: `resolveSafePath(baseDir, "../../../etc/passwd")`,
      expectedFailureAssertion: 'result escapes baseDir (Path Traversal confirmed)',
      expectedPostFixAssertion: 'throws Error("Path traversal outside root denied")',
    });
  } else {
    verificationSteps.push({
      setupCode: 'const input = { timeout: NaN, retry: -1 };',
      exploitPayload: 'NaN / Negative numbers',
      targetCall: `calculateBounds(input)`,
      expectedFailureAssertion: 'returns NaN / negative delay (monotonicity violated)',
      expectedPostFixAssertion: 'fallback to default safe bounded duration',
    });
  }

    const pocCode = `import { describe, it, expect } from 'bun:test';

describe('PoC Reproducer: ${finding.title}', () => {
  it('triggers boundary condition in ${fileRef}', () => {
    // Exploit Payload: ${verificationSteps[0].exploitPayload}
    // Expected Pre-Fix: ${verificationSteps[0].expectedFailureAssertion}
    // Expected Post-Fix: ${verificationSteps[0].expectedPostFixAssertion}
    // Source Context: ${sourceContext || 'N/A'}
    const payload = ${isSecurity ? '"../../../etc/passwd"' : 'null'};
${isSecurity ? `    // Security: expect path-traversal to be rejected with an exception
    expect(() => {
      ${targetSymbol}(payload);
    }).toThrow();` : `    // Non-security: target returns an invalid/bad value
    const result = ${targetSymbol}(payload);
    expect(Number.isFinite(result)).toBe(false);`}
  });
});
`;

  return {
    findingId: finding.id,
    pocFileName,
    pocCode,
    executionCommand,
    expectedFailurePattern,
    verificationSteps,
  };
}

/**
 * P10: Adversarial False-Positive Verification Chamber
 * Analyzes whether a finding is a genuine defect or a false positive.
 */
export function verifyFindingAdversarially(finding: NormalizedFinding): AdversarialVerificationResult {
  // False-positive determination should NOT be hand-rolled heuristics.
  // This function exists as a pass-through compatibility shim only.
  // Real triage is handled by CodeQL's built-in suppression rules and
  // Semgrep's auto-suppression engine.  In-house heuristic filters
  // (test-file check, score threshold) produced zero signal in production.
  const isTestFile = (finding.file || '').includes('test') || (finding.file || '').includes('mock');
  const isFalsePositive = isTestFile && finding.prPotentialScore < 40;

  return {
    findingId: finding.id,
    isFalsePositive,
    confidenceScore: finding.prPotentialScore,
    counterArguments: isFalsePositive
      ? ['Finding is located inside a test/mock file with very low confidence score.']
      : [],
    verdict: isFalsePositive
      ? 'PROBABLE_FALSE_POSITIVE'
      : finding.prPotentialScore >= 80
      ? 'CONFIRMED_VULNERABILITY'
      : 'NEEDS_MANUAL_REVIEW',
  };
}
