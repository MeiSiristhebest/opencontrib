import { createHash } from "node:crypto";
import * as fs from "fs";
import * as path from "path";
import type { CapabilityType } from "./capability.js";
import { getOpenContribDataDir, getOpenContribHome } from "./home.js";

export interface OpenContribPolicy {
  network: "allowed" | "denied";
  maxRuntimeSeconds: number;
  enableHeavy: boolean;
  allowMutation: boolean;
  coverage?: {
    required: boolean;
    minimumChangedLineCoverage: number;
  };
  resourceLeakCheck?: {
    required: boolean;
  };
}

/**
 * Global and tool-specific default timeouts (in milliseconds).
 * Can be overridden via process.env.OPENCONTRIB_SCAN_TIMEOUT_MS or workspace policy.
 */
export const DEFAULT_TOOL_TIMEOUTS = {
  AST_GREP: 20_000,
  SEMGREP: 60_000,
  KNIP: 60_000,
  RUFF: 20_000,
  CARGO_DENY: 30_000,
  ESLINT_SECURITY: 30_000,
  VARIANT_HUNT: 20_000,
  BINARY_CHECK: 3_000,
  GIT_DISCOVERY: 5_000,
} as const;

export function getToolTimeout(
  tool: keyof typeof DEFAULT_TOOL_TIMEOUTS,
  defaultFallback = 30_000,
): number {
  if (process.env.OPENCONTRIB_SCAN_TIMEOUT_MS) {
    const parsed = parseInt(process.env.OPENCONTRIB_SCAN_TIMEOUT_MS, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_TOOL_TIMEOUTS[tool] ?? defaultFallback;
}

export interface OpenContribConfig {
  version: string;
  enabledCapabilities: CapabilityType[];
  policy: OpenContribPolicy;
  toolchains: Record<string, string>;
  customRules?: string[];
}

export const DEFAULT_CONFIG: OpenContribConfig = {
  version: "1.0",
  enabledCapabilities: [
    "security.static-analysis",
    "bug.reproduction",
    "forensics.git-hotspot",
    "testing.property-fuzz",
    "ci.workflow-lint",
    "concurrency.leak-detection",
    "architecture.dead-code",
  ],
  policy: {
    network: "denied",
    maxRuntimeSeconds: 300,
    enableHeavy: false,
    allowMutation: true,
    coverage: {
      required: false,
      minimumChangedLineCoverage: 85,
    },
    resourceLeakCheck: {
      required: false,
    },
  },
  toolchains: {
    astGrepBin: "ast-grep",
    semgrepBin: "semgrep",
    knipBin: "knip",
    goleakBin: "go",
  },
};

export interface TrustedPolicySnapshot {
  coverage: {
    required: boolean;
    minimumChangedLineCoverage: number;
  };
  resourceLeakCheck: {
    required: boolean;
  };
}

type PolicyConfigInput = {
  coverage?: {
    required?: boolean;
    minimumChangedLineCoverage?: number;
  };
  resourceLeakCheck?: {
    required?: boolean;
  };
};

/** Parse only the policy portion of a trusted JSON configuration artifact. */
export function parsePolicyConfig(raw: string): OpenContribPolicy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid trusted policy config: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Invalid trusted policy config: root must be an object.");
  }
  const configuredPolicy = (parsed as { policy?: unknown }).policy;
  if (
    configuredPolicy !== undefined &&
    (typeof configuredPolicy !== "object" ||
      configuredPolicy === null ||
      Array.isArray(configuredPolicy))
  ) {
    throw new Error("Invalid trusted policy: policy must be an object.");
  }
  const policy = configuredPolicy as PolicyConfigInput | undefined;
  const configuredCoverage = policy?.coverage;
  const configuredResourceLeakCheck = policy?.resourceLeakCheck;
  const configuredCoverageMinimum =
    configuredCoverage?.minimumChangedLineCoverage;
  if (
    configuredCoverage !== undefined &&
    (typeof configuredCoverage !== "object" ||
      configuredCoverage === null ||
      Array.isArray(configuredCoverage))
  ) {
    throw new Error(
      "Invalid trusted coverage policy: coverage must be an object.",
    );
  }
  if (
    configuredResourceLeakCheck !== undefined &&
    (typeof configuredResourceLeakCheck !== "object" ||
      configuredResourceLeakCheck === null ||
      Array.isArray(configuredResourceLeakCheck))
  ) {
    throw new Error(
      "Invalid trusted resource leak policy: resourceLeakCheck must be an object.",
    );
  }
  if (
    (configuredCoverage?.required !== undefined &&
      typeof configuredCoverage.required !== "boolean") ||
    (configuredResourceLeakCheck?.required !== undefined &&
      typeof configuredResourceLeakCheck.required !== "boolean")
  ) {
    throw new Error(
      "Invalid trusted policy: coverage and resourceLeakCheck required fields must be boolean.",
    );
  }
  if (
    configuredCoverageMinimum !== undefined &&
    (typeof configuredCoverageMinimum !== "number" ||
      !Number.isFinite(configuredCoverageMinimum) ||
      configuredCoverageMinimum < 0 ||
      configuredCoverageMinimum > 100)
  ) {
    throw new Error(
      "Invalid trusted coverage policy: minimumChangedLineCoverage must be a finite number between 0 and 100.",
    );
  }
  return {
    ...DEFAULT_CONFIG.policy,
    ...(policy || {}),
    coverage: configuredCoverage
      ? {
          required:
            configuredCoverage.required ??
            DEFAULT_CONFIG.policy.coverage?.required ??
            false,
          minimumChangedLineCoverage:
            configuredCoverage.minimumChangedLineCoverage ??
            DEFAULT_CONFIG.policy.coverage?.minimumChangedLineCoverage ??
            85,
        }
      : DEFAULT_CONFIG.policy.coverage,
    resourceLeakCheck: configuredResourceLeakCheck
      ? {
          required:
            configuredResourceLeakCheck.required ??
            DEFAULT_CONFIG.policy.resourceLeakCheck?.required ??
            false,
        }
      : DEFAULT_CONFIG.policy.resourceLeakCheck,
  };
}

/** Load only host-owned policy; never inspect a contribution worktree. */
export function loadHostPolicy(): OpenContribPolicy {
  const candidates = [
    path.join(getOpenContribDataDir(), "config.json"),
    path.join(getOpenContribHome(), ".opencontrib", "config.json"),
  ].filter((candidate, index, all) => all.indexOf(candidate) === index);
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      return parsePolicyConfig(fs.readFileSync(candidate, "utf8"));
    } catch (error) {
      throw new Error(
        `TrustedPolicyConfigError: cannot load host policy from ${candidate}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { ...DEFAULT_CONFIG.policy };
}

export function toTrustedPolicySnapshot(
  policy: PolicyConfigInput | OpenContribPolicy | TrustedPolicySnapshot,
): TrustedPolicySnapshot {
  const coverageRequired = policy.coverage?.required === true;
  const configuredMinimum = policy.coverage?.minimumChangedLineCoverage;
  return {
    coverage: {
      required: coverageRequired,
      // A non-required/default minimum is advisory and must not become a
      // hidden hard gate when trusted policy is merged.
      minimumChangedLineCoverage:
        coverageRequired && typeof configuredMinimum === "number"
          ? configuredMinimum
          : 0,
    },
    resourceLeakCheck: {
      required: policy.resourceLeakCheck?.required === true,
    },
  };
}

/** Merge policy sources monotonically: required flags OR, thresholds MAX. */
export function mergeTrustedPolicySnapshots(
  ...policies: Array<
    PolicyConfigInput | OpenContribPolicy | TrustedPolicySnapshot | undefined
  >
): TrustedPolicySnapshot {
  const snapshots = policies
    .filter(Boolean)
    .map((policy) => toTrustedPolicySnapshot(policy!));
  return {
    coverage: {
      required: snapshots.some((snapshot) => snapshot.coverage.required),
      minimumChangedLineCoverage: Math.max(
        0,
        ...snapshots.map(
          (snapshot) => snapshot.coverage.minimumChangedLineCoverage,
        ),
      ),
    },
    resourceLeakCheck: {
      required: snapshots.some(
        (snapshot) => snapshot.resourceLeakCheck.required,
      ),
    },
  };
}

export function hashTrustedPolicySnapshot(
  snapshot: TrustedPolicySnapshot,
): string {
  return createHash("sha256")
    .update(JSON.stringify(toTrustedPolicySnapshot(snapshot)))
    .digest("hex");
}

/**
 * Loads project-level or user-level OpenContrib configuration.
 * Resolution priority:
 * 1. <workspace>/.opencontrib.yaml or .opencontrib.json
 * 2. <workspace>/.opencontrib/config.json
 * 3. ~/.opencontrib/config.json
 * 4. DEFAULT_CONFIG
 */
export function loadWorkspaceConfig(
  workspacePath: string = process.cwd(),
): OpenContribConfig {
  const candidates = [
    path.join(workspacePath, ".opencontrib.json"),
    path.join(workspacePath, ".opencontrib", "config.json"),
    path.join(getOpenContribHome(), ".opencontrib", "config.json"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      try {
        const raw = fs.readFileSync(candidate, "utf8");
        const parsed = JSON.parse(raw);
        const configuredPolicy = parsed.policy;
        if (
          configuredPolicy !== undefined &&
          (typeof configuredPolicy !== "object" ||
            configuredPolicy === null ||
            Array.isArray(configuredPolicy))
        ) {
          throw new Error("Invalid trusted policy: policy must be an object.");
        }
        const configuredCoverage = configuredPolicy?.coverage;
        const configuredResourceLeakCheck = configuredPolicy?.resourceLeakCheck;
        const configuredCoverageMinimum =
          configuredCoverage?.minimumChangedLineCoverage;
        const configuredCoverageRequired = configuredCoverage?.required;
        const configuredResourceLeakRequired =
          configuredResourceLeakCheck?.required;
        if (
          configuredCoverage !== undefined &&
          (typeof configuredCoverage !== "object" ||
            configuredCoverage === null ||
            Array.isArray(configuredCoverage))
        ) {
          throw new Error(
            "Invalid trusted coverage policy: coverage must be an object.",
          );
        }
        if (
          configuredResourceLeakCheck !== undefined &&
          (typeof configuredResourceLeakCheck !== "object" ||
            configuredResourceLeakCheck === null ||
            Array.isArray(configuredResourceLeakCheck))
        ) {
          throw new Error(
            "Invalid trusted resource leak policy: resourceLeakCheck must be an object.",
          );
        }
        if (
          (configuredCoverageRequired !== undefined &&
            typeof configuredCoverageRequired !== "boolean") ||
          (configuredResourceLeakRequired !== undefined &&
            typeof configuredResourceLeakRequired !== "boolean")
        ) {
          throw new Error(
            "Invalid trusted policy: coverage and resourceLeakCheck required fields must be boolean.",
          );
        }
        if (
          configuredCoverageMinimum !== undefined &&
          (typeof configuredCoverageMinimum !== "number" ||
            !Number.isFinite(configuredCoverageMinimum) ||
            configuredCoverageMinimum < 0 ||
            configuredCoverageMinimum > 100)
        ) {
          throw new Error(
            "Invalid trusted coverage policy: minimumChangedLineCoverage must be a finite number between 0 and 100.",
          );
        }
        return {
          version: parsed.version || DEFAULT_CONFIG.version,
          enabledCapabilities:
            parsed.enabledCapabilities || DEFAULT_CONFIG.enabledCapabilities,
          policy: {
            ...DEFAULT_CONFIG.policy,
            ...(configuredPolicy || {}),
            coverage: configuredCoverage
              ? {
                  required:
                    configuredCoverage.required ??
                    DEFAULT_CONFIG.policy.coverage?.required ??
                    false,
                  minimumChangedLineCoverage:
                    configuredCoverage.minimumChangedLineCoverage ??
                    DEFAULT_CONFIG.policy.coverage
                      ?.minimumChangedLineCoverage ??
                    85,
                }
              : DEFAULT_CONFIG.policy.coverage,
            resourceLeakCheck: configuredResourceLeakCheck
              ? {
                  required:
                    configuredResourceLeakCheck.required ??
                    DEFAULT_CONFIG.policy.resourceLeakCheck?.required ??
                    false,
                }
              : DEFAULT_CONFIG.policy.resourceLeakCheck,
          },
          toolchains: {
            ...DEFAULT_CONFIG.toolchains,
            ...(parsed.toolchains || {}),
          },
          customRules: parsed.customRules || [],
        };
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.startsWith("Invalid trusted")
        ) {
          throw error;
        }
        // Fallback to next candidate on parse failure
      }
    }
  }

  return { ...DEFAULT_CONFIG };
}

/**
 * Writes an initial configuration template to the workspace root.
 */
export function initWorkspaceConfig(
  workspacePath: string = process.cwd(),
): string {
  const targetPath = path.join(workspacePath, ".opencontrib.json");
  if (!fs.existsSync(targetPath)) {
    fs.writeFileSync(
      targetPath,
      JSON.stringify(DEFAULT_CONFIG, null, 2),
      "utf8",
    );
  }
  return targetPath;
}
