/**
 * Process CLI home selection before any command module imports construct
 * storage-bound defaults.  Commander hooks run too late for ESM module
 * initialization, so this tiny side-effect module is deliberately imported
 * first by the CLI entrypoint.
 */
const homeFlagIndex = process.argv.findIndex(
  (value) => value === "--home" || value.startsWith("--home="),
);
if (homeFlagIndex >= 0) {
  const value = process.argv[homeFlagIndex];
  const home = value.startsWith("--home=")
    ? value.slice("--home=".length)
    : process.argv[homeFlagIndex + 1];
  if (home && !home.startsWith("--")) {
    process.env.OPENCONTRIB_HOME = home;
  }
}
