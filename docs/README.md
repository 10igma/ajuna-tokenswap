# Ajuna Token Swap — Documentation

Comprehensive documentation for the Ajuna Token Swap system: a UUPS-upgradeable smart contract system that wraps AJUN Foreign Assets into ERC20 tokens (wAJUN) on Polkadot AssetHub.

---

## Documents

| Document | Description |
|----------|-------------|
| [QUICKSTART.md](QUICKSTART.md) | Get up and running in under 10 minutes — install, compile, test, and run locally |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Contract hierarchy, proxy layout, storage model, data flow diagrams, and design decisions |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Step-by-step deployment for all environments: local dev node, Chopsticks, testnet, and production |
| [SECURITY.md](SECURITY.md) | Security model, access control, threat mitigations, audit scope, and production hardening checklist |
| [UPGRADE.md](UPGRADE.md) | UUPS upgrade procedures, storage layout rules, writing new implementations, and rollback considerations |
| [USAGE.md](USAGE.md) | JavaScript/ethers.js integration, browser dApp usage, E2E testing, and complete ABI reference |

---

## Quick Links

### I want to...

| Goal | Start here |
|------|-----------|
| Run the project for the first time | [QUICKSTART.md](QUICKSTART.md) |
| Understand how the contracts work | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Deploy to a live network | [DEPLOYMENT.md](DEPLOYMENT.md) |
| Review the security model | [SECURITY.md](SECURITY.md) |
| Upgrade a deployed contract | [UPGRADE.md](UPGRADE.md) |
| Integrate wrap/unwrap in my app | [USAGE.md](USAGE.md) |
| Set up MetaMask for AssetHub | [USAGE.md — Browser dApp](USAGE.md#browser-dapp-apphtml) |
| Run the E2E test suite | [USAGE.md — E2E Testing](USAGE.md#e2e-testing-script) |
| Prepare for production | [DEPLOYMENT.md — Post-Deployment Checklist](DEPLOYMENT.md#post-deployment-checklist) |
| Transfer admin roles to multisig | [SECURITY.md — Production Hardening](SECURITY.md#production-hardening-checklist) |

---

## Architecture at a Glance

```
┌─────────────────┐
│ IERC20Precompile│ ← Foreign Asset precompile (AJUN)
└────────┬────────┘
         │ transferFrom / transfer
┌────────┴────────┐      mint / burnFrom     ┌──────────────┐
│  AjunaWrapper   │─────────────────────────→ │  AjunaERC20  │
│  (Treasury)     │                           │  (wAJUN)     │
│  UUPS Proxy     │                           │  UUPS Proxy  │
└─────────────────┘                           └──────────────┘
```

**Invariant**: `wAJUN.totalSupply() == AJUN.balanceOf(wrapper)` — every wAJUN is backed 1:1.

---

## Key Facts

| Property | Value |
|----------|-------|
| Solidity version | 0.8.28 |
| OpenZeppelin version | 5.4.0 (+ upgradeable) |
| Target runtime | pallet-revive (RISC-V via resolc) |
| Token decimals | 12 (matches native AJUN) |
| Proxy pattern | UUPS (ERC1967Proxy) |
| Unit tests | 60 (including 10 UUPS-specific) |
| Local chain ID | 420420420 |
| Testnet chain ID | 420420417 |
