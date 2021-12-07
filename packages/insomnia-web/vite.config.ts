import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react({ babel: { parserOpts: { plugins: ['decorators-legacy'] } } })
  ],
  resolve: {
    mainFields: ['browser'],
    alias: {
      "crypto": path.resolve(__dirname, '../insomnia-app/node_modules/crypto-browserify'),
      "path": path.resolve(__dirname, '../insomnia-app/node_modules/path-browserify'),
    }
  },
  optimizeDeps: {
    include: [
      'insomnia-xpath',
      'insomnia-prettify',
      'insomnia-testing',
      'insomnia-importers',
      'insomnia-components',
      'insomnia-common',
      'insomnia-cookies',
      'insomnia-url',
      'insomnia-config'
    ],
  },
})
