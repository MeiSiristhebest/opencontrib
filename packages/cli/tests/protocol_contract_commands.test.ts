import { describe, expect, it } from "bun:test";
import {
  getProtocolGuidance,
  PROTOCOL_CONTRACT_PHASES,
} from "@opencontrib/core";
import { capabilityCommand } from "../src/commands/capability.js";
import { discoveryCommand } from "../src/commands/discovery.js";
import { evidenceCommand } from "../src/commands/evidence.js";
import { flywheelCommand } from "../src/commands/flywheel.js";
import { governanceCommand } from "../src/commands/governance.js";
import { probeCommand } from "../src/commands/probe.js";
import { runCommand } from "../src/commands/run.js";
import { scoutCommand } from "../src/commands/scout.js";
import { submissionCommand } from "../src/commands/submission.js";
import { verifyCommand } from "../src/commands/verify.js";
import { workspaceCommand } from "../src/commands/workspace.js";

const registeredCommands = [
  capabilityCommand,
  discoveryCommand,
  evidenceCommand,
  flywheelCommand,
  governanceCommand,
  probeCommand,
  runCommand,
  scoutCommand,
  submissionCommand,
  verifyCommand,
  workspaceCommand,
];

describe("Canonical protocol contract registration", () => {
  it("registers every protocol CLI command and declared subcommand", () => {
    const commandsByName = new Map(
      registeredCommands.map((command) => [command.name(), command]),
    );

    for (const definition of Object.values(PROTOCOL_CONTRACT_PHASES)) {
      const command = commandsByName.get(definition.cli.command);
      expect(command, `${definition.phase} CLI command`).toBeDefined();

      const subcommands = new Set([
        ...(definition.cli.subcommand ? [definition.cli.subcommand] : []),
        ...(definition.cli.subcommands ?? []),
      ]);
      for (const subcommand of subcommands) {
        expect(
          command?.commands.some(
            (candidate) => candidate.name() === subcommand,
          ),
          `${definition.phase} CLI subcommand ${definition.cli.command} ${subcommand}`,
        ).toBe(true);
      }
    }
  });

  it("derives workspace next-step guidance from the RED protocol phase", () => {
    const guidance = getProtocolGuidance("WORKSPACE_PREPARED");
    expect(guidance.suggestedNextAction).toBe("capture_red");
    expect(guidance.cliExample).toContain("evidence capture-red");
    expect(guidance.mcpTool).toBe("contrib_capture_red");
    expect(guidance.forbiddenActions.length).toBeGreaterThan(0);
    expect(guidance.invariants.length).toBeGreaterThan(0);
  });

  it("rejects unknown protocol phases", () => {
    expect(() =>
      getProtocolGuidance(
        "NOT_A_PHASE" as keyof typeof PROTOCOL_CONTRACT_PHASES,
      ),
    ).toThrow("Unknown protocol phase");
  });
});
