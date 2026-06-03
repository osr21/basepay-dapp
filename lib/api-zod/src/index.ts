export * from "./generated/api";

// Re-export TypeScript types from the generated types directory.
// DeleteContactParams is omitted here because it conflicts with the Zod schema
// of the same name exported from ./generated/api. Use z.infer<typeof DeleteContactParams>
// from the Zod schema when a TypeScript type is needed.
export type {
  AppConfig,
  AppRegisterInput,
  Contact,
  ContactInput,
  DeleteResult,
  ErrorResponse,
  HealthStatus,
  ListContactsParams,
  ListPaymentRequestsParams,
  PaymentRequest,
  PaymentRequestInput,
  PaymentRequestInputToken,
  PaymentRequestStatus,
  PaymentRequestUpdate,
  PaymentRequestUpdateStatus,
  PaymentStats,
} from "./generated/types";
