# Guardrails for agents in this repo

## The agent MUST NOT

- Edit this file (guardrails.md) itself — it is written and changed by humans, through review.
- Change anything in production — production changes reach production only through Git/CD.
- Push directly to the main branch — all changes go through pull request.
- Install software outside the project's declared dependencies.
- Send data to external services outside our approved list (docs/approved-domains.md).
- Run irreversible operations against shared systems — deletions, cleanup, resets.

## Git commits

- Never commit personal data about people outside the team — customers, users, or other third parties (names combined with identity information, addresses, phone numbers, emails, health data).
- Never commit credentials, secrets, API keys, or tokens that grant access to a system.
- The team's own names as attribution in content meant to be published (blog bylines, author fields, copyright headers) are fine.

## The agent MAY

- Inspect any environment read-only.
- Run tests, lint, and builds locally.
- Create branches and push feature branches.
- Read documentation from the approved sources in docs/approved-domains.md.
