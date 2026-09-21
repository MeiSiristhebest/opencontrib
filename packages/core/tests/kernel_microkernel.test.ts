import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  PluginHost,
  SmartPointerStore,
  createDefaultPluginHost,
  type OpenContribPlugin,
  type PluginContext,
  type RepoFingerprint,
} from "../src/index.js";

describe("OpenContrib Microkernel & Smart Pointer Architecture", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "opencontrib-kernel-test-"),
    );
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("initializes PluginHost and registers/activates plugins dynamically", async () => {
    const host = new PluginHost({ workspacePath: tempDir });
    let activated = false;

    const mockPlugin: OpenContribPlugin = {
      name: "mock-security-plugin",
      version: "1.0.0",
      permissions: ["fs:read"],
      activate: (ctx: PluginContext) => {
        activated = true;
        ctx.probes.register({
          id: "mock-probe",
          name: "Mock Probe",
          category: "security_cwe",
          description: "A test probe",
          match: (fp) => fp.primaryLanguage === "Go",
          scan: async (_targetPath, pointers) => {
            pointers.create({
              id: "mock-finding-1",
              title: "Mock Vulnerability",
              category: "security_cwe",
              severity: "high",
              file: "main.go",
              line: 42,
              confidence: 95,
              slice: {
                codeSnippet: "dangerousCall();",
                ruleExplanation: "Call is dangerous",
              },
            });
          },
        });
      },
    };

    await host.registerPlugin(mockPlugin);
    expect(activated).toBe(true);
    expect(
      host.listPlugins().some((p) => p.name === "mock-security-plugin"),
    ).toBe(true);
    expect(host.get("mock-probe")?.name).toBe("Mock Probe");
  });

  it("manages Smart Pointers with 3-level progressive dereferencing", () => {
    const store = new SmartPointerStore({
      storageDir: path.join(tempDir, "pointers"),
      scope: tempDir,
    });

    const ptr = store.create({
      namespace: "findings",
      id: "npe-auth-handler-12",
      title: "Potential Nil Pointer Dereference in Auth Handler",
      category: "lifecycle_leak",
      severity: "high",
      file: "pkg/auth/handler.go",
      line: 88,
      confidence: 94,
      slice: {
        codeSnippet:
          'user := req.Context().Value("user").(*User)\nreturn user.ID',
        ruleExplanation:
          "Type assertion without comma-ok check panics when unauthenticated context reaches handler.",
        remediationSuggestion:
          'user, ok := req.Context().Value("user").(*User)\nif !ok { return ErrUnauthorized }',
      },
      evidence: {
        astDataFlow:
          "req.Context() -> Value() -> unchecked cast -> user.ID deref",
        pocCode: "func TestAuthPanic(t *testing.T) { ... }",
        executionCommand: "go test -run TestAuthPanic",
      },
    });

    expect(ptr.id).toMatch(/^v2-[0-9a-f]{64}$/);
    expect(ptr.uri).toBe(`ptr://findings/${ptr.id}`);
    expect(ptr.legacyUri).toBe("ptr://findings/npe-auth-handler-12");

    // Level 1: Stub (~25 tokens)
    const stubResult = store.resolve(ptr.legacyUri!, "stub") as any;
    expect(stubResult.id).toBe(ptr.id);
    expect(stubResult.legacyId).toBe("npe-auth-handler-12");
    expect(stubResult.file).toBe("pkg/auth/handler.go");
    expect(stubResult.slice).toBeUndefined();
    expect(stubResult.evidence).toBeUndefined();

    // Level 2: Slice (~150 tokens)
    const sliceResult = store.resolve(ptr.legacyUri!, "slice") as any;
    expect(sliceResult.slice).toBeDefined();
    expect(sliceResult.slice.codeSnippet).toContain("user.ID");
    expect(sliceResult.evidence).toBeUndefined();

    // Level 3: Evidence (Deep payload & PoC)
    const evidenceResult = store.resolve(
      `${ptr.legacyUri}?view=evidence`,
      "slice",
    ) as any;
    expect(evidenceResult.evidence).toBeDefined();
    expect(evidenceResult.evidence.astDataFlow).toContain("unchecked cast");
    expect(evidenceResult.evidence.executionCommand).toBe(
      "go test -run TestAuthPanic",
    );
  });

  it("rejects tampered content-addressed pointers during hydration and collision reads", () => {
    const storageDir = path.join(tempDir, "pointers");
    const scope = path.join(tempDir, "repo");
    fs.mkdirSync(scope, { recursive: true });
    const input = {
      namespace: "findings",
      id: "cross-process-finding",
      title: "Cross-process finding",
      category: "security_cwe" as const,
      severity: "high" as const,
      file: "src/handler.ts",
      line: 12,
      slice: { codeSnippet: "dangerous();" },
    };

    const first = new SmartPointerStore({ storageDir, scope });
    const pointer = first.create(input);
    const second = new SmartPointerStore({ storageDir, scope });
    expect(second.get(pointer.uri)?.id).toBe(pointer.id);
    expect(second.create(input).id).toBe(pointer.id);

    const pointerFile = path.join(storageDir, `findings_${pointer.id}.json`);
    const tampered = JSON.parse(fs.readFileSync(pointerFile, "utf8"));
    tampered.stub.title = "tampered";
    fs.writeFileSync(pointerFile, JSON.stringify(tampered), "utf8");

    expect(() => new SmartPointerStore({ storageDir, scope })).toThrow(
      /PointerStoreIntegrityError/,
    );
    first.clear();
    expect(() => first.create(input)).toThrow(/PointerStoreIntegrityError/);
  });

  it("rejects renamed namespace files and storage-scope mismatches during hydration", () => {
    const storageDir = path.join(tempDir, "pointers");
    const scope = path.join(tempDir, "repo");
    const otherScope = path.join(tempDir, "other-repo");
    fs.mkdirSync(scope, { recursive: true });
    fs.mkdirSync(otherScope, { recursive: true });

    const store = new SmartPointerStore({ storageDir, scope });
    const pointer = store.create({
      namespace: "findings",
      id: "filename-integrity",
      title: "Filename integrity",
      category: "security_cwe",
      severity: "medium",
      file: "src/file.ts",
      line: 4,
    });
    const canonicalFile = path.join(storageDir, `findings_${pointer.id}.json`);
    const renamedFile = path.join(storageDir, `other_${pointer.id}.json`);
    fs.renameSync(canonicalFile, renamedFile);

    expect(() => new SmartPointerStore({ storageDir, scope })).toThrow(
      /PointerStoreIntegrityError/,
    );

    fs.renameSync(renamedFile, canonicalFile);
    expect(() => new SmartPointerStore({ storageDir, scope: otherScope })).toThrow(
      /PointerStoreIntegrityError/,
    );
  });

  it("keeps namespace-colliding producer IDs content-addressed and separately hydrated", () => {
    const storageDir = path.join(tempDir, "namespace-pointers");
    const scope = path.join(tempDir, "repo");
    fs.mkdirSync(scope, { recursive: true });
    const writer = new SmartPointerStore({ storageDir, scope });

    const findings = writer.create({
      namespace: "findings",
      id: "same-producer-id",
      title: "Finding namespace",
      category: "security_cwe",
      severity: "high",
      file: "src/finding.ts",
      line: 1,
    });
    const probes = writer.create({
      namespace: "probes",
      id: "same-producer-id",
      title: "Probe namespace",
      category: "security_cwe",
      severity: "high",
      file: "src/probe.ts",
      line: 1,
    });

    expect(findings.id).not.toBe(probes.id);
    expect(fs.existsSync(path.join(storageDir, `findings_${findings.id}.json`))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(storageDir, `probes_${probes.id}.json`))).toBe(
      true,
    );

    const hydrated = new SmartPointerStore({ storageDir, scope });
    expect(hydrated.resolve(findings.uri, "stub")).toMatchObject({
      id: findings.id,
      namespace: "findings",
    });
    expect(hydrated.resolve(probes.uri, "stub")).toMatchObject({
      id: probes.id,
      namespace: "probes",
    });
  });

  it("performs dynamic capability negotiation against repository fingerprints", async () => {
    const host = await createDefaultPluginHost({ workspacePath: tempDir });

    const goFingerprint: RepoFingerprint = {
      repoPath: tempDir,
      primaryLanguage: "Go",
      languages: [{ language: "Go", percentage: 100, filesCount: 15 }],
      manifests: ["go.mod"],
      frameworks: [],
      hasTests: true,
      hasWorkflows: false,
      totalFiles: 15,
    };

    const negotiation = host.negotiate(goFingerprint);
    const selectedIds = negotiation.selectedProbes.map((p) => p.id);

    // OCR, ast-grep, git-hotspot, property-fuzz match Go
    expect(selectedIds).toContain("ocr");
    expect(selectedIds).toContain("ast-grep");
    expect(selectedIds).toContain("git-hotspot");
    expect(selectedIds).toContain("property-fuzz");

    // Workflow linter skipped (no workflows in this fingerprint)
    expect(selectedIds).not.toContain("workflow-linter");
  });

  it("executes scan and populates Smart Pointer store", async () => {
    const host = await createDefaultPluginHost({ workspacePath: tempDir });

    // Create a mock git workflow in tempDir
    const wfDir = path.join(tempDir, ".github", "workflows");
    fs.mkdirSync(wfDir, { recursive: true });
    fs.writeFileSync(
      path.join(wfDir, "ci.yml"),
      "name: CI\non: push\njobs:\n  build:\n    steps:\n      - uses: actions/checkout@v2\n",
    );

    const fp: RepoFingerprint = {
      repoPath: tempDir,
      primaryLanguage: "TypeScript",
      languages: [{ language: "TypeScript", percentage: 100, filesCount: 2 }],
      manifests: [".github/workflows"],
      frameworks: [],
      hasTests: false,
      hasWorkflows: true,
      totalFiles: 2,
    };

    const { selectedProbes } = host.negotiate(fp, {
      only: ["workflow-linter"],
    });
    const result = await host.executeScan(tempDir, selectedProbes);

    expect(result.executedProbes).toContain("workflow-linter");
    expect(result.pointersCreated.length).toBeGreaterThan(0);
    expect(result.pointersCreated[0].id).toMatch(/^v2-[0-9a-f]{64}$/);
    expect(result.pointersCreated[0].legacyId).toContain("ci-deprecated");
  });
});
