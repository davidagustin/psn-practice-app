/**
 * ==============================================================================
 * VITE CONFIGURATION
 * ==============================================================================
 *
 * Vite is a modern frontend build tool that provides:
 * - Instant hot module replacement (HMR)
 * - Fast development server
 * - Optimized production builds
 *
 * WHY VITE OVER WEBPACK?
 * - 10-100x faster development server startup
 * - Native ES modules in development
 * - Simpler configuration
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],

  /**
   * DEVELOPMENT SERVER CONFIG
   *
   * Configure the dev server to work with our backend.
   */
  server: {
    port: 3000,

    /**
     * PROXY CONFIGURATION
     *
     * Proxies API requests to the backend server.
     * This solves CORS issues in development.
     *
     * Frontend: http://localhost:3000
     * Backend: http://localhost:4000
     *
     * When frontend requests /graphql, Vite proxies to backend.
     */
    proxy: {
      '/graphql': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        // Handle WebSocket upgrades for subscriptions
        ws: true,
      },
    },
  },

  /**
   * BUILD CONFIGURATION
   *
   * These settings affect the production build.
   */
  build: {
    // Output directory
    outDir: 'dist',

    // Generate source maps for debugging production issues
    sourcemap: true,
  },
});
