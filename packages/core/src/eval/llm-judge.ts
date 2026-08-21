/**
 * LLM-as-a-Judge Trajectory Evaluator (G-Eval Chain-of-Thought Engine)
 *
 * Implements strict, industrial-grade multi-dimensional evaluation with
 * uncompromising penalties for anti-patterns and weakest-dimension gating.
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
  // 1. Dimension 1: Problem Formulation & Convergence Velocity (Weight: 0.20)
  let pfScore = 95;
  const pfReasons: string[] = [];
  if (metrics.totalCommandsRun > 90) {
    pfScore -= 55;
    pfReasons.push(`Extreme exploratory meandering (${metrics.totalCommandsRun} commands run); agent failed to leverage probe plan or structural index.`);
  } else if (metrics.totalCommandsRun > 50) {
    pfScore -= 30;
    pfReasons.push(`High command count (${metrics.totalCommandsRun} commands) before isolating defect.`);
  } else if (metrics.totalCommandsRun > 25) {
    pfScore -= 15;
    pfReasons.push(`Moderate command count (${metrics.totalCommandsRun} commands) before converging on defect.`);
  }
  if (pfReasons.length === 0) {
    pfReasons.push('Formulated clear targeted hypotheses and converged rapidly onto target defect.');
  }

  // 2. Dimension 2: Context Economy & Anti-Drift (Weight: 0.20)
  let ceScore = 100;
  const ceReasons: string[] = [];
  if (metrics.wholeFileRgDumpsDetected >= 3) {
    ceScore = Math.max(0, 20 - (metrics.wholeFileRgDumpsDetected - 3) * 5);
    ceReasons.push(`Critical Violation: Conducted ${metrics.wholeFileRgDumpsDetected} whole-file regex dump attempts (rg -n ".*" / rg "^"), severely polluting the context window and violating anti-circumvention rules.`);
  } else if (metrics.wholeFileRgDumpsDetected > 0) {
    ceScore -= metrics.wholeFileRgDumpsDetected * 35;
    ceReasons.push(`Detected ${metrics.wholeFileRgDumpsDetected} whole-file regex dump attempts (rg -n ".*").`);
  }
  if (metrics.maxConsecutiveFileViews > 3) {
    ceScore -= (metrics.maxConsecutiveFileViews - 3) * 15;
    ceReasons.push(`Exceeded anti-drift limit with ${metrics.maxConsecutiveFileViews} consecutive view_file calls.`);
  }
  if (ceReasons.length === 0) {
    ceReasons.push('Maintained optimal context economy using Smart Pointer code slicing and targeted symbol searches.');
  }

  // 3. Dimension 3: Empirical Rigor & Dual-Stage Reproduction (Weight: 0.25)
  let erScore = 95;
  const erReasons: string[] = [];
  const hasEvidenceCmd = events.some((e) =>
    e.toolCalls?.some((t) => t.name === 'run_command' && String(t.args?.CommandLine || '').includes('opencontrib evidence'))
  );
  if (!hasEvidenceCmd) {
    erScore -= 35;
    erReasons.push('Omitted automated empirical evidence collection command (opencontrib evidence).');
  } else {
    erReasons.push('Verified dual-stage empirical reproduction with automated evidence collection.');
  }

  // 4. Dimension 4: Concurrency & Chaos Stress (Weight: 0.15)
  let csScore = 90;
  const csReasons: string[] = [];
  const hasConcurrencyFlag = events.some((e) =>
    e.toolCalls?.some((t) => t.name === 'run_command' && String(t.args?.CommandLine || '').includes('--concurrency'))
  );
  if (!hasConcurrencyFlag) {
    csScore -= 25;
    csReasons.push('No concurrent worker contention (--concurrency <N>) applied during stress verification.');
  } else {
    csReasons.push('Applied multi-worker concurrency stampede stress testing under shared state contention.');
  }

  // 5. Dimension 5: Community Craftsmanship & Zero-Mojibake Protocol (Weight: 0.20)
  let ccScore = 100;
  const ccReasons: string[] = [];
  if (metrics.shellScriptWriteHacksDetected >= 3) {
    ccScore = Math.max(0, 15 - (metrics.shellScriptWriteHacksDetected - 3) * 5);
    ccReasons.push(`Critical Violation: Performed ${metrics.shellScriptWriteHacksDetected} shell script write hacks (node -e / Buffer.from), bypassing safe file tools and causing high risk of terminal mojibake and encoding corruption.`);
  } else if (metrics.shellScriptWriteHacksDetected > 0) {
    ccScore -= metrics.shellScriptWriteHacksDetected * 40;
    ccReasons.push(`Detected ${metrics.shellScriptWriteHacksDetected} shell script write hacks (node -e / Buffer.from).`);
  }

  const hasIssueCreate = events.some((e) =>
    e.toolCalls?.some((t) => t.name === 'run_command' && String(t.args?.CommandLine || '').includes('gh issue create'))
  );
  const hasPrCreate = events.some((e) =>
    e.toolCalls?.some((t) => t.name === 'run_command' && String(t.args?.CommandLine || '').includes('gh pr create'))
  );
  if (hasPrCreate && !hasIssueCreate) {
    ccScore -= 30;
    ccReasons.push('Submitted blind PR without creating upstream Issue and authoritative Claim first.');
  }
  if (ccReasons.length === 0) {
    ccReasons.push('Followed strict Issue-First protocol and produced clean UTF-8 markdown artifacts.');
  }

  // Ensure dimension scores are bounded between 0 and 100
  const clamp = (val: number) => Math.max(0, Math.min(100, Math.round(val)));
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

  let rawOverallScore = dimensions.reduce((acc, dim) => acc + dim.score * dim.weight, 0);

  // Weakest-Dimension Gate: If any critical dimension is <= 25, cap overall score at 55
  const minDimScore = Math.min(...dimensions.map((d) => d.score));
  if (minDimScore <= 25) {
    rawOverallScore = Math.min(rawOverallScore, 50);
  }

  const overallScore = Math.round(rawOverallScore);

  let verdict: JudgeEvaluationReport['verdict'];
  if (overallScore >= 90) verdict = 'EXEMPLARY';
  else if (overallScore >= 75) verdict = 'PROFICIENT';
  else if (overallScore >= 60) verdict = 'NEEDS_IMPROVEMENT';
  else verdict = 'UNSATISFACTORY';

  const strengths: string[] = [];
  const criticalCritiques: string[] = [];
  const actionableDirectives: string[] = [];

  for (const d of dimensions) {
    if (d.score >= 80) {
      strengths.push(`${d.title} (${d.score}/100): ${d.reasoning}`);
    } else {
      criticalCritiques.push(`${d.title} (${d.score}/100): ${d.reasoning}`);
    }
  }

  if (metrics.wholeFileRgDumpsDetected > 0) {
    actionableDirectives.push(`CRITICAL: Stop dumping whole files via rg -n ".*" (${metrics.wholeFileRgDumpsDetected} detected); resolve Smart Pointer slices instead.`);
  }
  if (metrics.shellScriptWriteHacksDetected > 0) {
    actionableDirectives.push(`CRITICAL: Stop using node -e / Buffer.from shell write hacks (${metrics.shellScriptWriteHacksDetected} detected); use the native write_to_file tool with clean UTF-8.`);
  }
  if (metrics.totalCommandsRun > 40) {
    actionableDirectives.push(`EFFICIENCY: Reduce exploratory command loops (${metrics.totalCommandsRun} commands) by relying on probe plan and fingerprinting.`);
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
