# Hosting Kiln

Kiln is a static bundle: `npm run build` emits `dist/`, and nothing runs
server-side. Any static host works; Vercel is configured here.

    npm run deploy   # vercel deploy --prod --yes

Live at https://kiln-murex.vercel.app. The GitHub repo is connected, so
pushes to `main` redeploy automatically; the command above is for deploying
without a push.

`.vercelignore` matters here: without it the CLI uploads ~670 MB (node_modules,
the Foundry build output, and local QA logs) and dies on the 100 MB file limit.
With it the upload is ~0.3 MB.

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
  review. Kiln estimates gas and shows costs, but the wallet is the authority
  and shows the real numbers before anything is committed.
- Kiln only offers to reference Vessel tokens the connected wallet holds. The
  contracts do not enforce that; it is a courtesy the interface keeps.
- **Hosting it is the part that carries risk.** The contracts are immutable and
  ownerless and cannot take anyone's assets, but whoever controls the domain
  controls which transaction a visitor is asked to approve. Treat the hosting
  account and this repo as security-critical, keep the dependency set small,
  and expect users to prefer running it themselves.
- Tell people what Kiln will never ask for — a token approval, a message
  signature, a transfer — so a tampered copy is recognisable. That list, and
  how to verify the VesselPortal deployment on-chain, is in
  [SECURITY.md](SECURITY.md).
