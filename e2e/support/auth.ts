import { expect, type Page } from "@playwright/test";

const ONBOARDING_URL = /\/onboarding/;
const DASHBOARD_URL = /\/dashboard/;

let accountCounter = 0;

// Each call provisions a brand-new account + organization via the real
// sign-up → onboarding flow, then lands on /dashboard. Unique emails keep
// tests isolated and deterministic — no shared state, no sign-in branching.
// Uniqueness needs all three parts: Date.now() across runs (the local dev
// DB persists), process.pid across CI's parallel worker processes (two
// workers can land on the same millisecond), the counter within one worker.
export async function createAccountWithOrg(page: Page, label: string) {
  accountCounter += 1;
  const unique = `${Date.now()}-${process.pid}-${accountCounter}`;
  const email = `e2e-${label}-${unique}@mitosia.test`;
  const password = "e2e-smoke-password-1";

  await page.goto("/sign-up");
  await page.getByLabel("Name").fill(`E2E ${label}`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();

  // 30s, not 15: on CI's 2-vCPU runner these first navigations absorb cold
  // route compiles plus whatever the other worker is transcoding at the
  // time. 15s flaked under parallel workers (PR #62's first run).
  await page.waitForURL(ONBOARDING_URL, { timeout: 30_000 });

  await page.getByLabel("Organization name").fill(`Org ${unique}`);
  await page.getByRole("button", { name: "Create organization" }).click();
  await page.waitForURL(DASHBOARD_URL, { timeout: 30_000 });

  await expect(page).toHaveURL(DASHBOARD_URL);
  return { email, org: `Org ${unique}` };
}
