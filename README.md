# guardrails-md

Stops your coding agent from running the bash command you'd regret.

Every bash command your coding agent ([opencode](https://opencode.ai) or
[pi](https://pi.dev)) is about to execute is
scored by a small decision model first, in about 100 ms. If the command
destroys data, leaks a secret, or breaks a rule in your repo's
`guardrails.md`, the call is blocked and the agent is told why, so it can
pick another route.

```
SystemOne-gate: blocked command — destructive=0.98 > 0.7
  rm -rf ./important-data
Judged destructive/leaking on its own merits — named exceptions in
guardrails.md do not override this. If it is intended, your human
can run it directly, or restart opencode with SYSTEMONE_GATE=off
for a session that needs it. The agent must not edit guardrails.md
to work around this.
```

## When it helps

Two situations where a pattern list leaves you exposed.

Teams that work close to production. The agent runs `kubectl`, `helm` and
`git push` all day, and the difference between routine and incident is your
team's policy, not a filename pattern. The gate reads that policy from
`guardrails.md` and applies it to every command.

Background agents that read mail, tickets or forms. Their input is written
by strangers, and a crafted message can talk an agent into running
something harmful. No one is watching when it happens. The gate does not
promise that the agent cannot be persuaded — it promises that the boundary
holds anyway, because the gate judges the command and your rules, not the
conversation that led to it.

## Quickstart

Two steps. First teach the gate your rules, then put it in the harness.

**1. Add `guardrails.md` to your repo** (root, `.opencode/guardrails.md` or
`.pi/guardrails.md`).
Write it yourself — the value is in deciding what your team actually allows,
not in shipping a generic file. The example below is a starting point for the
shape:

```markdown
# Guardrails for agents in this repo

## The agent MUST NOT

- Edit this file (guardrails.md) itself — it is written and changed by humans, through review.
- Change anything in production — production changes reach production only through Git/CD.
- Push directly to the main branch — all changes go through pull request.
- Install software outside the project's declared dependencies.
- Send data to external services outside our approved list (docs/approved-domains.md).
- Run irreversible operations against shared systems — deletions, cleanup, resets.

## The agent MAY

- Inspect any environment read-only.
- Run tests, lint, and builds locally.
- Create branches and push feature branches.
- Read documentation from the approved sources in docs/approved-domains.md.
```

The gate reads the file once at session start, so restart the harness after
editing. Only the first 2000 characters are sent to the model, so keep the
file short and put the MUST NOT rules first. If the file is longer, the gate
warns you at startup and in every block message, and the rules after the cut
are not applied.
See [`guardrails.example.md`](guardrails.example.md).

**2. Install the gate in your harness.**

For opencode, add the plugin to `opencode.json` (global or per project):

```json
{
  "plugin": ["@bergetai/opencode-guardrails-md"]
}
```

For pi, install from a clone of this repo (an npm release for pi is coming):

```sh
git clone https://github.com/berget-ai/guardrails-md
cd guardrails-md && npm install
pi install ./
```

Set a key and restart the harness (plugins and extensions load at startup):

```sh
export BERGET_API_KEY=…
```

Keys come from [berget.ai](https://berget.ai). The free tier includes €5 of
credit, and a gate call is small enough that it lasts a long time. If you
are logged in to Berget in your harness (`@bergetai/opencode-auth` in opencode,
`/login` in pi), skip the key: the gate picks up your seat token. If you run your own
System One-compatible endpoint, point `BERGET_BASE_URL` at it instead.

From now on, every bash command your agent runs has to pass your guardrails
before it is allowed. Above the threshold the command is blocked with an
explanation the agent can read; below it, it runs.

## Git pre-commit hook

The same judgement works as a git pre-commit hook: every commit's staged
diff is scored before it enters the repository. Personal data (GDPR) and
secrets are blocked; the team's own names in bylines and author fields pass.

Install for every repo on your machine (uses your global `core.hooksPath` if
you have one, otherwise copy to `.git/hooks/pre-commit` per repo):

```sh
npx guardrails-md pre-commit
```

Or chain it from your global pre-commit hook (or create one):

```bash
# ~/.git-hooks/pre-commit
npx guardrails-md pre-commit || exit 1
```

Same env config as the plugin. Fail-closed by default: if the endpoint is
unreachable the commit is blocked — retry, or set `SYSTEMONE_FAIL_OPEN=1`.
