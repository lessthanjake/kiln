# Security

Kiln asks you to sign transactions that spend real money and deploy real
contracts. That makes it worth being precise about where the risk actually is.

## The short version

**Run it locally if you can.** `npm install && npm run build && npm run serve`
gives you the same app from source you can read. A hosted copy is a
convenience; the source is the thing.

The contracts cannot take your assets. A hosted *frontend* is the part with a
plausible attack, because a compromised build can ask you to sign something
other than what you meant — and you arrived already expecting to sign things.

## What can and cannot go wrong

**The contracts are not the risk.** VesselPortal is immutable, ownerless and
stateless: no admin, no upgrade path, no funds, every function `view`. The
networked.art contracts it plugs into are deployed and verified. Nothing in
this repo can move a token or a balance you already hold.

**A hosted frontend is the risk.** Anyone who can change what a domain serves
— through the hosting account, the repo, or a compromised npm dependency —
can change which transaction your wallet is asked to approve. Your wallet will
show you the truth, but only if you read it. This is the standard failure mode
for drained wallets in this space, and a minting site is a good target
precisely because its visitors expect signature prompts.

## What Kiln will ever ask you to sign

Exactly six things, all of them yours:

| transaction | to | sends value? |
|---|---|---|
| `cloneCollection` | networked.art factory | no |
| `cloneCollectionAndMint` | networked.art factory | yes — the protocol's $10 lot fee |
| deploy `VesselPortal` | contract creation | no |
| `registerRenderer` | your own collection | no |
| `prepareArtifact` | your own collection | no |
| `mint` / `mintToLot` | your own collection | `mintToLot` only — the $10 lot fee |

**Kiln never asks you to approve a token, call `setApprovalForAll`, transfer
anything, or sign an off-chain message.** There is no code in it that can.

So: **if a copy of Kiln ever prompts you for a token approval, a message
signature, or a transfer — or asks to send ETH anywhere other than the factory
or your own collection — it is not this app. Reject it.** That is a concrete
tripwire, and it does not require you to trust anyone's word.

## Verifying the deployment you're using

The address matters more than the domain:

- Check the VesselPortal address Kiln shows against the one you expect.
- Check its `vessel()` and `relics()` return the real Vessel contracts, and
  that its source is verified. `script/publish-renderer.sh <address>` does all
  three in one command.
- `contracts/AUDIT.md` documents what the renderer guarantees, what it cannot,
  and the 13 findings two adversarial reviews turned up before deployment.

## Reporting

Open an issue, or reach the maintainer through the repo. There is no bounty;
this is a small tool given away.

## No warranty

MIT-licensed, provided as-is. You are signing your own transactions with your
own keys, and you are responsible for reading them.
