/**
 * The password rule, in one place.
 *
 * Pure and dependency-free so the sign-up form (to say what is wrong before it
 * submits) and the server actions (which do not trust the form) can share it,
 * the same arrangement `lib/accounts/account-number.ts` uses.
 *
 * ── Kept in step with GoTrue ────────────────────────────────────────────────
 * `minimum_password_length` and `password_requirements` in supabase/config.toml
 * say the same thing. They have to: GoTrue is what actually refuses a weak
 * password, and it refuses it at `updateUser` — which in the sign-up flow runs
 * AFTER the emailed code has been verified and consumed. A form that accepted a
 * password GoTrue would reject would therefore fail at the one point where the
 * account is half-made and the code cannot be re-used. Checking here first means
 * the failure lands on step 1, where it is just a message under a field.
 */

/** Matches `minimum_password_length` in supabase/config.toml. */
export const MIN_PASSWORD_LENGTH = 10;

/**
 * Why this password cannot be used, or null if it can.
 *
 * The requirements are deliberately modest — length, and not being all one
 * character class — because the alternative (symbols, mixed case, rotation)
 * pushes people towards `Vitti@2026!` and a sticky note. Length is the part
 * that actually costs an attacker anything.
 */
export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  // No upper bound of our own: bcrypt truncates past 72 bytes, so a longer one
  // is not weaker, it is merely not stronger. Refusing it would only surprise
  // someone pasting from a password manager.
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    // Mirrors `password_requirements = "letters_digits"`.
    return "Include at least one letter and one number.";
  }
  return null;
}

/**
 * Why the two boxes do not agree, or null if they do.
 *
 * Separate from `passwordProblem` so the form can show "does not match" against
 * the confirm field and the strength complaint against the first one, rather
 * than one message under whichever field was unlucky.
 */
export function confirmationProblem(
  password: string,
  confirmation: string,
): string | null {
  if (!confirmation) return "Re-enter the password.";
  if (password !== confirmation) return "The two passwords do not match.";
  return null;
}
