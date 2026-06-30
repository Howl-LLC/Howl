// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import path from 'path';
import { readFileSync } from 'fs';
import { defineConfig, type Plugin } from 'vite';

const pkgVersion = JSON.parse(readFileSync('./package.json', 'utf-8')).version;
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { sri } from 'vite-plugin-sri3';
import { applySelfHostCsp } from './scripts/selfHostCsp';

const isElectronBuild = process.env.ELECTRON_BUILD === 'true';

/** Inject LiveKit WSS domain into the CSP meta tag from VITE_LIVEKIT_URL at build time. */
function cspLiveKitPlugin(): Plugin {
  return {
    name: 'howl-csp-livekit',
    transformIndexHtml(html) {
      const lkUrl = process.env.VITE_LIVEKIT_URL;
      if (!lkUrl) return html; // dev/no LiveKit — keep CSP as-is
      try {
        const parsed = new URL(lkUrl.replace(/^ws/, 'http'));
        // Local dev LiveKit is plain ws:// with a port (e.g. ws://localhost:7880);
        // preserve scheme+port for it. Production stays wss://hostname.
        const insecureLocal = parsed.protocol === 'http:';
        const wsDomain = insecureLocal ? `ws://${parsed.host}` : `wss://${parsed.hostname}`;
        const httpDomain = insecureLocal ? `http://${parsed.host}` : `https://${parsed.hostname}`;
        return html.replace(
          /(connect-src\s[^;]*)(;)/,
          `$1 ${wsDomain} ${httpDomain}$2`
        );
      } catch { return html; }
    },
  };
}

/**
 * For self-host builds (VITE_SELF_HOST=true), replace the howlpro-era meta CSP
 * with a domain-agnostic policy so one prebuilt SPA image works on any operator
 * domain + any bring-your-own LiveKit. No-op for hosted builds.
 */
function cspSelfHostPlugin(): Plugin {
  return {
    name: 'howl-csp-selfhost',
    transformIndexHtml(html) {
      if (process.env.VITE_SELF_HOST !== 'true') return html;
      return applySelfHostCsp(html);
    },
  };
}


export default defineConfig(({ mode }) => {
    const isProduction = mode === 'production';

    return {
      base: '/',
      server: {
        port: 3000,
        strictPort: true,
        host: process.env.VITE_HOST || 'localhost',
        allowedHosts: [
          'localhost',
          '127.0.0.1',
        ],
        proxy: {
          '/api': {
            target: 'http://localhost:5000',
            changeOrigin: true,
          },
          '/socket.io': {
            target: 'http://localhost:5000',
            changeOrigin: true,
            ws: true,
          },
        },
      },
      define: {
        '__APP_VERSION__': JSON.stringify(pkgVersion),
        '__BUILD_DATE__': JSON.stringify(new Date().toISOString().slice(0, 10)),
      },
      esbuild: {
        drop: isProduction ? ['debugger'] : [],
        pure: isProduction ? ['console.log', 'console.debug', 'console.info', 'console.warn'] : [],
      },
      worker: {
        format: 'es',
      },
      build: {
        outDir: 'dist',
        emptyOutDir: true,
        sourcemap: !isProduction,
        chunkSizeWarningLimit: 1000,
        rollupOptions: {
          ...(isElectronBuild ? { external: ['virtual:pwa-register'] } : {}),
          input: {
            main: path.resolve(__dirname, 'index.html'),
            overlay: path.resolve(__dirname, 'overlay.html'),
          },
          output: {
            // Function form — matches module paths so subpath-only packages
            // (e.g. @lexical/react, which has no root export) chunk correctly.
            manualChunks(id: string) {
              if (!id.includes('node_modules')) return undefined;
              if (id.includes('/node_modules/react/') || id.includes('/node_modules/react-dom/')) return 'vendor';
              if (id.includes('/node_modules/socket.io-client/')) return 'socketio';
              if (id.includes('/node_modules/lucide-react/')) return 'icons';
              if (id.includes('/node_modules/livekit-client/')) return 'livekit';
              if (id.includes('/node_modules/motion/')) return 'motion';
              if (id.includes('/node_modules/@sentry/')) return 'sentry';
              if (id.includes('/node_modules/i18next/') || id.includes('/node_modules/react-i18next/')) return 'i18n';
              if (id.includes('/node_modules/tweetnacl')) return 'crypto'; // tweetnacl + tweetnacl-util
              if (id.includes('/node_modules/@lexical/') || id.includes('/node_modules/lexical/')) return 'lexical';
              if (id.includes('/node_modules/react-virtuoso/')) return 'virtuoso';
              return undefined;
            },
            chunkFileNames: 'assets/js/[name]-[hash].js',
            entryFileNames: 'assets/js/[name]-[hash].js',
            assetFileNames: 'assets/[ext]/[name]-[hash].[ext]',
          },
        },
      },
      plugins: [
        tailwindcss(),
        react(),
        // SRI: applies integrity hashes to first-party scripts only (build output).
      // Cloudflare-injected beacon scripts are added at the edge after build
      // and may fail CORS/SRI checks — this is harmless (analytics only, not app code).
      ...(isProduction ? [cspSelfHostPlugin(), cspLiveKitPlugin(), sri()] : [cspSelfHostPlugin(), cspLiveKitPlugin()]),
        ...(!isElectronBuild ? [VitePWA({
          registerType: 'prompt',
          includeAssets: ['howl-logo.png'],
          manifest: false, // use public/manifest.json
          workbox: {
            importScripts: ['sw-push.js'],
            globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
            runtimeCaching: [
              {
                // Only cache non-encrypted uploads (images/avatars/etc).
                // Encrypted files end in .enc and should not be persisted in
                // the SW cache — the ciphertext is useless without the key,
                // but keeping it around weakens the E2E guarantee.
                urlPattern: /\/api\/uploads\/(?!.*\.enc).+/i,
                handler: 'NetworkFirst',
                options: { cacheName: 'user-uploads', expiration: { maxEntries: 200, maxAgeSeconds: 3600 }, networkTimeoutSeconds: 3 },
              },
            ],
            navigateFallback: 'index.html',
            navigateFallbackDenylist: [/^\/api\//, /^\/socket\.io\//, /^\/health$/],
          },
        })] : []),
      ],
      resolve: {
        dedupe: ['react', 'react-dom'],
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
