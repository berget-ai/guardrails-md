import { configDefaults, defineConfig } from "vitest/config"

// test/claude/ runs under `claude plugin test` (npm run test:claude), not vitest.
export default defineConfig({ test: { exclude: [...configDefaults.exclude, "test/claude/**"] } })
