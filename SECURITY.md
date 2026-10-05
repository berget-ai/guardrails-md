# Security Policy

## Reporting a vulnerability

Email security@berget.ai, or open a GitHub Security Advisory
("Report a vulnerability" under the Security tab). Please do not open a
public issue for anything exploitable.

We aim to acknowledge reports within two business days.

## Scope

- The gate code in this repository (core.ts and the opencode and pi adapters
  in adapters/).
- The published npm package `@bergetai/opencode-guardrails-md`.

## Known limitations (by design, documented in the README)

These are documented design decisions, not vulnerabilities — but if you
find a way to break the stated guarantees, we want to hear about it:

- The gate judges bash commands only; file edits pass through. In pi, the
  `powershell` tool is not gated.
- `guardrails.md` is read once at session start but lives in the repo —
  an agent with edit access can weaken the rules for the next session.
- The gate does not decode obfuscated payloads (base64 etc.).
- The model is a trained classifier (~96% on held-out tests) and errs in
  both directions.

## Data handling

Commands are sent to the configured System One endpoint for scoring.
Berget AI operates a zero data retention policy under EU data protection
law. Audit logging is opt-in (`SYSTEMONE_LOG=1`) and writes to your local
machine only.
