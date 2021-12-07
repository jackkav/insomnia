import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    mainFields:['browser'],
    alias: {
     "crypto": path.resolve(__dirname, '../insomnia-app/node_modules/crypto-browserify'),
    }
  }
})
