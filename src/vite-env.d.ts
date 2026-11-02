/// <reference types="vite/client" />

/** Short git sha baked in at build time (vite.config.ts define); 'unknown' in git-less builds. */
declare const __BUILD_SHA__: string;
