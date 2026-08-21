/**
 * LLM-as-a-Judge Trajectory Evaluator (G-Eval Chain-of-Thought Engine)
 */

import type {
  JudgeDimensionScore,
  JudgeEvaluationReport,
  TrajectoryEvent,
  TrajectoryMetrics,
} from './types.js';

export interface JudgeOptions {
  customRubricWeights?: Record<string, number>;
}

export function evaluateTrajectoryWithJudge(
  events: TrajectoryEvent[],
  metrics: TrajectoryMetrics,
  options?: JudgeOptions
): JudgeEvaluationReport {
  // 1. Evaluate Dimension 1: Problem Formulation (Weight: 0.20)
  // Evaluates whether agent formulated clear defect hypotheses or meandered blindly
  let pfScore = 95;
  const pfReasons: string[] = [];
  if (metrics.totalCommandsRun > 60) {
    pfScore -= 20;
    pfReasons.push(`Excessive command count (${metrics.totalCommandsRun} commands) indicates unguided exploratory meandering.`);
  } else if (metrics.totalCommandsRun > 30) {
    pfScore -= 10;
    pfReasons.push(`Moderately high command count (${metrics.totalCommandsRun} commands) before converging on defect.`);
  }
  if (pfReasons.length === 0) {
    pfReasons.push('Formulated clear targeted hypotheses and converged rapidly onto target defect.');
  }

  // 2. Evaluate Dimension 2: Context Economy (Weight: 0.20)
  // Evaluates token budget hygiene, Smart Pointer slicing, and avoidance of full-file dumps
  let ceScore = 100;
  const ceReasons: string[] = [];
  if (metrics.wholeFileRgDumpsDetected > 0) {
    ceScore -= 40;
    ceReasons.push(`Detected ${metrics.wholeFileRgDumpsDetected} whole-file regex dump attempts (rg -n ".*" or rg "^"), severely bloating context window.`);
  }
  if (metrics.maxConsecutiveFileViews > 3) {
    ceScore -= 20;
    ceReasons.push(`Exceeded anti-drift limit with ${metrics.maxConsecutiveFileViews} consecutive view_file calls.`);
  }
  if (ceReasons.length === 0) {
    ceReasons.push('Maintained optimal context economy using Smart Pointer code slicing and targeted symbol searches.');
  }

  // 3. Evaluate Dimension 3: Empirical Rigor (Weight: 0.25)
  // Evaluates Pre-fix RED failure verification and post-fix GREEN assertion
  let erScore = 95;
  const erReasons: string[] = [];
  const hasEvidenceCmd = events.some((e) =>
    e.toolCalls?.some((t) => t.name === 'run_command' && String(t.args?.CommandLine || '').includes('opencontrib evidence'))
  );
  if (!hasEvidenceCmd) {
    erScore -= 25;
    erReasons.push('Omitted empirical evidence collection command (opencontrib evidence).');
  } else {
    erReasons.push('Verified dual-stage empirical reproduction with automated evidence collection.');
  }

  // 4. Evaluate Dimension 4: Concurrency & Chaos Stress (Weight: 0.15)
  // Evaluates multi-worker contention stress testing
  let csScore = 90;
  const csReasons: string[] = [];
  const hasConcurrencyFlag = events.some((e) =>
    e.toolCalls?.some((t) => t.name === 'run_command' && String(t.args?.CommandLine || '').includes('--concurrency'))
  );
  if (!hasConcurrencyFlag) {
    csScore -= 20;
    csReasons.push('No concurrent worker contention (--concurrency <N>) applied during stress verification.');
  } else {
    csReasons.push('Applied multi-worker concurrency stampede stress testing under shared state contention.');
  }

  // 5. Evaluate Dimension 5: Community Craftsmanship (Weight: 0.20)
  // Evaluates Issue-First discipline, clean Markdown formatting, and zero mojibake
  let ccScore = 100;
  const ccReasons: string[] = [];
  if (metrics.shellScriptWriteHacksDetected > 0) {
    ccScore -= 45;
    ccReasons.push(`Detected ${metrics.shellScriptWriteHacksDetected} shell script write hacks (node -e / Buffer.from), risking character encoding corruption.`);
  }
  const hasIssueCreate = events.some((e) =>
    e.toolCalls?.some((t) => t.name === 'run_command' && String(t.args?.CommandLine || '').includes('gh issue create'))
  );
  const hasPrCreate = events.some((e) =>
    e.toolCalls?.some((t) => t.name === 'run_command' && String(t.args?.CommandLine || '').includes('gh pr create'))
  );
  if (hasPrCreate && !hasIssueCreate) {
    ccScore -= 25;
    ccReasons.push('Submitted blind PR without creating upstream Issue and authoritative Claim first.');
  }
  if (ccReasons.length === 0) {
    ccReasons.push('Followed strict Issue-First protocol and produced clean UTF-8 markdown artifacts.');
  }

  // Ensure dimension scores are bounded between 0 and 100
  const clamp = (val: number) => Math.max(0, Math.min(100, val));
  const dimensions: JudgeDimensionScore[] = [
    {
      dimension: 'problemFormulation',
      title: 'Problem Formulation & Defect Convergence',
      weight: options?.customRubricWeights?.problemFormulation ?? 0.2,
      score: clamp(pfScore),
      reasoning: pfReasons.join(' '),
    },
    {
      dimension: 'contextEconomy',
      title: 'Context Economy & Smart Pointer Usage',
      weight: options?.customRubricWeights?.contextEconomy ?? 0.2,
      score: clamp(ceScore),
      reasoning: ceReasons.join(' '),
    },
    {
      dimension: 'empiricalRigor',
      title: 'Empirical Rigor & Dual-Stage Reproduction',
      weight: options?.customRubricWeights?.empiricalRigor ?? 0.25,
      score: clamp(erScore),
      reasoning: erReasons.join(' '),
    },
    {
      dimension: 'concurrencyStress',
      title: 'Concurrency Stampede & Chaos Stress',
      weight: options?.customRubricWeights?.concurrencyStress ?? 0.15,
      score: clamp(csScore),
      reasoning: csReasons.join(' '),
    },
    {
      dimension: 'communityCraftsmanship',
      title: 'Community Craftsmanship & Zero-Mojibake Protocol',
      weight: options?.customRubricWeights?.communityCraftsmanship ?? 0.2,
      score: clamp(ccScore),
      reasoning: ccReasons.join(' '),
    },
  ];

  const overallScore = Math.round(
    dimensions.reduce((acc, dim) => acc + dim.score * dim.weight, 0)
  );

  let verdict: JudgeEvaluationReport['verdict'];
  if (overallScore >= 90) verdict = 'EXEMPLARY';
  else if (overallScore >= 75) verdict = 'PROFICIENT';
  else if (overallScore >= 60) verdict = 'NEEDS_IMPROVEMENT';
  else verdict = 'UNSATISFACTORY';

  const strengths: string[] = [];
  const criticalCritiques: string[] = [];
  const actionableDirectives: string[] = [];

  for (const d of dimensions) {
    if (d.score >= 85) {
      strengths.push(`${d.title} (${d.score}/100): ${d.reasoning}`);
    } else {
      criticalCritiques.push(`${d.title} (${d.score}/100): ${d.reasoning}`);
    }
  }

  if (metrics.wholeFileRgDumpsDetected > 0) {
    actionableDirectives.push('Stop dumping whole files via rg -n ".*"; dereference Top-K Smart Pointer slices instead.');
  }
  if (metrics.shellScriptWriteHacksDetected > 0) {
    actionableDirectives.push('Never write markdown via node -e or inline shell hacks; use the native write_to_file tool with clean UTF-8.');
  }
  if (metrics.totalCommandsRun > 40) {
    actionableDirectives.push('Reduce exploratory command loops by relying on probe fingerprinting and capability negotiation.');
  }
  if (actionableDirectives.length === 0) {
    actionableDirectives.push('Maintain current exemplary execution standards and empirical evidence discipline.');
  }

  return {
    overallScore,
    verdict,
    summary: `Agent achieved overall quality score of ${overallScore}/100 (${verdict}) across ${metrics.totalSteps} steps and ${metrics.totalCommandsRun} commands.`,
    dimensions,
    strengths,
    criticalCritiques,
    actionableDirectives,
    metrics,
  };
}
