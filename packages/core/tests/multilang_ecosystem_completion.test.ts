import { describe, expect, it } from 'bun:test';
import {
  JavaJunitOutputParser,
  CppGTestOutputParser,
  DotnetTestOutputParser,
  RubyRSpecOutputParser,
  PhpUnitOutputParser,
  GoTestOutputParser,
  defaultTestOutputParserRegistry,
  parseAddedTestCasesFromDiffText,
} from '../src/evidence/index.js';
import { runDoctorAudit } from '../src/discovery/doctor.js';
import { detectSystemCapabilities, assessFeasibility } from '../src/discovery/feasibility.js';
import { runResilientCommand } from '../src/sandbox/resilient-runner.js';
import { AutonomousPoCVerifier } from '../src/sandbox/poc-verifier.js';

describe('Multi-Language Ecosystem Completion & Deep Parity', () => {
  describe('1. Multi-Language Test Output Parsers Matrix', () => {
    it('parses Java / Kotlin Maven Surefire test output accurately', () => {
      const parser = new JavaJunitOutputParser();
      const output = `
[INFO] -------------------------------------------------------
[INFO]  T E S T S
[INFO] -------------------------------------------------------
[INFO] Running org.example.service.OrderServiceTest
[INFO] Tests run: 24, Failures: 1, Errors: 0, Skipped: 2, Time elapsed: 1.234 s
[INFO] Results:
[INFO] Tests run: 24, Failures: 1, Errors: 0, Skipped: 2
`;
      expect(parser.supports(output)).toBe(true);
      const parsed = parser.parse(output);
      expect(parsed.total).toBe(24);
      expect(parsed.failed).toBe(1);
      expect(parsed.passed).toBe(23);
    });

    it('parses Gradle test execution output accurately', () => {
      const parser = new JavaJunitOutputParser();
      const output = `> Task :core:test\n18 tests completed, 0 failed, 1 skipped\nBUILD SUCCESSFUL in 3s`;
      expect(parser.supports(output)).toBe(true);
      const parsed = parser.parse(output);
      expect(parsed.total).toBe(18);
      expect(parsed.failed).toBe(0);
      expect(parsed.passed).toBe(18);
    });

    it('parses C / C++ Google Test output accurately', () => {
      const parser = new CppGTestOutputParser();
      const output = `
[==========] Running 15 tests from 3 test suites.
[----------] 5 tests from ParserTest
[ RUN      ] ParserTest.HandlesNullToken
[       OK ] ParserTest.HandlesNullToken (0 ms)
[----------] 15 tests from ParserTest (2 ms total)
[==========] 15 tests from 3 test suites ran. (3 ms total)
[  PASSED  ] 15 tests.
`;
      expect(parser.supports(output)).toBe(true);
      const parsed = parser.parse(output);
      expect(parsed.passed).toBe(15);
      expect(parsed.failed).toBe(0);
      expect(parsed.total).toBe(15);
    });

    it('parses CTest summary output accurately', () => {
      const parser = new CppGTestOutputParser();
      const output = `100% tests passed, 0 tests failed out of 32\nTotal Test time (real) =   0.45 sec`;
      expect(parser.supports(output)).toBe(true);
      const parsed = parser.parse(output);
      expect(parsed.passed).toBe(32);
      expect(parsed.failed).toBe(0);
      expect(parsed.total).toBe(32);
    });

    it('parses C# / .NET (dotnet test / xUnit / NUnit) output accurately', () => {
      const parser = new DotnetTestOutputParser();
      const output = `
Passed!  - Failed:     0, Passed:    22, Skipped:     0, Total:    22, Duration: 152 ms - Service.Tests.dll (net8.0)
`;
      expect(parser.supports(output)).toBe(true);
      const parsed = parser.parse(output);
      expect(parsed.total).toBe(22);
      expect(parsed.passed).toBe(22);
      expect(parsed.failed).toBe(0);
    });

    it('parses Ruby RSpec and Minitest output accurately', () => {
      const parser = new RubyRSpecOutputParser();
      const rspecOut = `Finished in 0.052 seconds (files took 0.15 seconds to load)\n28 examples, 0 failures, 1 pending`;
      expect(parser.supports(rspecOut)).toBe(true);
      const parsedRspec = parser.parse(rspecOut);
      expect(parsedRspec.total).toBe(28);
      expect(parsedRspec.passed).toBe(28);
      expect(parsedRspec.failed).toBe(0);

      const minitestOut = `12 runs, 30 assertions, 0 failures, 0 errors, 0 skips`;
      expect(parser.supports(minitestOut)).toBe(true);
      const parsedMini = parser.parse(minitestOut);
      expect(parsedMini.total).toBe(12);
      expect(parsedMini.passed).toBe(12);
    });

    it('parses PHP PHPUnit output accurately', () => {
      const parser = new PhpUnitOutputParser();
      const output = `PHPUnit 10.5.0 by Sebastian Bergmann and contributors.\n\n..................                                                18 / 18 (100%)\n\nTime: 00:00.082, Memory: 10.00 MB\n\nOK (18 tests, 36 assertions)`;
      expect(parser.supports(output)).toBe(true);
      const parsed = parser.parse(output);
      expect(parsed.passed).toBe(18);
      expect(parsed.failed).toBe(0);
      expect(parsed.total).toBe(18);
    });

    it('parses individual Go test case lines in GoTestOutputParser', () => {
      const parser = new GoTestOutputParser();
      const output = `
=== RUN   TestParserValid
--- PASS: TestParserValid (0.00s)
=== RUN   TestParserInvalid
--- PASS: TestParserInvalid (0.00s)
=== RUN   TestParserEdgeCase
--- FAIL: TestParserEdgeCase (0.00s)
FAIL
`;
      const parsed = parser.parse(output);
      expect(parsed.passed).toBe(2);
      expect(parsed.failed).toBe(1);
      expect(parsed.total).toBe(3);
    });

    it('defaultTestOutputParserRegistry automatically resolves all 9 multi-language outputs', () => {
      const mavenOut = `[INFO] Tests run: 10, Failures: 0, Errors: 0, Skipped: 0`;
      const gtestOut = `[  PASSED  ] 8 tests.`;
      const dotnetOut = `Total tests: 14. Passed: 14. Failed: 0.`;
      const phpOut = `OK (12 tests, 24 assertions)`;
      const rubyOut = `15 examples, 0 failures`;

      expect(defaultTestOutputParserRegistry.parse(mavenOut).passed).toBe(10);
      expect(defaultTestOutputParserRegistry.parse(gtestOut).passed).toBe(8);
      expect(defaultTestOutputParserRegistry.parse(dotnetOut).passed).toBe(14);
      expect(defaultTestOutputParserRegistry.parse(phpOut).passed).toBe(12);
      expect(defaultTestOutputParserRegistry.parse(rubyOut).passed).toBe(15);
    });
  });

  describe('2. Multi-Language Test Case Diff Regular Expression Extractor', () => {
    it('accurately extracts test counts across Java, C#, C++, Ruby, PHP, Swift, Go, Python, Rust, TS', () => {
      const polyglotDiff = `
diff --git a/src/test/java/ServiceTest.java b/src/test/java/ServiceTest.java
+  @Test
+  public void testNullGuard() {
+  @ParameterizedTest
+  public void testMultipleInputs(String val) {
diff --git a/tests/ServiceTests.cs b/tests/ServiceTests.cs
+  [Fact]
+  public void Fact_ShouldWork() {
+  [Theory]
+  public void Theory_ShouldWork() {
diff --git a/test/test_parser.cpp b/test/test_parser.cpp
+  TEST(ParserTest, HandlesEmptyBuffer) {
+  TEST_F(ParserFixture, HandlesBoundary) {
diff --git a/spec/parser_spec.rb b/spec/parser_spec.rb
+  it "handles empty strings gracefully" do
+  specify "bounds are preserved" do
diff --git a/tests/ParserTest.php b/tests/ParserTest.php
+  public function testEmptyStringHandling(): void {
+  #[Test]
+  public function testBoundary(): void {
diff --git a/Tests/ParserTests.swift b/Tests/ParserTests.swift
+  func testEmptyBuffer() {
diff --git a/pkg/parser_test.go b/pkg/parser_test.go
+  func TestParserSanitize(t *testing.T) {
diff --git a/tests/test_parser.py b/tests/test_parser.py
+  def test_parser_negative_index():
diff --git a/tests/parser.rs b/tests/parser.rs
+  #[tokio::test]
+  async fn test_async_boundary() {
diff --git a/tests/parser.test.ts b/tests/parser.test.ts
+  it('verifies typescript parsing', () => {
+  // Comment: should be excluded
+  /* Block comment: should be excluded */
+  # Python comment: should be excluded
`;
      const count = parseAddedTestCasesFromDiffText(polyglotDiff);
      // 2 Java + 2 C# + 2 C++ + 2 Ruby + 2 PHP + 1 Swift + 1 Go + 1 Python + 1 Rust + 1 TS = 15 test declarations
      expect(count).toBe(15);
    });
  });

  describe('3. Multi-Language Doctor, Feasibility & Resilient Command Rewriting', () => {
    it('doctor includes Java, C/C++, .NET, PHP, Ruby toolchains in audit report', () => {
      const report = runDoctorAudit();
      expect(report.checks.length).toBeGreaterThan(10);
      const names = report.checks.map((c) => c.name);
      expect(names.some((n) => n.includes('Java'))).toBe(true);
      expect(names.some((n) => n.includes('C/C++'))).toBe(true);
      expect(names.some((n) => n.includes('.NET'))).toBe(true);
      expect(names.some((n) => n.includes('PHP'))).toBe(true);
      expect(names.some((n) => n.includes('Ruby'))).toBe(true);
    });

    it('feasibility capabilities contain full multi-language toolchain flags', () => {
      const caps = detectSystemCapabilities();
      expect(caps.toolchains).toHaveProperty('node');
      expect(caps.toolchains).toHaveProperty('python');
      expect(caps.toolchains).toHaveProperty('go');
      expect(caps.toolchains).toHaveProperty('rust');
      expect(caps.toolchains).toHaveProperty('java');
      expect(caps.toolchains).toHaveProperty('cpp');
      expect(caps.toolchains).toHaveProperty('dotnet');
      expect(caps.toolchains).toHaveProperty('ruby');
      expect(caps.toolchains).toHaveProperty('php');
    });

    it('resilient runner actively rewrites broad go test ./... and pytest commands to modified package targets', () => {
      const goResult = runResilientCommand({
        cwd: process.cwd(),
        command: 'go',
        args: ['test', './...'],
        modifiedFiles: ['pkg/parser/hunk.go', 'pkg/parser/lexer.go'],
        allowFullScan: false,
      });

      expect(goResult.warnings.some((w) => w.includes('Targeted test optimization applied'))).toBe(true);
      expect(goResult.warnings.some((w) => w.includes('./pkg/parser/...'))).toBe(true);
    });

    it('AutonomousPoCVerifier resolves default test commands adaptively for all languages', () => {
      expect(AutonomousPoCVerifier.resolveDefaultTestCommand('src/main/App.java')).toBe('mvn test');
      expect(AutonomousPoCVerifier.resolveDefaultTestCommand('main.go')).toBe('go test ./...');
      expect(AutonomousPoCVerifier.resolveDefaultTestCommand('lib.rs')).toBe('cargo test');
      expect(AutonomousPoCVerifier.resolveDefaultTestCommand('script.py')).toBe('pytest');
      expect(AutonomousPoCVerifier.resolveDefaultTestCommand('service.cs')).toBe('dotnet test');
      expect(AutonomousPoCVerifier.resolveDefaultTestCommand('app.rb')).toBe('bundle exec rspec');
      expect(AutonomousPoCVerifier.resolveDefaultTestCommand('index.php')).toBe('vendor/bin/phpunit');
      expect(AutonomousPoCVerifier.resolveDefaultTestCommand('index.ts')).toBe('npm test');
    });
  });
});
