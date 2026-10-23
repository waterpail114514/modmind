import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs,mts,cts}', 'feature-plugins/**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs,mts,cts}'],
    maxWorkers: 4,
    setupFiles: ['src/main/__fixtures__/studioTestSetup.ts']
  }
})
