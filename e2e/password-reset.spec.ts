import { expect, test } from "@playwright/test";
import { createAccountWithOrg } from "./support/auth";
import { queryRows } from "./support/db";

const NEW_PASSWORD = "e2e-new-password-2";
const ACCOUNT_EXISTS_MESSAGE = /If an account exists for/;
const DASHBOARD_URL = /\/dashboard/;
const INVALID_RESET_URL = /\/reset-password\?error=INVALID_TOKEN/;
const RESET_TOKEN_URL = /\/reset-password\?token=/;
const SIGN_IN_URL = /\/sign-in/;

test("a user can request and complete a single-use password reset", async ({
  page,
}) => {
  // The first auth run may compile sign-up, onboarding, dashboard, both
  // recovery screens, and the Better Auth catch-all route from cold.
  test.setTimeout(120_000);
  const { email } = await createAccountWithOrg(page, "password-reset");

  await page.goto("/sign-in");
  await expect(
    page.getByRole("link", { name: "Forgot password?" })
  ).toHaveAttribute("href", "/forgot-password");

  // A full navigation avoids a dev-only race where cold client navigation
  // recompiles and remounts the form after Playwright has already filled it.
  await page.goto("/forgot-password");
  const emailInput = page.getByLabel("Email");
  await emailInput.fill(email);
  await expect(emailInput).toHaveValue(email);
  const resetRequest = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/auth/request-password-reset") &&
      response.request().method() === "POST"
  );
  await page.getByRole("button", { name: "Send reset link" }).click();
  const resetResponse = await resetRequest;
  expect(
    resetResponse.ok(),
    `password reset request failed (${resetResponse.status()}): ${await resetResponse.text()}`
  ).toBe(true);

  await expect(page.getByText("Check your email")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(ACCOUNT_EXISTS_MESSAGE)).toBeVisible();

  const [verification] = await queryRows<{ identifier: string }>(
    `SELECT verification.identifier
       FROM verification
       JOIN "user" ON "user".id = verification.value
      WHERE "user".email = $1
        AND verification.identifier LIKE 'reset-password:%'
      ORDER BY verification.created_at DESC
      LIMIT 1`,
    [email]
  );
  expect(verification).toBeDefined();
  const token = verification.identifier.replace("reset-password:", "");
  const callbackPath = `/api/auth/reset-password/${encodeURIComponent(token)}?callbackURL=${encodeURIComponent("/reset-password")}`;

  await page.goto(callbackPath);
  await expect(page).toHaveURL(RESET_TOKEN_URL);
  await page.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
  await page.getByLabel("Confirm new password").fill("does-not-match");
  await page.getByRole("button", { name: "Reset password" }).click();
  await expect(page.getByText("The passwords do not match.")).toBeVisible();

  await page.getByLabel("Confirm new password").fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Reset password" }).click();
  await expect(page.getByText("Password updated")).toBeVisible();

  // Better Auth revokes every existing session after a password reset.
  await page.goto("/dashboard");
  await expect(page).toHaveURL(SIGN_IN_URL);

  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(DASHBOARD_URL);

  // The consumed token cannot be replayed.
  await page.goto(callbackPath);
  await expect(page).toHaveURL(INVALID_RESET_URL);
  await expect(page.getByText("Reset link unavailable")).toBeVisible();
});
