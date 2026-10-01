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
  primaryLanguage?: string;
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

  // Concurrency / Stream / Async detection
  if (
    /\b(?:mutex|locks?|semaphores?|channels?|goroutines?|async|await|asynchronous|deadlocks?|races?|concurrency|concurrent|worker[\s-]*pool|stream(?:s|ing)?|ebusy)\b/i.test(
      fullText,
    )
  ) {
    return {
      domain: 'concurrency_stream',
      rationale:
        'Detected concurrency, streaming, or asynchronous resource access. Race collisions, locked file descriptors, and asymmetric cleanup are frequent defect sources.',
    };
  }

  // Text Chunking / NLP / Tokenization detection
  if (
    /\b(?:chunk(?:s|er|ing)?|split_lines|tokenizer|tokenization|nlp|max_tokens|token_count|delimiter|paragraph|all_resolved|text_chunker)\b/i.test(
      fullText,
    )
  ) {
    return {
      domain: 'text_chunking',
      rationale:
        'Detected text chunking or tokenization logic. Premature loop termination, delimiter starvation, and oversized unbroken text blocks are frequent defect sources.',
    };
  }

  return {
    domain: 'general_data_structure',
    rationale:
      'Standard general data structure. Boundary cases like empty collections, single elements, null/undefined, and extreme scale must be verified.',
  };
}

type MatrixTemplateLanguage = 'javascript' | 'python' | 'go' | 'rust' | 'generic';

function templateLanguage(primaryLanguage?: string): MatrixTemplateLanguage {
  const language = primaryLanguage?.toLowerCase() ?? '';
  if (language.includes('python')) return 'python';
  if (language === 'go' || language.includes('golang')) return 'go';
  if (language.includes('rust')) return 'rust';
  if (
    language.includes('typescript') ||
    language.includes('javascript') ||
    language === 'ts' ||
    language === 'js'
  ) {
    return 'javascript';
  }
  return primaryLanguage ? 'generic' : 'javascript';
}

function concurrencyTemplate(
  language: MatrixTemplateLanguage,
  highContention = true,
): string {
  const workerCount = highContention ? 20 : 1;
  if (language === 'go') {
    return `workerCount := ${workerCount}\nvar workers sync.WaitGroup\nfor i := 0; i < workerCount; i++ {\n  workers.Add(1)\n  go func() { defer workers.Done(); processNext() }()\n}\nworkers.Wait()\nif leakChecker.HasDanglingHandles() { t.Fatal("resource leak") }`;
  }
  if (language === 'rust') {
    return `let tasks = make_tasks(${workerCount});\nlet workers: Vec<_> = tasks.into_iter().map(|task| std::thread::spawn(move || process(task))).collect();\nfor worker in workers { worker.join().expect("worker failed"); }\nassert!(!leak_checker.has_dangling_handles());`;
  }
  if (language === 'python') {
    return `with ThreadPoolExecutor(max_workers=${workerCount}) as pool:\n    results = list(pool.map(process, tasks))\nassert not leak_checker.has_dangling_handles()`;
  }
  if (language === 'generic') {
    return highContention
      ? 'Run the work with multiple workers, wait for every worker to finish, then verify that no handles remain open.'
      : 'Run the work with one worker, wait for it to finish, then verify that no handles remain open.';
  }
  return `// Run ${workerCount} worker(s), await every exit, and verify cleanup\nconst workers = tasks.slice(0, ${workerCount}).map((task) => spawnWorker(task));\nawait Promise.all(workers.map((worker) => worker.exit));\nexpect(leakChecker.hasDanglingHandles()).toBe(false);`;
}

function interruptedCleanupTemplate(language: MatrixTemplateLanguage): string {
  if (language === 'python') {
    return 'processes = [subprocess.Popen(command) for _ in range(20)]\nfor process in processes:\n    process.terminate()\nfor process in processes:\n    process.wait(timeout=5)\nshutil.rmtree(test_dir)\nassert not os.path.exists(test_dir)';
  }
  if (language === 'go') {
    return 'commands := make([]*exec.Cmd, 20)\nfor i := range commands { commands[i] = exec.CommandContext(ctx, command); if err := commands[i].Start(); err != nil { t.Fatal(err) } }\nfor _, cmd := range commands { _ = cmd.Process.Kill() }\nfor _, cmd := range commands { _ = cmd.Wait() }\nif err := os.RemoveAll(testDir); err != nil { t.Fatal(err) }';
  }
  if (language === 'rust') {
    return 'let mut children: Vec<_> = (0..20).map(|_| Command::new(command).spawn().expect("spawn worker")).collect();\nfor child in &mut children { child.kill()?; }\nfor child in &mut children { child.wait()?; }\nstd::fs::remove_dir_all(&test_dir)?;\nassert!(!test_dir.exists());';
  }
  if (language === 'generic') {
    return 'Start 20 child processes, cancel them, wait for every exit, remove their shared temporary directory, and verify cleanup succeeds on Windows.';
  }
  return 'const children = Array.from({ length: 20 }, () => spawn(command, args));\nconst exited = children.map((child) => new Promise((resolve) => child.once("exit", resolve)));\nfor (const child of children) child.kill();\nawait Promise.all(exited);\nexpect(() => rmSync(testDir, { recursive: true })).not.toThrow();';
}

function unresolvedChunkingTemplate(language: MatrixTemplateLanguage): string {
  if (language === 'python') {
    return 'max_tokens = 100\ntext = ("Word " * 200) + "\\n\\n" + ("VeryLongContinuousString" * 50)\nchunks = chunker.split_lines(text, max_tokens=max_tokens)\nassert "".join(chunks) == text\nassert all(token_len(chunk) <= max_tokens for chunk in chunks)';
  }
  if (language === 'go') {
    return 'maxTokens := 100\ntext := strings.Repeat("Word ", 200) + "\\n\\n" + strings.Repeat("VeryLongContinuousString", 50)\nchunks := chunker.SplitLines(text, maxTokens)\nif strings.Join(chunks, "") != text { t.Fatal("chunking lost the unresolved remainder") }\nfor _, chunk := range chunks { if tokenLen(chunk) > maxTokens { t.Fatal("chunk exceeded token bound") } }';
  }
  if (language === 'rust') {
    return 'let max_tokens = 100;\nlet text = format!("{}\\n\\n{}", "Word ".repeat(200), "VeryLongContinuousString".repeat(50));\nlet chunks = chunker.split_lines(&text, max_tokens);\nassert_eq!(chunks.concat(), text);\nassert!(chunks.iter().all(|chunk| token_len(chunk) <= max_tokens));';
  }
  if (language === 'generic') {
    return 'Provide several over-limit chunks, then append an unbreakable remainder after a delimiter. Verify the remainder is preserved and no output chunk exceeds the token limit.';
  }
  return 'const maxTokens = 100;\nconst text = "Word ".repeat(200) + "\\n\\n" + "VeryLongContinuousString".repeat(50);\nconst chunks = chunker.splitLines(text, maxTokens);\nexpect(chunks.join("")).toBe(text);\nexpect(chunks.every((chunk) => tokenLen(chunk) <= maxTokens)).toBe(true);';
}

function emptyTextTemplate(language: MatrixTemplateLanguage): string {
  if (language === 'python') {
    return 'assert chunker.split_lines("", max_tokens=100) == []\nassert chunker.split_lines("\\n\\n\\n", max_tokens=100) == []';
  }
  if (language === 'go') {
    return 'if got := chunker.SplitLines("", 100); len(got) != 0 { t.Fatalf("got %v", got) }\nif got := chunker.SplitLines("\\n\\n\\n", 100); len(got) != 0 { t.Fatalf("got %v", got) }';
  }
  if (language === 'rust') {
    return 'assert!(chunker.split_lines("", 100).is_empty());\nassert!(chunker.split_lines("\\n\\n\\n", 100).is_empty());';
  }
  if (language === 'generic') {
    return 'Verify that empty input and delimiter-only input return an empty result.';
  }
  return 'expect(chunker.splitLines("", 100)).toEqual([]);\nexpect(chunker.splitLines("\\n\\n\\n", 100)).toEqual([]);';
}

function generalBoundaryTemplates(language: MatrixTemplateLanguage): {
  empty: string;
  singleton: string;
  assertions: string[];
} {
  if (language === 'python') {
    return {
      empty: 'assert handle_input([]) == []',
      singleton: 'assert handle_input([single_item]) == [single_item]',
      assertions: ['assert result is not None', 'assert handle_input([]) == []'],
    };
  }
  if (language === 'go') {
    return {
      empty: 'if got := handleInput([]Item{}); len(got) != 0 { t.Fatalf("got %v", got) }',
      singleton: 'if got := handleInput([]Item{singleItem}); len(got) != 1 { t.Fatalf("got %v", got) }',
      assertions: [
        'if result == nil { t.Fatal("result is nil") }',
        'if got := handleInput([]Item{}); len(got) != 0 { t.Fatalf("got %v", got) }',
      ],
    };
  }
  if (language === 'rust') {
    return {
      empty: 'assert_eq!(handle_input(&[]), Vec::new())',
      singleton: 'assert_eq!(handle_input(&[single_item]), vec![single_item])',
      assertions: ['assert!(!result.is_empty())', 'assert_eq!(handle_input(&[]), Vec::new())'],
    };
  }
  if (language === 'generic') {
    return {
      empty: 'Verify that handling an empty input returns an empty result.',
      singleton: 'Verify that handling one item returns that item once.',
      assertions: [
        'Verify that a result is produced.',
        'Verify that empty input completes without an exception.',
      ],
    };
  }
  return {
    empty: 'expect(handleInput([])).toEqual([])',
    singleton: 'expect(handleInput([singleItem])).toEqual([singleItem])',
    assertions: [
      'expect(result).toBeDefined()',
      'expect(() => execute(emptyInput)).not.toThrow()',
    ],
  };
}

function textChunkingTemplate(language: MatrixTemplateLanguage): {
  exactBoundary: string;
  assertions: string[];
} {
  if (language === 'python') {
    return {
      exactBoundary: 'text = "Word " * max_tokens\nchunks = chunker.split_lines(text, max_tokens=max_tokens)\nassert all(token_len(chunk) <= max_tokens for chunk in chunks)',
      assertions: [
        'assert all(token_len(chunk) <= max_tokens for chunk in chunks), "Chunk exceeded max token bound"',
        'assert "".join(chunks).replace(" ", "") == original.replace(" ", ""), "Data loss detected during chunking"',
      ],
    };
  }
  if (language === 'go') {
    return {
      exactBoundary: 'text := strings.Repeat("word ", maxTokens)\nchunks := chunker.SplitLines(text, maxTokens)\nfor _, chunk := range chunks { if tokenLen(chunk) > maxTokens { t.Fatal("chunk exceeded token bound") } }',
      assertions: [
        'for _, chunk := range chunks { if tokenLen(chunk) > maxTokens { t.Fatal("chunk exceeded token bound") } }',
        'if strings.Join(chunks, "") != original { t.Fatal("chunking lost text") }',
      ],
    };
  }
  if (language === 'rust') {
    return {
      exactBoundary: 'let text = "word ".repeat(max_tokens);\nlet chunks = chunker.split_lines(&text, max_tokens);\nassert!(chunks.iter().all(|chunk| token_len(chunk) <= max_tokens));',
      assertions: [
        'assert!(chunks.iter().all(|chunk| token_len(chunk) <= max_tokens));',
        'assert_eq!(chunks.concat(), original);',
      ],
    };
  }
  if (language === 'generic') {
    return {
      exactBoundary: 'Verify that input exactly at the token limit is accepted without being split unnecessarily.',
      assertions: [
        'Verify that no output chunk exceeds the configured token limit.',
        'Verify that joining output chunks preserves the input text.',
      ],
    };
  }
  return {
    exactBoundary: 'const text = "word ".repeat(maxTokens);\nconst chunks = chunker.splitLines(text, maxTokens);\nexpect(chunks.every((chunk) => tokenLen(chunk) <= maxTokens)).toBe(true);',
    assertions: [
      'expect(chunks.every((chunk) => tokenLen(chunk) <= maxTokens)).toBe(true)',
      'expect(chunks.join("").replaceAll(" ", "")).toBe(original.replaceAll(" ", ""))',
    ],
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
  const language = templateLanguage(input.primaryLanguage);

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
      {
        scenarioId: 'PERIOD_FEATURE_POSITIONAL_TARGET',
        description: 'Features use a PeriodIndex while the target is aligned positionally.',
        variantCombination: {
          FeatureFrameIndex: 'PeriodIndex',
          TargetSeriesIndex: 'RangeIndex_positional',
        },
        testTemplateSnippet:
          'X = pd.DataFrame({"val": values}, index=periods)\ny = pd.Series(target_values)\n# assert alignment is explicit and preserves the intended row order',
        riskSurface:
          'Implicitly aligning distinct index types can drop rows or pair feature and target values incorrectly.',
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
    const templates = textChunkingTemplate(language);
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
        testTemplateSnippet: unresolvedChunkingTemplate(language),
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
          emptyTextTemplate(language),
        riskSurface: 'Off-by-one errors or infinite recursion on empty remainder strings.',
      },
      {
        scenarioId: 'EXACT_TOKEN_BOUNDARY',
        description: 'Input length is exactly the configured token limit.',
        variantCombination: {
          TextScaleVsLimit: 'ExactBoundary',
          DelimiterDensity: 'NormalParagraphs',
        },
        testTemplateSnippet: templates.exactBoundary,
        riskSurface: 'An inclusive limit may be handled as exclusive, causing unnecessary splitting or rejection.',
      },
      {
        scenarioId: 'PUNCTUATION_ONLY_DELIMITERS',
        description: 'Text can split only at punctuation delimiters without whitespace.',
        variantCombination: {
          TextScaleVsLimit: 'UnderLimit',
          DelimiterDensity: 'SingleTokenDelimitersOnly',
        },
        testTemplateSnippet:
          language === 'python'
            ? 'text = "漢字。句子！次の文？"\nchunks = chunker.split_lines(text, max_tokens=100)\nassert "".join(chunks) == text'
            : language === 'go'
              ? 'text := "漢字。句子！次の文？"\nchunks := chunker.SplitLines(text, 100)\nif strings.Join(chunks, "") != text { t.Fatal("chunking lost punctuation") }'
              : language === 'rust'
                ? 'let text = "漢字。句子！次の文？";\nlet chunks = chunker.split_lines(text, 100);\nassert_eq!(chunks.concat(), text);'
                : language === 'generic'
                  ? 'Verify that punctuation-only text splits or remains intact without losing characters.'
                  : 'const text = "漢字。句子！次の文？";\nconst chunks = chunker.splitLines(text, maxTokens);\nexpect(chunks.join("")).toBe(text);',
        riskSurface: 'A delimiter tokenizer that assumes whitespace can drop or merge punctuation-only segments.',
      },
    ];

    return {
      domain,
      domainRationale: rationale,
      dimensions,
      scenarios,
      recommendedAssertions: templates.assertions,
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
            interruptedCleanupTemplate(language),
          riskSurface:
            'Windows holding process handle open causing EBUSY unlink errors during test teardown.',
        },
        {
          scenarioId: 'SEQUENTIAL_GRACEFUL_COMPLETION',
          description: 'One worker completes normally without cancellation or contention.',
          variantCombination: {
            WorkerConcurrency: 'SingleThread',
            LifecycleInterruption: 'GracefulComplete',
          },
          testTemplateSnippet: concurrencyTemplate(language, false),
          riskSurface: 'Normal completion should release resources and return every result exactly once.',
        },
      ],
      recommendedAssertions:
        language === 'go'
          ? [
              'if leakChecker.HasDanglingHandles() { t.Fatal("resource leak") }',
              'if raceDetector.Collisions() != 0 { t.Fatal("race detected") }',
            ]
          : language === 'rust'
            ? [
                'assert!(!leak_checker.has_dangling_handles())',
                'assert_eq!(race_detector.collisions(), 0)',
              ]
            : language === 'python'
              ? [
                  'assert not leak_checker.has_dangling_handles()',
                  'assert race_detector.collisions == 0',
                ]
              : language === 'generic'
                ? ['Verify that all workers finish.', 'Verify that no resource handles remain open.']
                : [
                    'expect(leakChecker.hasDanglingHandles()).toBe(false)',
                    'expect(raceDetector.collisions).toBe(0)',
                  ],
    };
  }

  // General boundary domain
  const generalTemplates = generalBoundaryTemplates(language);
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
        testTemplateSnippet: generalTemplates.empty,
        riskSurface: 'Unchecked index access [0] on empty collections.',
      },
      {
        scenarioId: 'SINGLETON_ELEMENT_INTEGRITY',
        description: 'Verify singleton inputs do not trigger divide-by-zero or slice off-by-one errors.',
        variantCombination: {
          BoundaryScales: 'Single',
          Nullability: 'FullyPopulated',
        },
        testTemplateSnippet: generalTemplates.singleton,
        riskSurface: 'Loops expecting >1 item failing on single-element bounds.',
      },
      {
        scenarioId: 'EXTREME_SCALE',
        description: 'A large input remains bounded and completes without exhausting resources.',
        variantCombination: {
          BoundaryScales: 'Extreme',
          Nullability: 'FullyPopulated',
        },
        testTemplateSnippet:
          language === 'generic'
            ? 'Verify that processing more than 10,000 populated items completes within resource limits.'
            : language === 'python'
              ? 'result = handle_input(list(range(10_001)))\nassert len(result) == 10_001'
              : language === 'go'
                ? 'result := handleInput(makeItems(10_001))\nif len(result) != 10_001 { t.Fatalf("got %d", len(result)) }'
                : language === 'rust'
                  ? 'let items = (0..10_001).collect::<Vec<_>>();\nlet result = handle_input(&items);\nassert_eq!(result.len(), 10_001);'
                  : 'const result = handleInput(Array.from({ length: 10_001 }, (_, i) => i));\nexpect(result).toHaveLength(10_001);',
        riskSurface: 'Large inputs can reveal unbounded allocations, quadratic loops, or premature truncation.',
      },
    ],
    recommendedAssertions: generalTemplates.assertions,
  };
}
