import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'

// Strict CSP, production only (dev needs Vite/react-refresh inline scripts).
// The app talks to exactly one API origin; everything else is self-hosted.
// Kept as a <meta> tag so it works identically on any static host.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'", // the boot background + charts inline styles
  "img-src 'self' data:",
  "connect-src 'self' https://api.hyperliquid.xyz wss://api.hyperliquid.xyz",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ')

// Build stamp for the in-app update check: the bundle knows its own sha
// (__BUILD_SHA__) and every deploy ships /version.json with the new one —
// open tabs poll it and offer a reload. Deploy flow stays `npm run build &&
// npx wrangler deploy`; both artifacts come from the same build.
const BUILD_SHA = (() => {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim()
  } catch {
    return 'unknown' // git-less build: the client skips update checks
  }
})()

function versionPlugin(): Plugin {
  return {
    name: 'emit-version',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify({ sha: BUILD_SHA, builtAt: new Date().toISOString() }),
      })
    },
  }
}

function cspPlugin(): Plugin {
  return {
    name: 'inject-csp',
    apply: 'build',
    transformIndexHtml: (html) =>
      html.replace(
        '<meta charset="UTF-8" />',
        `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
      ),
  }
}

// The browser floor, PINNED. These are exactly the versions Vite 8.1 resolves
// 'baseline-widely-available' to, so the emitted bundle is the same — the only
// difference is that the floor changes in a reviewed diff. Left unset, it is a
// rolling default that Vite regenerates every major release, so an
// `npm update` could raise the minimum iOS silently. src/lib/hl/info.ts pays
// for older Safari on purpose (its hand-composed AbortController exists
// because AbortSignal.any is Safari 17.4+, above this floor), so raise the
// floor deliberately and revisit that workaround in the same change.
const BROWSER_TARGET = ['chrome111', 'edge111', 'firefox114', 'safari16.4', 'ios16.4']

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), cspPlugin(), versionPlugin()],
  define: { __BUILD_SHA__: JSON.stringify(BUILD_SHA) },
  // One app chunk by design (the QR encoder is the only lazy split), so the
  // default 500 kB warning would fire on every build.
  build: { target: BROWSER_TARGET, chunkSizeWarningLimit: 800 },
  // PORT lets several dev servers run side by side; default stays 5173
  server: { port: Number(process.env.PORT) || 5173 },
})
