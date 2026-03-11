#!/usr/bin/env node
// Automatically symlinks this extension into the correct OMP auto-discovery
// directory after `npm install` (local) or `npm install -g` (global).
//
// Skip with: npm install --ignore-scripts

import { mkdirSync, readlinkSync, symlinkSync, unlinkSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkgName = "omp-context-mode-extension";
const isGlobal = process.env.npm_config_global === "true";

let extensionsDir;
if (isGlobal) {
  // User-level: ~/.omp/agent/extensions
  extensionsDir = join(homedir(), ".omp", "agent", "extensions");
} else {
  // Project-level: <project-root>/.omp/extensions
  const projectRoot = process.env.npm_config_local_prefix ?? process.cwd();
  // Avoid a self-referential symlink when running `npm install` inside the
  // package directory itself (e.g. during development / after `git clone`).
  if (resolve(projectRoot) === pkgDir) process.exit(0);
  extensionsDir = join(projectRoot, ".omp", "extensions");
}

const linkPath = join(extensionsDir, pkgName);

// Nothing to do if the symlink already points at the right place.
try {
  if (readlinkSync(linkPath) === pkgDir) {
    console.log(`[omp-context-mode-extension] already registered → ${linkPath}`);
    process.exit(0);
  }
} catch { /* does not exist or is not a symlink — proceed */ }

mkdirSync(extensionsDir, { recursive: true });
try { unlinkSync(linkPath); } catch { /* nothing to remove */ }

symlinkSync(pkgDir, linkPath);
console.log(`[omp-context-mode-extension] registered OMP extension → ${linkPath}`);
