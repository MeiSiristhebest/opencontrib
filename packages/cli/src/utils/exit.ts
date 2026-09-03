/**
 * CliExitError — a typed signal that a command action wants the process to
 * terminate with a specific exit code.
 *
 * Command actions (the "view" layer) should NEVER call `process.exit`
 * directly: doing so couples presentation logic to process lifecycle and makes
 * the actions impossible to test or compose. Instead an action throws a
 * `CliExitError`, and the CLI entry point (the boundary) is the single place
 * that translates that signal into `process.exit(<code>)`.
 *
 * This is the "passive view" discipline from the architecture SOP: the view
 * renders output and reports intent; the boundary owns side effects like
 * process termination.
 */

export class CliExitError extends Error {
  readonly exitCode: number;

  constructor(exitCode: number, message?: string) {
    super(message ?? `Command requested process exit with code ${exitCode}`);
    this.name = 'CliExitError';
    this.exitCode = exitCode;
    // Restore prototype chain (TS extends built-ins transpiled to ES5/ES2017).
    Object.setPrototypeOf(this, CliExitError.prototype);
  }
}
