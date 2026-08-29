import { render } from "@react-email/render";
import { describe, expect, it } from "vitest";
import { PasswordResetEmail } from "@/lib/email/password-reset-email";

describe("PasswordResetEmail", () => {
  it("renders the recipient, reset link, expiry, and safety guidance", async () => {
    const resetUrl =
      "https://app.mitosia.com/api/auth/reset-password/test-token?callbackURL=%2Freset-password";
    const email = PasswordResetEmail({
      name: "Avery Agency",
      resetUrl,
    });

    const [html, text] = await Promise.all([
      render(email),
      render(email, { plainText: true }),
    ]);

    expect(html).toContain("Choose a new password");
    expect(html).toContain(resetUrl.replace("&", "&amp;"));
    expect(text).toContain("Hi Avery");
    expect(text).toContain("expires in one hour");
    expect(text).toContain("If you did not request it");
    expect(text).toContain(resetUrl);
  });
});
