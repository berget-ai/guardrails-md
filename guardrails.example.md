# Guardrails for agents in this repo

## The agent MUST NOT

- Run `kubectl` against production clusters (any namespace) — prod changes only via Git/CD.
- Run `git push` directly to `main` — all changes via pull request.
- Install packages globally (`npm install -g`, `pip install` outside a venv).
- Send data to external domains outside the approved list in `docs/approved-domains.md`.
- Run `docker system prune`, `kubectl delete namespace`, or other irreversible cleanup.

## The agent MAY

- Read all clusters (`kubectl get/describe/logs`) in every environment.
- Run tests, lint, and builds locally.
- Create branches and push feature branches.
- Fetch documentation from the approved docs sites listed in `docs/approved-domains.md`.
