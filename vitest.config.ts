import { defineConfig } from 'vitest/config'
import { loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  // Load .env.local (and .env) into process.env so integration tests can read them
  const env = loadEnv(mode ?? 'test', process.cwd(), '')
  Object.assign(process.env, env)

  return {
    test: {
      environment: 'node',
      include: [
        'src/**/*.test.ts',
        'server/**/*.test.ts',
        'test/**/*.test.ts',
      ],
      coverage: {
        provider: 'v8',
        include: ['src/**/*.ts', 'server/**/*.ts'],
        exclude: ['**/*.test.ts', '**/*.d.ts'],
      },
    },
  }
})
