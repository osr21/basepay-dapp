// wagmi v3 removed the /experimental subpath; these hooks were promoted to main wagmi
// or dropped. Provide stubs so OnchainKit 1.x can import without crashing at build time.
// The swap/transaction/connected components that use them are not rendered in BasePay.

export function useSendCalls() {
  return { sendCalls: undefined, sendCallsAsync: undefined, isPending: false, isSuccess: false };
}

export function useCallsStatus() {
  return { data: undefined, isLoading: false, isFetching: false };
}

export function useWriteContracts() {
  return { writeContracts: undefined, writeContractsAsync: undefined, isPending: false };
}

export function useCapabilities() {
  return { data: undefined, isLoading: false };
}
