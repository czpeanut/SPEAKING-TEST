#!/usr/bin/env node
// Bundles the browser-side app (public/src/app.js) into public/app.bundle.js.
//
// simli-client@3.0.2's published dist/index.js does `require("./Client")` but the
// actual file on disk is dist/client.js (lowercase) — works on case-insensitive
// filesystems (macOS/Windows) but breaks on case-sensitive ones (Linux, i.e. every
// server). We import the lowercase path directly in public/src/app.js to route
// around the broken index.js; this bundling step is otherwise a normal esbuild build.
const esbuild = require("esbuild");
const path = require("path");

esbuild
  .build({
    entryPoints: [path.join(__dirname, "..", "public", "src", "app.js")],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2020",
    outfile: path.join(__dirname, "..", "public", "app.bundle.js"),
    logLevel: "info",
  })
  .catch(() => process.exit(1));
