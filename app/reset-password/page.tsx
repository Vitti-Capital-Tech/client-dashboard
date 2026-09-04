import { ResetPasswordClient } from "./ResetPasswordClient";

/**
 * Forgotten password.
 *
 * A Server Component only so it can read `?email=` off the URL — the login form
 * carries the address across so the person does not type it twice. `searchParams`
 * is a Promise in this version of Next.js (see
 * node_modules/next/dist/docs/.../page.md), hence the await.
 *
 * Reading it here rather than with `useSearchParams` in the island keeps the
 * form out of a Suspense boundary it would otherwise need.
 *
 * Deliberately NOT gated on being signed out. Somebody signed in on a shared
 * browser, or halfway through a session they no longer trust, is exactly who
 * wants this page; `resetPassword` re-establishes the session as whoever owns
 * the address before it changes anything.
 */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const raw = (await searchParams).email;
  const email = typeof raw === "string" ? raw : "";
  return <ResetPasswordClient initialEmail={email} />;
}
