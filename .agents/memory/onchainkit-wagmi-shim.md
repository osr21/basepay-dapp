---
name: OnchainKit wagmi/experimental shim
description: OnchainKit 1.x requires wagmi/experimental which was removed in wagmi v3. Fix with a Vite alias.
---

## The problem

`@coinbase/onchainkit@1.x` (specifically swap, transaction, connected components) internally imports `wagmi/experimental`:
- `useSendCalls`
- `useCallsStatus`
- `useWriteContracts`

These were promoted out of `/experimental` in wagmi v3 (or dropped). Vite's dep pre-bundler fails with `Missing "./experimental" specifier in "wagmi" package`.

## The fix

1. Create `src/lib/wagmi-experimental-shim.ts` that exports stub versions of all hooks OnchainKit needs:

```ts
export function useSendCalls() { return { sendCalls: undefined, isPending: false }; }
export function useCallsStatus() { return { data: undefined, isLoading: false }; }
export function useWriteContracts() { return { writeContracts: undefined, isPending: false }; }
export function useCapabilities() { return { data: undefined, isLoading: false }; }
```

2. Add to `vite.config.ts` resolve.alias:
```ts
"wagmi/experimental": path.resolve(import.meta.dirname, "src/lib/wagmi-experimental-shim.ts"),
```

**Why:** The stubs are safe because BasePay doesn't render any OnchainKit swap/transaction/connected components. TypeScript typecheck passes because wagmi/experimental is not in the TS module graph.

**How to apply:** Any time `@coinbase/onchainkit` is added to a wagmi v3 project. Also check for this if the Vite dev server fails during dep optimization with OnchainKit installed.
