import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Many suites start subprocesses or write journals. Bound simultaneous I/O
  // instead of relaxing the per-test deadlines on machines with many CPUs.
  test: { include: ['src/**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs,mts,cts}'], maxWorkers: 4 }
})
