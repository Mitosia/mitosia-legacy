import { expect, test } from "@playwright/test";
import { createAccountWithOrg } from "./support/auth";

const ORG_TRIGGER = /Organization/;
const NEW_ORG_ITEM = /New organization/;
const USER_MENU_TRIGGER = /E2E usermenu/;
const SIGN_OUT_ITEM = /Sign out/;

// Regression guard for the sidebar menu crash: opening the org switcher or
// the user menu threw "MenuGroupContext is missing" because a Menu.GroupLabel
// lived outside a Menu.Group. Each test collects page errors and fails if any
// runtime error surfaces while driving the shell.

test("org switcher menu opens without a runtime error", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await createAccountWithOrg(page, "orgswitch");
  await page.getByRole("button", { name: ORG_TRIGGER }).first().click();

  await expect(
    page.getByRole("menuitem", { name: NEW_ORG_ITEM })
  ).toBeVisible();
  expect(errors, errors.join("\n")).toEqual([]);
});

test("user menu opens without a runtime error", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await createAccountWithOrg(page, "usermenu");
  await page.getByRole("button", { name: USER_MENU_TRIGGER }).click();

  await expect(
    page.getByRole("menuitem", { name: SIGN_OUT_ITEM })
  ).toBeVisible();
  expect(errors, errors.join("\n")).toEqual([]);
});

test("primary navigation loads every top-level page without errors", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await createAccountWithOrg(page, "nav");
  for (const path of ["/dashboard", "/clients", "/settings/members"]) {
    // biome-ignore lint/performance/noAwaitInLoops: sequential navigation is the point of this smoke test
    await page.goto(path);
    await expect(page.getByRole("heading").first()).toBeVisible();
  }
  expect(errors, errors.join("\n")).toEqual([]);
});
