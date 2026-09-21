#!/usr/bin/env node
// Bundles the browser-side app (public/src/app.js) into public/app.bundle.js.
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
