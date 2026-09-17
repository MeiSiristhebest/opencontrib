# Security Policy

## Reporting Security Issues

OpenContrib takes security vulnerabilities seriously.

If you believe you have found a security issue, please do not open a public issue. Instead, report it confidentially by creating a private security advisory on GitHub or by contacting the maintainer via GitHub profile.

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |

## Trusted Host Deployment Boundary

OpenContrib treats the agent process as untrusted, including agents that can
execute arbitrary shell commands. The following boundary is mandatory for any
real provider submission:

- The agent-facing CLI/MCP surfaces only create immutable submission intents,
  issue approval challenges, and call `OPENCONTRIB_SUBMISSION_BROKER_URL`.
  They do not load GitHub write credentials and have no approval/minting CLI or
  MCP operation.
- A separately deployed trusted approval/submission host owns the canonical run
  store, GitHub write credential, and Ed25519 approval private key. It persists
  challenges, verifies the current intent/evidence/governance hashes, accepts a
  human decision, signs the approval, and performs the final provider write.
- The agent may read or modify local JSON in its own OS account. That is not an
  isolation boundary. The broker store, signing key, and GitHub credential must
  be inaccessible to that account (separate process identity/container/VM and
  least-privilege credentials).
- Every submission must re-read canonical artifacts, verify the detached
  approval signature, verify the upstream base SHA, and record the provider
  attestation before transitioning the run to `PR_SUBMITTED`.

`RemoteSubmissionBrokerClient` intentionally fails closed when no HTTPS (or
loopback development) broker endpoint is configured. A local same-user broker
or a copied approval JSON file must not be described as a secure deployment.
