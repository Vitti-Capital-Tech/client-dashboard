/**
 * Broker account numbers, as typed by a person.
 *
 * Pure and dependency-free so both the client form (to validate before it
 * submits) and the server action (which does not trust the form) can use it.
 */

/**
 * The one spelling of a broker account number.
 *
 * Mirrors `normalise_account_number` in the database on purpose: the partial
 * unique index that stops duplicate pending claims, and the lookup that
 * resolves a claim on approval, are both written in terms of that function. If
 * this normalised differently, a client could hold two pending claims for the
 * same account, or a claim could be stored in a form the approval never finds.
 *
 * Everything that is not a letter or a digit is dropped — not just whitespace —
 * because people type '1-102-004' and 'A/c 1102004'. The result is upper-cased
 * because not every ref is numeric: 'PLACEVITT' is a real account in this data.
 */
export function normaliseAccountNumber(raw: string): string {
  return raw.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

/** Longest ref seen in the broker export is 9 characters; 32 is slack, not a rule. */
const MAX_LENGTH = 32;

/**
 * Why this number cannot be claimed, or null if it can.
 *
 * Deliberately says nothing about whether the account EXISTS — that question is
 * answered once, by staff, on approval. A form that reported "no such account"
 * would be an oracle for the firm's account numbers.
 */
export function accountNumberProblem(raw: string): string | null {
  const normalised = normaliseAccountNumber(raw);
  if (!normalised) return "Enter the account number from your broker statement.";
  if (normalised.length > MAX_LENGTH) return "That is longer than any account number.";
  return null;
}
