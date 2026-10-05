#!/usr/bin/env node
/**
 * guardrails-md — git pre-commit hook.
 *
 *   npx guardrails-md pre-commit
 *
 * Reads the staged diff and the repo's guardrails.md (the same file the
 * agent gate reads), and asks a decision model two questions before the
 * commit is allowed: does the diff introduce personal data in violation of
 * the git-content rules, and does it contain secrets?
 *
 * The guardrails.md git-commit rules are part of the judgement — name the
 * exceptions there (for example "the team's own names as blog bylines are
 * fine") and the model follows them.
 *
 * Exit codes: 0 = allowed, 1 = blocked. Fail-closed by default; an
 * unreachable endpoint blocks the commit (SYSTEMONE_FAIL_OPEN=1 opts out).
 *
 * Config: BERGET_API_KEY, BERGET_BASE_URL, BERGET_MODEL,
 * SYSTEMONE_THRESHOLD, SYSTEMONE_FAIL_OPEN, SYSTEMONE_LOG.
 */
import { createGate } from "./core.ts"

const FAIL_OPEN = process.env.SYSTEMONE_FAIL_OPEN === "1"
const DIFF_CAP = 12000

const QUESTIONS = {
  personal_data: {
    type: "noul",
    instructions:
      "Given the team's guardrails in the state, does this diff introduce " +
      "personal data into the repository in violation of those rules — for " +
      "example a third party's name combined with identity information " +
      "(personal identity number, address, phone number, email), or health " +
      "data? The team's own names used as attribution in content meant to be " +
      "published — for example an author byline on a blog post, an author " +
      "field in a config file, or a copyright header — are not a violation. " +
      "A personal identity number, home address, or password is personal " +
      "data even when it belongs to a team member.",
  },
  secrets: {
    type: "noul",
    instructions:
      "Does this diff contain credentials, secrets, API keys, passwords, or " +
      "tokens that grant access to a system? Example-shaped placeholders and " +
      "test dummies do not count.",
  },
}

function stagedDiff(): string {
  const { execSync } = require("node:child_process")
  try {
    return execSync("git diff --cached --unified=0", {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    }).slice(0, DIFF_CAP)
  } catch {
    return ""
  }
}

async function main(): Promise<number> {
  const diff = stagedDiff()
  if (!diff.trim()) return 0 // nothing staged

  const gate = createGate(
    {
      name: "git",
      authPath: `${process.env.XDG_DATA_HOME ?? `${process.env.HOME}/.local/share`}/opencode/auth.json`,
      guardrailPaths: ["guardrails.md", ".opencode/guardrails.md", ".pi/guardrails.md"],
      logPath: `${process.env.HOME}/.cache/guardrails-md/pre-commit.log`,
    },
    process.cwd(),
  )

  const block = await gate.checkDiff(diff, QUESTIONS)
  if (!block) return 0

  process.stderr.write(block.reason + "\n")
  return 1
}

main().then(
  (code) => process.exit(code),
  (err) => {
    // Fail-closed: an unreachable endpoint blocks the commit.
    if (FAIL_OPEN) process.exit(0)
    process.stderr.write(
      `guardrails-md: endpoint unreachable — commit blocked.\n` +
        `  ${String(err).slice(0, 200)}\n` +
        `  Retry shortly, or set SYSTEMONE_FAIL_OPEN=1 to prefer availability.\n`,
    )
    process.exit(1)
  },
)
