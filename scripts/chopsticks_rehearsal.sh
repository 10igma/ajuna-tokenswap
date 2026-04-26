#!/bin/bash
set -e

# ────────────────────────────────────────────────────────────────────────
# Chopsticks rehearsal orchestrator.
#
# Runs the full Ajuna Tokenswap production-flow rehearsal against a
# Chopsticks-forked Polkadot Asset Hub. The rehearsal exercises every
# step of docs/PRODUCTION-CHECKLIST.md end to end and asserts the
# audit-baseline properties (bindMinter, decimals coherence, allowlist
# gates deposit only, two-step + delayed admin handoff, etc.).
#
# Prerequisites (run in separate terminals BEFORE invoking this script):
#   1. Chopsticks fork:
#        npx @acala-network/chopsticks --config=chopsticks.yml
#   2. eth-rpc adapter:
#        ./polkadot-sdk/target/release/eth-rpc --node-rpc-url ws://127.0.0.1:8000
#
# Usage:
#   ./scripts/chopsticks_rehearsal.sh
#
# Env overrides (rare):
#   FOREIGN_ASSET=0x...   override the precompile address (default: live AJUN)
#   ADMIN_DELAY_SECS=N    override the rehearsal admin delay (default: 60)
# ────────────────────────────────────────────────────────────────────────

# Default values match the live Polkadot Asset Hub AJUN precompile and a
# short admin delay so the rehearsal completes in a couple of minutes.
export FOREIGN_ASSET="${FOREIGN_ASSET:-0x0000002d00000000000000000000000002200000}"
export ADMIN_DELAY_SECS="${ADMIN_DELAY_SECS:-60}"

echo "=== Chopsticks rehearsal — Ajuna Tokenswap ==="
echo "  FOREIGN_ASSET:    ${FOREIGN_ASSET}"
echo "  ADMIN_DELAY_SECS: ${ADMIN_DELAY_SECS}"
echo ""

# ── Connectivity pre-flight ────────────────────────────────────────────
# Substrate WS port 8000 (Chopsticks default per chopsticks.yml).
if ! (echo > /dev/tcp/127.0.0.1/8000) 2>/dev/null; then
    echo "Error: Chopsticks not reachable on 127.0.0.1:8000."
    echo "  Start it with: npx @acala-network/chopsticks --config=chopsticks.yml"
    exit 1
fi
echo "  ✓ Chopsticks substrate WS reachable on 127.0.0.1:8000"

# Eth-RPC adapter port 8545.
if ! (echo > /dev/tcp/127.0.0.1/8545) 2>/dev/null; then
    echo "Error: eth-rpc adapter not reachable on 127.0.0.1:8545."
    echo "  Start it with: ./polkadot-sdk/target/release/eth-rpc --node-rpc-url ws://127.0.0.1:8000"
    exit 1
fi
echo "  ✓ eth-rpc adapter reachable on 127.0.0.1:8545"

echo ""
echo "Running rehearsal (this takes ~$((ADMIN_DELAY_SECS + 30))s)..."
echo ""

# ── Run the TS rehearsal via hardhat ───────────────────────────────────
# `--network chopsticks` matches the eth-rpc adapter on 127.0.0.1:8545
# with the forked Polkadot Asset Hub mainnet chain id 420420419 (NOT
# 420420420, which is the local revive-dev-node's id).
npx hardhat run scripts/chopsticks_rehearsal.ts --network chopsticks
