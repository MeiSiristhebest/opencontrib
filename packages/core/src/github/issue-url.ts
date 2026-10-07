/** Normalize the configured API host to the host used in browser issue URLs. */
export function normalizeGitHubIssueHost(host = "github.com"): string {
  const candidate = host.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(`https://${candidate}`);
  } catch {
    throw new Error("GitHubHostError: configured GitHub host is invalid.");
  }

  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("GitHubHostError: configured GitHub host must be a host name.");
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    !parsed.port &&
    (hostname === "github.com" || hostname === "api.github.com")
  ) {
    return "github.com";
  }
  return parsed.host.toLowerCase();
}

export function canonicalGitHubIssueUrl(
  host: string | undefined,
  repoFullName: string,
  issueNumber: number,
): string {
  return `https://${normalizeGitHubIssueHost(host)}/${repoFullName}/issues/${issueNumber}`;
}
