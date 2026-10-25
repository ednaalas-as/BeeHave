const DEFAULT_APP_URL = "http://localhost:5173";

function mailConfiguration() {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.PASSWORD_RESET_EMAIL_FROM;
  const appUrl = process.env.APP_PUBLIC_URL ?? DEFAULT_APP_URL;
  if (!apiKey || !from) return null;

  let baseUrl: URL;
  try {
    baseUrl = new URL(appUrl);
  } catch {
    return null;
  }
  if (process.env.NODE_ENV === "production" && baseUrl.protocol !== "https:") {
    return null;
  }
  return { apiKey, from, baseUrl };
}

export function passwordResetEmailConfigured() {
  return mailConfiguration() !== null;
}

export async function sendPasswordResetEmail(email: string, token: string) {
  const config = mailConfiguration();
  if (!config) throw new Error("Password recovery email is not configured.");

  const resetUrl = new URL(config.baseUrl);
  // Keep the bearer token in the URL fragment so browsers never send it as a
  // request path or referrer when loading the web app.
  resetUrl.hash = new URLSearchParams({ reset: token }).toString();
  const link = resetUrl.toString();
  const safeLink = link.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({
      from: config.from,
      to: [email],
      subject: "Reset your BeeHave password",
      text: `We received a request to reset your BeeHave password. Use this link within 30 minutes:\n\n${link}\n\nIf you did not request a password reset, you can ignore this email.`,
      html: `<p>We received a request to reset your BeeHave password.</p><p><a href="${safeLink}">Reset your password</a></p><p>This link expires in 30 minutes. If you did not request a password reset, you can ignore this email.</p>`,
    }),
  });

  if (!response.ok) {
    // Resend explains rejections (unverified sender, test-mode recipient) in
    // the body's message; it never echoes the API key.
    const detail = await response
      .json()
      .then((body: { message?: unknown }) =>
        typeof body?.message === "string" ? body.message.slice(0, 300) : "",
      )
      .catch(() => "");
    throw new Error(
      `Password reset email provider returned ${response.status}${detail ? `: ${detail}` : "."}`,
    );
  }
}
