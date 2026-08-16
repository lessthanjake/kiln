#!/usr/bin/env bash
# Run once, right after VesselPortal is first deployed to mainnet.
#
#   ./script/publish-renderer.sh 0xYourDeployedAddress
#
# It proves the deployment is what it claims to be, publishes the source so
# anyone can read what they're registering, and records the address as
# canonical so Kiln never deploys a second copy.
#
# Needs: cast + forge on PATH. ETHERSCAN_API_KEY for the Etherscan half
# (Sourcify needs no key and runs regardless).

set -euo pipefail

# Keys live in ~/.zshenv, which a non-interactive shell does not read.
# shellcheck disable=SC1090
[[ -f "$HOME/.zshenv" ]] && source "$HOME/.zshenv" 2>/dev/null || true

# macOS ships bash 3.2, which has no ${var,,}.
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

ADDR="${1:-}"
if [[ -z "$ADDR" ]]; then
  echo "usage: $0 <deployed-address>" >&2
  exit 1
fi

RPC="${MAINNET_RPC_URL:-https://ethereum-rpc.publicnode.com}"
VESSEL=0xECb92Cc7112b80A2234936315BbB493fb48d1463
RELICS=0x48cB121Fa84b7C08692e74872D044B15369977CD
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

fail() { echo "  ✗ $1" >&2; exit 1; }
ok()   { echo "  ✓ $1"; }

echo "Checking $ADDR on mainnet…"

[[ "$(cast code "$ADDR" --rpc-url "$RPC" | head -c 4)" != "0x" ]] || fail "no code at that address"
ok "code present"

NAME=$(cast call "$ADDR" "name()(string)" --rpc-url "$RPC" | tr -d '"')
[[ "$NAME" == "VesselPortal" ]] || fail "name() is \"$NAME\", expected \"VesselPortal\""
ok "name() == VesselPortal"

VER=$(cast call "$ADDR" "version()(uint256)" --rpc-url "$RPC")
ok "version() == $VER"

# The constructor wiring is immutable, so a wrong address here can never be
# corrected — check it before telling anyone this deployment is canonical.
GOT_VESSEL=$(cast call "$ADDR" "vessel()(address)" --rpc-url "$RPC")
GOT_RELICS=$(cast call "$ADDR" "relics()(address)" --rpc-url "$RPC")
[[ "$(lower "$GOT_VESSEL")" == "$(lower "$VESSEL")" ]] || fail "vessel() is $GOT_VESSEL, expected $VESSEL"
[[ "$(lower "$GOT_RELICS")" == "$(lower "$RELICS")" ]] || fail "relics() is $GOT_RELICS, expected $RELICS"
ok "wired to THE_VESSEL and Relics"

# Render a known-good read end to end: proves the deployment can actually
# read live vault data, not merely that it exists.
if cast call "$ADDR" "selfTest(uint256)(bool)" 2623 --rpc-url "$RPC" | grep -q true; then
  ok "selfTest reads live vessel data"
else
  echo "  ! selfTest returned false — check the Vessel is reachable via $RPC" >&2
fi

echo
echo "Publishing source…"
ARGS=$(cast abi-encode "constructor(address,address)" "$VESSEL" "$RELICS")

cd "$ROOT/contracts"
# `env -u` matters: forge silently prefers Etherscan whenever ETHERSCAN_API_KEY
# is set — it overrides --verifier and says so — so with a key exported this
# step would hit Etherscan twice and report a Sourcify verification that never
# happened.
if env -u ETHERSCAN_API_KEY forge verify-contract "$ADDR" src/VesselPortal.sol:VesselPortal \
     --chain mainnet --constructor-args "$ARGS" --verifier sourcify 2>&1 | tail -3; then
  ok "sourcify"
else
  echo "  ! sourcify verification failed (retryable, harmless)" >&2
fi

if [[ -n "${ETHERSCAN_API_KEY:-}" ]]; then
  if forge verify-contract "$ADDR" src/VesselPortal.sol:VesselPortal \
       --chain mainnet --constructor-args "$ARGS" \
       --etherscan-api-key "$ETHERSCAN_API_KEY" --watch 2>&1 | tail -3; then
    ok "etherscan"
  else
    echo "  ! etherscan verification failed — rerun this script to retry" >&2
  fi
else
  echo "  – ETHERSCAN_API_KEY not set; skipping Etherscan."
  echo "    Add it to ~/.zshenv, then rerun this script to verify there too."
fi

# Record it so Kiln stops offering to deploy, here and for anyone else who
# runs this checkout.
cd "$ROOT"
/opt/homebrew/bin/python3.11 - "$ADDR" <<'PY'
import re, sys
addr = sys.argv[1]
p = 'src/kiln.js'
s = open(p).read()
new, n = re.subn(r"(  vesselPortal: )(null|'0x[0-9a-fA-F]{40}')(,)", rf"\1'{addr}'\3", s)
if n != 1:
    print(f"  ! could not update src/kiln.js automatically — set vesselPortal to {addr} by hand")
    sys.exit(0)
open(p, 'w').write(new)
print(f"  ✓ recorded as canonical in src/kiln.js")
PY

echo
echo "Done. Next:"
echo "  npm run build         # bake the address into dist/"
echo "  https://evm.now/address/$ADDR#code"
