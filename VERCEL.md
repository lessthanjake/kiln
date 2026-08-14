# Hosting Kiln

Kiln is a static bundle: `npm run build` emits `dist/`, and nothing runs
server-side. Any static host works; Vercel is configured here.

    vercel link      # once, to associate the directory with a project
    vercel deploy    # preview
    vercel deploy --prod

`vercel.json` sets `buildCommand` to `npm run check-artifact && npm run build`,
so a deploy fails loudly if `src/vesselPortalArtifact.js` is stale rather than
shipping a UI that deploys the wrong bytecode.

## Why the contract artifact is committed

The app needs VesselPortal's creation bytecode to offer the one-time deploy.
That comes from `contracts/out/`, which is a build output and stays gitignored —
and Vercel has no Solidity toolchain. So `npm run sync-artifact` extracts the
ABI and bytecode into `src/vesselPortalArtifact.js`, which **is** committed.
Run it after any contract change; CI and the deploy both verify it is current.

## Why the CSP is permissive about scripts

Kiln renders on-chain artwork in sandboxed `data:` iframes, and **`data:` frames
inherit the embedding page's CSP** — verified, not assumed: with
`script-src 'self'`, Chrome reports *"Executing inline script violates the
following Content Security Policy directive"* and the artwork does not run.

So `script-src` must allow `'unsafe-inline'`, `'unsafe-eval'` and `data:`, or
every preview breaks. The directives that still earn their place are kept:
`base-uri`, `form-action`, `object-src`, `frame-ancestors`, plus `nosniff` and
`X-Frame-Options`. A CSP that looked strict while silently breaking the app's
core function would be worse than an honest one.

`connect-src` is `*` because the wallet's RPC endpoint is the user's choice, and
some artworks read the chain themselves at view time.

## What a public deployment does and does not do

- Everything happens in the visitor's browser. There is no backend, no
  analytics, no key material, and nothing is uploaded anywhere.
- Every transaction is signed in the visitor's own wallet, after their own
  review. Kiln estimates gas and shows costs, but the wallet is the authority.
- Kiln only offers to reference Vessel tokens the connected wallet holds. The
  contracts do not enforce that; it is a courtesy the interface keeps.
- A hosted copy is a convenience, not a trust anchor. Anyone minting something
  they care about should read `contracts/AUDIT.md`, check that the canonical
  `vesselPortal` address in `src/kiln.js` matches what they expect on-chain,
  and ideally run it locally with `npm run serve`.
