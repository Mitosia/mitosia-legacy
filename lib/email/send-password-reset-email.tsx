import { Resend } from "resend";
import { env } from "@/lib/env";
import { PasswordResetEmail } from "./password-reset-email";

const WHITESPACE = /\s+/;

interface SendPasswordResetEmailOptions {
  name: string;
  resetUrl: string;
  to: string;
}

export async function sendPasswordResetEmail({
  name,
  resetUrl,
  to,
}: SendPasswordResetEmailOptions): Promise<void> {
  if (!env.RESEND_API_KEY) {
    if (process.env.NODE_ENV === "production") {
      console.error(
        "[auth] password reset email skipped: RESEND_API_KEY is not configured"
      );
    } else {
      console.info(`[auth] password reset link for ${to}: ${resetUrl}`);
    }
    return;
  }

  const resend = new Resend(env.RESEND_API_KEY);
  const { error } = await resend.emails.send({
    from: env.EMAIL_FROM,
    react: <PasswordResetEmail name={name} resetUrl={resetUrl} />,
    subject: "Reset your Mitosia password",
    text: passwordResetText({ name, resetUrl }),
    to: [to],
  });

  if (error) {
    throw new Error(
      `Resend rejected the password reset email: ${error.message}`
    );
  }
}

function passwordResetText({
  name,
  resetUrl,
}: Pick<SendPasswordResetEmailOptions, "name" | "resetUrl">): string {
  const firstName = name.trim().split(WHITESPACE)[0] || "there";

  return [
    `Hi ${firstName},`,
    "",
    "A password reset was requested for your Mitosia account.",
    "Use this secure link to choose a new password:",
    resetUrl,
    "",
    "This link expires in one hour and can only be used once.",
    "If you did not request it, you can ignore this email; your password will not change.",
  ].join("\n");
}
