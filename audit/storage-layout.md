# Storage Layout — Verified Slot Map

Both contracts were compiled with `solc 0.8.30` (matching the project's `^0.8.28` pragma) with `outputSelection.storageLayout` enabled, then dumped via the standard JSON output. OpenZeppelin Contracts v5.6.1 use ERC-7201 namespaced storage for every base contract in the inheritance chain, so inherited state lives at hashed slots that do not interleave with derived-contract state.

The numbers below are **verified from the compiler output**, not inferred from comments.

## AjunaWrapper

Linearized derived storage (slots starting at 0 in the proxy):

| Slot | Offset | Bytes | Variable | Type | Notes |
|------|--------|-------|----------|------|-------|
| 0 | 0 | 20 | `token` | `AjunaERC20` (address) | Set in `initialize` |
| 1 | 0 | 20 | `foreignAsset` | `IERC20Precompile` (address) | Set in `initialize` |
| **1** | **20** | **1** | **`allowlistEnabled`** | **`bool`** | **PACKED into slot 1** |
| 2 | 0 | 32 | `allowlisted` | `mapping(address => bool)` | New slot |
| 3 .. 48 | 0 | 32 each | `__gap[46]` | `uint256[46]` | 46 reserved slots |

Inherited state (namespaced, non-overlapping):

| Namespace | Holds |
|-----------|-------|
| `openzeppelin.storage.Initializable` | `_initialized`, `_initializing` |
| `openzeppelin.storage.Ownable` | `_owner` |
| `openzeppelin.storage.Ownable2Step` | `_pendingOwner` |
| `openzeppelin.storage.Pausable` | `_paused` |
| `openzeppelin.storage.ReentrancyGuard` | `_status` (slot `0x9b779b17422d0df92223018b32b4d1fa46e071723d6817e2486d003becc55f00`) |
| `openzeppelin.storage.UUPSUpgradeable` | (no fields) |
| `eip1967.proxy.implementation` | implementation address (slot `0x360894…`) |

### Gap arithmetic — code comment vs. reality

`AjunaWrapper.sol:296` says:

```solidity
// Started at 48; consumed 2 slots for `allowlistEnabled` (bool) and
// `allowlisted` (mapping). Remaining: 46.
uint256[46] private __gap;
```

**The "consumed 2 slots" claim is wrong.** Slot 1 had 12 unused upper bytes after `foreignAsset` (an `address` is 20 bytes); the compiler packed the 1-byte `allowlistEnabled` into that gap. Only `allowlisted` consumed a fresh slot (slot 2). Net consumption is **1 slot**, so `__gap[47]` would be the correct continuation of the original 48-slot reservation. As-is the gap is one slot smaller than necessary.

This is **not** unsafe. It only means:
- 1 slot of upgrade headroom is forfeited (the wrapper now reserves 47 slots' worth of forward-compat instead of 48).
- For an in-place upgrade from a hypothetical V1 (token + foreignAsset + `__gap[48]`) to current V2, slot 1's upper bytes were always zero in V1, so `allowlistEnabled` would read `false` after upgrade — which is the opposite of the intended secure default. This concern is acknowledged in `docs/UPGRADE.md` ("Upgrade-time defaults for new derived state"). For a fresh V2 deploy, `initialize()` writes `allowlistEnabled = true` so the issue doesn't manifest. Filed as ATS-05.

### `docs/` slot maps are out of date

`docs/ARCHITECTURE.md` line 242 and `docs/UPGRADE.md` line 268 both show `__gap[48]` for `AjunaWrapper` — the actual contract is `__gap[46]`. Filed as ATS-06.

## AjunaERC20

Linearized derived storage (slots starting at 0 in the proxy):

| Slot | Offset | Bytes | Variable | Type | Notes |
|------|--------|-------|----------|------|-------|
| 0 | 0 | 1 | `_tokenDecimals` | `uint8` | Set in `initialize` |
| 1 .. 49 | 0 | 32 each | `__gap[49]` | `uint256[49]` | 49 reserved slots |

Inherited state (namespaced, non-overlapping):

| Namespace | Holds |
|-----------|-------|
| `openzeppelin.storage.Initializable` | `_initialized`, `_initializing` |
| `openzeppelin.storage.ERC20` | `_balances`, `_allowances`, `_totalSupply`, `_name`, `_symbol` |
| `openzeppelin.storage.AccessControl` | `_roles` |
| `openzeppelin.storage.AccessControlDefaultAdminRules` | `_currentDelay`, `_currentDefaultAdmin`, `_pendingDefaultAdmin`, `_pendingDelay`, etc. |
| `openzeppelin.storage.UUPSUpgradeable` | (no fields) |

Gap math is correct here: `_tokenDecimals` consumes one slot (the rest of which is wasted padding), `__gap[49]` follows. The inheritance chain `AccessControlDefaultAdminRulesUpgradeable → AccessControlUpgradeable` adds *two* namespaced storage roots; the docs only mention the parent. Cosmetic.

## V2 mocks — slot allocation for new state

`AjunaWrapperV2.version` (uint256) and `AjunaERC20V2.version` (uint256) inherit from V1 and add a single new state variable. Solidity places these *after* the parent's `__gap`, not inside it:

| Contract | New variable | Slot allocated |
|----------|--------------|----------------|
| `AjunaWrapperV2.version` | `uint256` | slot 49 (immediately after parent's `__gap[46]` ending at slot 48) |
| `AjunaERC20V2.version` | `uint256` | slot 50 (immediately after parent's `__gap[49]` ending at slot 49) |

The mock's NatSpec at `contracts/mocks/AjunaWrapperV2.sol:12` says "occupies one slot from `__gap`" — **this is incorrect**. The variable lives at slot 49, *after* `__gap[46]` ends. The actual gap remains intact. This still works for V2 → V3 upgrade chains as long as future parent additions correctly shrink `__gap`, but the mock comment teaches the wrong mental model. Filed as ATS-06 (sub-bullet).

## Runtime confirmation

`test/audit/storage_probe.test.ts` reads the proxy storage at the `ReentrancyGuard` namespace slot directly (`provider.getStorage(proxy, REENTRANCY_GUARD_SLOT)`) and verifies:

- The implementation has `_status = 1` (NOT_ENTERED), written by its constructor.
- The proxy has `_status = 0` (never written, because constructor only ran on the implementation).

This confirms the wrapper's reentrancy guard relies on `0 != 2 (ENTERED)` for first-call safety, not on a properly initialized `NOT_ENTERED = 1`. Filed as ATS-09.
