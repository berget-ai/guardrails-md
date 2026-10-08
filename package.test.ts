import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("package metadata", () => {
  it("Given a version bump, When plugin.json is checked, Then it matches package.json", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "package.json"), "utf8"))
    const plugin = JSON.parse(readFileSync(join(import.meta.dirname, ".claude-plugin", "plugin.json"), "utf8"))
    expect(plugin.version).toBe(pkg.version)
  })

  it("Given one package for every harness, When package.json is checked, Then it has the harness-neutral name and the pi-package keyword", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "package.json"), "utf8"))
    expect(pkg.name).toBe("@bergetai/guardrails-md")
    expect(pkg.keywords).toContain("pi-package")
  })
})
