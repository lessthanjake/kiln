#!/usr/bin/env node
// Bundles the app and stamps it with a build identity, so a hosted copy can
// say exactly which commit it came from. With auto-deploy on push, "is this
// the latest?" is otherwise unanswerable from the page itself.

import { build } from 'esbuild'
import { execSync } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const git = (cmd, fallback) => {
  try {
    return execSync(cmd, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return fallback
  }
}

// Vercel builds from a detached checkout, so prefer its env vars and fall back
// to git for local builds.
const sha = (process.env.VERCEL_GIT_COMMIT_SHA || git('git rev-parse HEAD', '')).slice(0, 7) || 'local'
const ref = process.env.VERCEL_GIT_COMMIT_REF || git('git rev-parse --abbrev-ref HEAD', '') || '—'
const dirty = !process.env.VERCEL && git('git status --porcelain', '') !== ''
const env = process.env.VERCEL_ENV || 'local'

const info = {
  commit: dirty ? `${sha}+` : sha, // '+' marks uncommitted local changes
  ref,
  env,
  builtAt: new Date().toISOString().replace('T', ' ').slice(0, 16) + 'Z',
  repo: 'https://github.com/lessthanjake/kiln',
}

mkdirSync(join(ROOT, 'dist'), { recursive: true })
await build({
  entryPoints: [join(ROOT, 'src/app.js')],
  bundle: true,
  format: 'esm',
  outfile: join(ROOT, 'dist/app.js'),
  define: { __KILN_BUILD__: JSON.stringify(info) },
})
copyFileSync(join(ROOT, 'index.html'), join(ROOT, 'dist/index.html'))

console.log(`built ${info.commit} (${info.ref}, ${info.env}) at ${info.builtAt}`)
