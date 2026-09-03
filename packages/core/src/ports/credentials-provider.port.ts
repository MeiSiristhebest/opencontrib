/**
 * CredentialsProvider port.
 *
 * Resolves the GitHub token used to authenticate the API client. Extracted
 * as a port so production code (env → config file → `gh` CLI fallback) and
 * tests (injected fake) share a single contract — the adapter-inversion
 * required by the architecture review (§6 DIP, §16 stage 4).
 */
export interface CredentialsProvider {
  /** The resolved token (may be empty for anonymous/unauthenticated access). */
  getToken(): string;
  /**
   * A stable, non-secret identity derived from the token, used to partition
   * the response cache so two different tokens never share cached payloads.
   */
  getTokenScope(): string;
}
