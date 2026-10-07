import { describe, expect, it } from "bun:test";
import {
  getProtocolGuidance,
  PROTOCOL_CONTRACT_PHASES,
} from "@opencontrib/core";
import { program } from "../src/index.js";

const registeredCommands = program.commands;

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

  it("derives workspace next-step guidance from the context protocol phase", () => {
    const guidance = getProtocolGuidance("WORKSPACE_PREPARED");
    expect(guidance.suggestedNextAction).toBe("assemble_context");
    expect(guidance.cliExample).toContain("discovery context");
    expect(guidance.mcpTool).toBe("contrib_assemble_context");
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

describe("Lifecycle review regressions", () => {
  it("guides workspace preparation before context and RED", () => {
    expect(PROTOCOL_CONTRACT_PHASES.OPPORTUNITY_SCOUTED.suggestedNextAction).toBe("prepare_workspace");
    expect(PROTOCOL_CONTRACT_PHASES.PROBE_COMPLETED.suggestedNextAction).toBe("prepare_workspace");
    expect(PROTOCOL_CONTRACT_PHASES.WORKSPACE_PREPARED.suggestedNextAction).toBe("assemble_context");
    expect(PROTOCOL_CONTRACT_PHASES.CONTEXT_ASSEMBLED.suggestedNextAction).toBe("capture_red");
  });
});
