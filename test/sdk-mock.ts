import { vi } from "vitest"

export function createSdkMock() {
  const systemOne = vi.fn()
  const configs: Record<string, unknown>[] = []
  const module = {
    noul: (instructions: string) => ({ type: "noul", instructions }),
    TypeSafeClient: class {
      constructor(public cfg: Record<string, unknown>) {
        configs.push(cfg)
      }
      systemOne(req: unknown) {
        return systemOne(req)
      }
    },
  }
  return { systemOne, configs, module }
}
