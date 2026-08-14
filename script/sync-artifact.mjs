#!/usr/bin/env node
// Extracts VesselPortal's ABI and creation bytecode from the Foundry build
// into a committed JS module.
//
// Why this exists: the app needs the bytecode to offer a one-time deploy, but
// `contracts/out/` is a build artifact and stays gitignored. Without this, a
// clean clone — or a Vercel build, which has no Solidity toolchain — could not
// bundle the app at all.
//
// Run after any contract change:  npm run sync-artifact
// CI/deploy verifies it is current: npm run check-artifact

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const IN = join(ROOT, 'contracts/out/VesselPortal.sol/VesselPortal.json')
const OUT = join(ROOT, 'src/vesselPortalArtifact.js')

const checking = process.argv.includes('--check')

let built
try {
  built = JSON.parse(readFileSync(IN, 'utf8'))
} catch {
  // No Foundry build output. When checking, that is the normal state on a
  // deploy host with no Solidity toolchain — the committed artifact is all
  // there is, and it is what will ship. Staleness is caught where a build
  // output exists (a developer's machine, CI), not here.
  if (checking) {
    readFileSync(OUT, 'utf8') // but the committed artifact must exist
    console.log('no local contract build to compare against; using the committed artifact')
    process.exit(0)
  }
  console.error(`Could not read ${IN}\nRun: cd contracts && forge build`)
  process.exit(1)
}

const abi = built.abi
const bytecode = built.bytecode?.object
if (!abi?.length || !bytecode?.startsWith('0x')) {
  console.error('Build artifact is missing an abi or bytecode.object')
  process.exit(1)
}

const source = `// GENERATED — do not edit. Run \`npm run sync-artifact\` after changing
// contracts/src/VesselPortal.sol.
//
// Committed on purpose: the deploy step needs creation bytecode, and a clean
// clone (or a Vercel build) has no Solidity toolchain to produce it.
export const vesselPortalAbi = ${JSON.stringify(abi)}

export const vesselPortalBytecode = ${JSON.stringify(bytecode)}

export default { abi: vesselPortalAbi, bytecode: { object: vesselPortalBytecode } }
`

if (checking) {
  let current = ''
  try { current = readFileSync(OUT, 'utf8') } catch { /* missing */ }
  if (current !== source) {
    console.error('src/vesselPortalArtifact.js is stale.\nRun: npm run sync-artifact')
    process.exit(1)
  }
  console.log('artifact is current')
} else {
  writeFileSync(OUT, source)
  const kb = (bytecode.length / 2 / 1024).toFixed(1)
  console.log(`wrote src/vesselPortalArtifact.js (${abi.length} abi entries, ${kb} KB bytecode)`)
}
