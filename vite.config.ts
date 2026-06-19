import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2020',
    // PDF.js + the worker are large; this just silences the size warning.
    chunkSizeWarningLimit: 2000,
  },
});
