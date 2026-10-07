import { expect, it } from "bun:test";
import { renderWorkflowGuide } from "../src/workflow/protocol-renderer.js";

it("renders workspace preparation before context assembly", () => {
  const guide = renderWorkflowGuide({ targetRepo: "owner/repo" });
  const workspace = guide.indexOf("contrib_prepare_workspace");
  const context = guide.indexOf("contrib_assemble_context");

  expect(workspace).toBeGreaterThanOrEqual(0);
  expect(context).toBeGreaterThan(workspace);
});
