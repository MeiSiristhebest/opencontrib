import type { DefectCategory } from './types.js';

export interface FuzzTemplateSpec {
  category: DefectCategory;
  framework: 'fast-check' | 'hypothesis' | 'proptest' | 'go-quick';
  targetFunction: string;
  codeSnippet: string;
  reproAssertion: string;
}

export function generatePropertyTest(
  category: DefectCategory,
  language: 'typescript' | 'javascript' | 'python' | 'rust' | 'go',
  targetFunction = 'processInput',
): FuzzTemplateSpec {
  switch (language) {
    case 'typescript':
    case 'javascript':
      return generateFastCheckTest(category, targetFunction);
    case 'python':
      return generateHypothesisTest(category, targetFunction);
    case 'rust':
      return generateProptest(category, targetFunction);
    case 'go':
      return generateGoQuickTest(category, targetFunction);
  }
}

function generateFastCheckTest(category: DefectCategory, targetFn: string): FuzzTemplateSpec {
  if (category === 'numerical_bounds') {
    return {
      category,
      framework: 'fast-check',
      targetFunction: targetFn,
      codeSnippet: `import fc from 'fast-check';
import { test, expect } from 'vitest';
import { ${targetFn} } from '../src/index.js';

test('property: numerical bounds and special floats do not panic or yield invalid state', () => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.float({ noNaN: false }),
        fc.constant(NaN),
        fc.constant(-0.0),
        fc.constant(Infinity),
        fc.constant(-Infinity),
      ),
      (val) => {
        const result = ${targetFn}(val);
        expect(Number.isFinite(result) || result === null).toBe(true);
      }
    ),
    { numRuns: 100 }
  );
});`,
      reproAssertion: 'expect(Number.isFinite(result)).toBe(true)',
    };
  }

  if (category === 'protocol_drift' || category === 'security_cwe') {
    return {
      category,
      framework: 'fast-check',
      targetFunction: targetFn,
      codeSnippet: `import fc from 'fast-check';
import { test, expect } from 'vitest';
import { ${targetFn} } from '../src/index.js';

test('property: cross-platform path separators and CRLF newlines preserve invariants', () => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.string(),
        fc.constant('../../../etc/passwd'),
        fc.constant('..\\\\..\\\\windows\\\\win.ini'),
        fc.constant('line1\\r\\nline2\\r\\n'),
      ),
      (payload) => {
        const normalized = ${targetFn}(payload);
        expect(normalized).not.toContain('\\r');
        expect(normalized.startsWith('/') || !normalized.includes('..')).toBe(true);
      }
    )
  );
});`,
      reproAssertion: "expect(normalized).not.toContain('\\r')",
    };
  }

  // Default falsy/cache
  return {
    category,
    framework: 'fast-check',
    targetFunction: targetFn,
    codeSnippet: `import fc from 'fast-check';
import { test, expect } from 'vitest';
import { ${targetFn} } from '../src/index.js';

test('property: falsy values (false, 0, empty string, null) correctly hit cache', () => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.constant(false),
        fc.constant(0),
        fc.constant(''),
        fc.constant(null),
      ),
      (falsyVal) => {
        const first = ${targetFn}(falsyVal);
        const second = ${targetFn}(falsyVal);
        expect(first).toEqual(second);
      }
    )
  );
});`,
    reproAssertion: 'expect(first).toEqual(second)',
  };
}

function generateHypothesisTest(category: DefectCategory, targetFn: string): FuzzTemplateSpec {
  return {
    category,
    framework: 'hypothesis',
    targetFunction: targetFn,
    codeSnippet: `from hypothesis import given, strategies as st
import pytest
from my_module import ${targetFn}

@given(st.one_of(st.floats(allow_nan=True, allow_infinity=True), st.integers()))
def test_property_numerical_invariants(val):
    result = ${targetFn}(val)
    assert result is not None
    assert not (isinstance(result, float) and (result != result)) # No unexpected NaN leak
`,
    reproAssertion: 'assert not (result != result)',
  };
}

function generateProptest(category: DefectCategory, targetFn: string): FuzzTemplateSpec {
  return {
    category,
    framework: 'proptest',
    targetFunction: targetFn,
    codeSnippet: `use proptest::prelude::*;
use crate::${targetFn};

proptest! {
    #[test]
    fn test_property_bounds(val in proptest::num::f64::ANY) {
        let res = ${targetFn}(val);
        prop_assert!(!res.is_nan());
    }
}
`,
    reproAssertion: 'prop_assert!(!res.is_nan())',
  };
}

function generateGoQuickTest(category: DefectCategory, targetFn: string): FuzzTemplateSpec {
  return {
    category,
    framework: 'go-quick',
    targetFunction: targetFn,
    codeSnippet: `package main

import (
	"math"
	"testing"
	"testing/quick"
)

func TestProperty_${targetFn}(t *testing.T) {
	f := func(val float64) bool {
		res := ${targetFn}(val)
		// NaN check: NaN != NaN is the only expression that identifies NaN in Go
		return !(math.IsNaN(res))
	}
	if err := quick.Check(f, nil); err != nil {
		t.Errorf("Property failed: %v", err)
	}
}
`,
    reproAssertion: 'quick.Check(f, nil) == nil',
  };
}
