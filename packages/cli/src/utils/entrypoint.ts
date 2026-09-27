export function isTestEntrypoint(entryPath: string): boolean {
  const normalizedEntry = entryPath.replace(/\\/g, "/").toLowerCase();
  const entryParts = normalizedEntry.split("/");
  const entryDirectory = entryParts.at(-2) ?? "";
  const entryFile = entryParts.at(-1) ?? "";

  return (
    /^(?:__tests__|tests?)$/.test(entryDirectory) ||
    /^(?:test|spec)/.test(entryFile) ||
    /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/.test(entryFile)
  );
}
