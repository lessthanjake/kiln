# Contract metadata

`0x06ddc03bc74c63650002cbac386ed6aaaa355d34.json` is VesselPortal's entry for
[evmnow/contract-metadata](https://github.com/evmnow/contract-metadata), the
registry evm.now reads to show a contract as something other than bytecode.
Verification on Sourcify and Etherscan publishes the *source*; this publishes
the *explanation* — what each function is for, what the limits mean, and which
risks a collector should know about.

It is kept here so it stays in step with the contract. To submit or update it:

```bash
git clone https://github.com/evmnow/contract-metadata
cd contract-metadata
cp <this repo>/contracts/metadata/0x06ddc*.json contracts/1/
pnpm install && pnpm validate:contracts   # strict; must pass with zero errors
```

Then open a pull request. Bump `meta.version` on every change.

The file documents every function and every error in the ABI, checked
mechanically against `contracts/out/VesselPortal.sol/VesselPortal.json` — if
the contract's surface ever changes, that check is how you find out this file
did not.
