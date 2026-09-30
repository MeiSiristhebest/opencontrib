export type MatrixDomain =
  | 'tabular_time_series'
  | 'text_chunking'
  | 'concurrency_stream'
  | 'general_data_structure';

export interface MatrixVariant {
  id: string;
  description: string;
  sampleCodeSnippet?: string;
}

export interface MatrixDimension {
  name: string;
  description: string;
  variants: MatrixVariant[];
}

export interface CombinatorialScenario {
  scenarioId: string;
  description: string;
  variantCombination: Record<string, string>;
  testTemplateSnippet: string;
  riskSurface: string;
}

export interface CombinatorialMatrixReport {
  domain: MatrixDomain;
  domainRationale: string;
  dimensions: MatrixDimension[];
  scenarios: CombinatorialScenario[];
  recommendedAssertions: string[];
}

export interface CombinatorialMatrixInput {
  modifiedFiles?: string[];
  diffText?: string;
  issueTitle?: string;
  issueBody?: string;
}

function detectDomain(input: CombinatorialMatrixInput): {
  domain: MatrixDomain;
  rationale: string;
} {
  const fullText = [
    input.issueTitle || '',
    input.issueBody || '',
    input.diffText || '',
    (input.modifiedFiles || []).join(' '),
  ].join(' ').toLowerCase();

  // Tabular / Time Series detection (Pandas, DataFrame, DatetimeIndex, ts_forecast, automl, numpy)
  if (
    /(?:datetimeindex|ts_forecast|time_series|dataframe|reindex|pandas|rangeindex|reset_index|resample|freq\b)/i.test(
      fullText,
    )
  ) {
    return {
      domain: 'tabular_time_series',
      rationale:
        'Detected tabular or time-series operations with Pandas/DataFrame. Index type mismatches (RangeIndex vs DatetimeIndex) and column name collisions are frequent defect sources.',
    };
  }

  // Text Chunking / NLP / Tokenization detection
  if (
    /(?:chunk|chunker|split_lines|tokenizer|max_tokens|token_count|delimiter|paragraph|all_resolved|text_chunker)/i.test(
      fullText,
    )
  ) {
    return {
      domain: 'text_chunking',
      rationale:
        'Detected text chunking or tokenization logic. Premature loop termination, delimiter starvation, and oversized unbroken text blocks are frequent defect sources.',
    };
  }

  // Concurrency / Stream / Async detection
  if (
    /(?:mutex|lock|semaphore|channel|goroutine|async|await|deadlock|race|concurrent|workerpool|ebusy)/i.test(
      fullText,
    )
  ) {
    return {
      domain: 'concurrency_stream',
      rationale:
        'Detected concurrency, streaming, or asynchronous resource access. Race collisions, locked file descriptors, and asymmetric cleanup are frequent defect sources.',
    };
  }

  return {
    domain: 'general_data_structure',
    rationale:
      'Standard general data structure. Boundary cases like empty collections, single elements, null/undefined, and extreme scale must be verified.',
  };
}

/**
 * Synthesizes a combinatorial matrix recommendation to prevent single-test complacency
 * and uncover multi-dimensional boundary defects before opening PRs.
 */
export function generateCombinatorialMatrix(
  input: CombinatorialMatrixInput,
): CombinatorialMatrixReport {
  const { domain, rationale } = detectDomain(input);

  if (domain === 'tabular_time_series') {
    const dimensions: MatrixDimension[] = [
      {
        name: 'FeatureFrameIndex',
        description: 'Index structure of the input feature frame (X)',
        variants: [
          {
            id: 'RangeIndex_with_ds_col',
            description: 'Standard RangeIndex with a timestamp column (e.g. ds)',
            sampleCodeSnippet: 'X = pd.DataFrame({"ds": dates, "val": np.arange(10)})',
          },
          {
            id: 'DatetimeIndex_direct',
            description: 'DataFrame directly indexed with DatetimeIndex',
            sampleCodeSnippet: 'X = pd.DataFrame({"val": np.arange(10)}, index=dates)',
          },
          {
            id: 'PeriodIndex',
            description: 'DataFrame indexed with PeriodIndex (e.g. monthly/daily periods)',
            sampleCodeSnippet: 'X = pd.DataFrame({"val": np.arange(10)}, index=periods)',
          },
        ],
      },
      {
        name: 'TargetSeriesIndex',
        description: 'Index structure of the target series (y)',
        variants: [
          {
            id: 'DatetimeIndex_matching',
            description: 'Target series indexed by exact matching timestamps',
            sampleCodeSnippet: 'y = pd.Series(np.arange(10), index=dates)',
          },
          {
            id: 'RangeIndex_positional',
            description: 'Target series indexed positionally (0..N-1)',
            sampleCodeSnippet: 'y = pd.Series(np.arange(10))',
          },
          {
            id: 'Misaligned_DatetimeIndex',
            description: 'Target series with datetime timestamps in different order or shifted window',
            sampleCodeSnippet: 'y = pd.Series(np.arange(10), index=dates[::-1])',
          },
        ],
      },
    ];

    const scenarios: CombinatorialScenario[] = [
      {
        scenarioId: 'FLAML_TRAP_RangeX_DateTimeY',
        description:
          'Features have RangeIndex with timestamp column, while Target has DatetimeIndex (FLAML PR #1614 regression trap).',
        variantCombination: {
          FeatureFrameIndex: 'RangeIndex_with_ds_col',
          TargetSeriesIndex: 'DatetimeIndex_matching',
        },
        testTemplateSnippet:
          'dates = pd.date_range("2024-01-01", periods=10, freq="D")\nX = pd.DataFrame({"ds": dates, "x": range(10)})\ny = pd.Series(range(10), index=dates)\n# assert no NaN or label mismatch after preparation',
        riskSurface:
          'reindex(X.index) without index alignment will fill target with all NaNs because RangeIndex != DatetimeIndex labels.',
      },
      {
        scenarioId: 'CANONICAL_DateTimeX_DateTimeY',
        description: 'Both Features and Target already share the identical DatetimeIndex.',
        variantCombination: {
          FeatureFrameIndex: 'DatetimeIndex_direct',
          TargetSeriesIndex: 'DatetimeIndex_matching',
        },
        testTemplateSnippet:
          'dates = pd.date_range("2024-01-01", periods=10, freq="D")\nX = pd.DataFrame({"x": range(10)}, index=dates)\ny = pd.Series(range(10), index=dates)',
        riskSurface:
          'Verify that direct promotion logic does not re-add or duplicate index columns or drop existing frequency attributes.',
      },
      {
        scenarioId: 'MISALIGNED_PERMUTED_INDEX',
        description: 'Target series has identical timestamps but in reversed or randomized order.',
        variantCombination: {
          FeatureFrameIndex: 'DatetimeIndex_direct',
          TargetSeriesIndex: 'Misaligned_DatetimeIndex',
        },
        testTemplateSnippet:
          'dates = pd.date_range("2024-01-01", periods=10, freq="D")\nX = pd.DataFrame({"x": range(10)}, index=dates)\ny = pd.Series(range(10), index=dates[::-1])',
        riskSurface:
          'Temporal ordering must be respected without silent data corruption or invalid forward-fill.',
      },
    ];

    return {
      domain,
      domainRationale: rationale,
      dimensions,
      scenarios,
      recommendedAssertions: [
        'assert not y_aligned.isna().any(), "Target alignment introduced unexpected NaNs"',
        'assert len(X_aligned) == len(y_aligned), "Row count changed after alignment"',
        'assert X_aligned.index.equals(y_aligned.index), "Index discrepancy between X and y"',
      ],
    };
  }

  if (domain === 'text_chunking') {
    const dimensions: MatrixDimension[] = [
      {
        name: 'TextScaleVsLimit',
        description: 'Input length relative to max token limit',
        variants: [
          {
            id: 'UnderLimit',
            description: 'Length well within max limit (e.g. 0.3x limit)',
          },
          {
            id: 'ExactBoundary',
            description: 'Length exactly equal to token limit',
          },
          {
            id: 'OverLimitNoDelimiters',
            description: 'Length > 3x limit with NO whitespace or linebreaks (unbreakable stream)',
          },
        ],
      },
      {
        name: 'DelimiterDensity',
        description: 'Presence and patterns of natural break delimiters',
        variants: [
          {
            id: 'NormalParagraphs',
            description: 'Standard paragraphs separated by double newlines',
          },
          {
            id: 'ConsecutiveDelimiters',
            description: 'Consecutive clustered delimiters (e.g. \\n\\n\\n\\n or multiple spaces)',
          },
          {
            id: 'SingleTokenDelimitersOnly',
            description: 'Punctuation-only breaks without whitespace (e.g. CJK punctuation 。！？)',
          },
        ],
      },
    ];

    const scenarios: CombinatorialScenario[] = [
      {
        scenarioId: 'SK_EARLY_EXIT_UNRESOLVED_TRAP',
        description:
          'Long text with nested sub-chunks where first chunk resolves but subsequent chunk exceeds token boundary (Semantic Kernel PR #14494 trap).',
        variantCombination: {
          TextScaleVsLimit: 'OverLimitNoDelimiters',
          DelimiterDensity: 'NormalParagraphs',
        },
        testTemplateSnippet:
          'text = ("Word " * 200) + "\\n\\n" + ("VeryLongContinuousString" * 50)\nchunks = chunker.split_lines(text, max_tokens=100)\nassert all(len(c) <= 100 for c in chunks)',
        riskSurface:
          'Premature loop exit caused by returning all_resolved=True when a subsequent chunk was only partially partitioned.',
      },
      {
        scenarioId: 'EMPTY_AND_WHITESPACE_ONLY',
        description: 'Input containing only delimiters or empty string.',
        variantCombination: {
          TextScaleVsLimit: 'UnderLimit',
          DelimiterDensity: 'ConsecutiveDelimiters',
        },
        testTemplateSnippet:
          'assert chunker.split_lines("", max_tokens=100) == []\nassert chunker.split_lines("\\n\\n\\n", max_tokens=100) == []',
        riskSurface: 'Off-by-one errors or infinite recursion on empty remainder strings.',
      },
    ];

    return {
      domain,
      domainRationale: rationale,
      dimensions,
      scenarios,
      recommendedAssertions: [
        'assert all(token_len(c) <= max_tokens for c in chunks), "Chunk exceeded max token bound"',
        'assert "".join(chunks).replace(" ", "") == original.replace(" ", ""), "Data loss detected during chunking"',
      ],
    };
  }

  // Concurrency & Stream domain
  if (domain === 'concurrency_stream') {
    const dimensions: MatrixDimension[] = [
      {
        name: 'WorkerConcurrency',
        description: 'Degree of concurrent readers/writers',
        variants: [
          { id: 'SingleThread', description: 'Sequential execution (1 worker)' },
          { id: 'HighContention', description: 'Massive contention (20+ concurrent workers)' },
        ],
      },
      {
        name: 'LifecycleInterruption',
        description: 'Premature cancellation or failure during execution',
        variants: [
          { id: 'GracefulComplete', description: 'All workers finish cleanly' },
          { id: 'MidStreamAbort', description: 'Context canceled or process killed mid-operation' },
        ],
      },
    ];

    return {
      domain,
      domainRationale: rationale,
      dimensions,
      scenarios: [
        {
          scenarioId: 'WINDOWS_EBUSY_HANDLE_RACE',
          description:
            'Rapid process spawning and immediate cleanup on Windows (OCR PR #1583 launcher trap).',
          variantCombination: {
            WorkerConcurrency: 'HighContention',
            LifecycleInterruption: 'MidStreamAbort',
          },
          testTemplateSnippet:
            '// Spawn subprocess, kill immediately, verify unlink does not throw EBUSY\nconst proc = spawn("...");\nproc.kill();\nawait waitForProcessExit(proc);\nrmSync(testDir, { recursive: true });',
          riskSurface:
            'Windows holding process handle open causing EBUSY unlink errors during test teardown.',
        },
      ],
      recommendedAssertions: [
        'expect(leakChecker.hasDanglingHandles()).toBe(false)',
        'expect(raceDetector.collisions).toBe(0)',
      ],
    };
  }

  // General boundary domain
  return {
    domain,
    domainRationale: rationale,
    dimensions: [
      {
        name: 'BoundaryScales',
        description: 'Input collection cardinality and boundary values',
        variants: [
          { id: 'Empty', description: 'Zero elements (empty array/map/string)' },
          { id: 'Single', description: 'Exactly one element' },
          { id: 'Extreme', description: 'Large input scale (>10,000 items)' },
        ],
      },
      {
        name: 'Nullability',
        description: 'Presence of null, undefined, or missing optional values',
        variants: [
          { id: 'FullyPopulated', description: 'All optional fields present' },
          { id: 'NullOptionals', description: 'All optional fields null or undefined' },
        ],
      },
    ],
    scenarios: [
      {
        scenarioId: 'EMPTY_COLLECTION_SAFETY',
        description: 'Verify system behaves deterministically on empty input without throwing NPE or IndexError.',
        variantCombination: {
          BoundaryScales: 'Empty',
          Nullability: 'NullOptionals',
        },
        testTemplateSnippet: 'expect(handleInput([])).toEqual([])',
        riskSurface: 'Unchecked index access [0] on empty collections.',
      },
      {
        scenarioId: 'SINGLETON_ELEMENT_INTEGRITY',
        description: 'Verify singleton inputs do not trigger divide-by-zero or slice off-by-one errors.',
        variantCombination: {
          BoundaryScales: 'Single',
          Nullability: 'FullyPopulated',
        },
        testTemplateSnippet: 'expect(handleInput([singleItem])).toEqual([singleItem])',
        riskSurface: 'Loops expecting >1 item failing on single-element bounds.',
      },
    ],
    recommendedAssertions: [
      'expect(result).toBeDefined()',
      'expect(() => execute(emptyInput)).not.toThrow()',
    ],
  };
}
