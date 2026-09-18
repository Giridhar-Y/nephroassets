import { OAuth2Client } from "google-auth-library";

// Both required together — IT provisions these in the server environment once the GCP
// OAuth client and Workspace domain are set up (see .env.example). Unset means the
// feature is off: /api/auth/google-config reports disabled and the client hides the
// button, same convention as OPENAI_API_KEY/EXPORT_S3_* elsewhere in this app.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_WORKSPACE_DOMAIN = process.env.GOOGLE_WORKSPACE_DOMAIN;

const client = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

export function googleSsoConfig(): { enabled: boolean; clientId: string | null } {
  const enabled = Boolean(GOOGLE_CLIENT_ID && GOOGLE_WORKSPACE_DOMAIN);
  return { enabled, clientId: enabled ? GOOGLE_CLIENT_ID! : null };
}

/** The actual admission decision, pulled out of verifyGoogleCredential below so it's
 *  testable without a real Google-signed token: given an already-signature-verified
 *  token's email/email_verified claims, is this identity allowed in? Domain is checked
 *  against the email's own suffix rather than the token's `hd` claim: the email in a
 *  verified ID token is exactly the account Google authenticated, so it's an equally
 *  strong check and doesn't depend on `hd` being present (it isn't always, for some
 *  Workspace-migrated accounts). Case-insensitive on both sides, same convention as
 *  every other email comparison in this app (users.idx_users_email_ci). */
export function isAllowedGoogleEmail(
  email: string | undefined,
  emailVerified: boolean | undefined,
  workspaceDomain: string
): boolean {
  if (!email || !emailVerified) return false;
  const domain = email.split("@")[1]?.toLowerCase();
  return domain === workspaceDomain.toLowerCase();
}

/** Verifies a Google Identity Services ID token (the `credential` a Sign In With Google
 *  button hands back) and returns the signed-in Google account's email — or null if the
 *  token doesn't verify, isn't for our GCP client, or isn't on the configured Workspace
 *  domain. */
export async function verifyGoogleCredential(idToken: string): Promise<{ email: string } | null> {
  const { enabled } = googleSsoConfig();
  if (!enabled || !client) return null;

  let payload;
  try {
    const ticket = await client.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID! });
    payload = ticket.getPayload();
  } catch {
    return null;
  }
  if (!isAllowedGoogleEmail(payload?.email, payload?.email_verified, GOOGLE_WORKSPACE_DOMAIN!)) return null;

  return { email: payload!.email! };
}
