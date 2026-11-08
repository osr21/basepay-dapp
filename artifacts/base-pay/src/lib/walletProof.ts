// ── Client-side companion to artifacts/api-server/src/lib/walletProof.ts ──────
// Builds the same canonical "ownership proof" message the server verifies.
// Field object key order MUST match the server's `fields` argument for the
// same action, since the message is a plain string built from insertion order.

export function buildOwnershipMessage(
  action: string,
  fields: Record<string, string>,
  timestampSeconds: number,
): string {
  const lines = [`BasePay Ownership Proof`, `Action: ${action}`];
  for (const [key, value] of Object.entries(fields)) {
    lines.push(`${key}: ${value}`);
  }
  lines.push(`Timestamp: ${timestampSeconds}`);
  return lines.join("\n");
}
