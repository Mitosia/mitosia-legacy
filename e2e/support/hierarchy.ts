import type { Page } from "@playwright/test";

// Walks the real client → brand → campaign → project flow and lands on the
// project page (where the uploader lives).
//
// Names carry a per-attempt suffix: a retry that reuses fixed names can
// otherwise click into the previous attempt's identically-named hierarchy
// (and with RLS accidentally disabled, even cross-tenant — see PR #16).
export async function createHierarchy(page: Page, run: string) {
  const client = `E2E Media Client ${run}`;
  const brand = `E2E Brand ${run}`;
  const campaign = `E2E Campaign ${run}`;
  const project = `E2E Project ${run}`;

  await page.goto("/clients");
  await page.getByLabel("New client").fill(client);
  await page.getByRole("button", { name: "Add client" }).click();
  await page.getByRole("link", { name: client }).click();

  await page.getByLabel("New brand").fill(brand);
  await page.getByRole("button", { name: "Add brand" }).click();
  await page.getByRole("link", { name: brand }).click();

  await page.getByLabel("New campaign").fill(campaign);
  await page.getByRole("button", { name: "Add campaign" }).click();
  await page.getByRole("link", { name: campaign }).click();

  await page.getByLabel("New project").fill(project);
  await page.getByRole("button", { name: "Add project" }).click();
  await page.getByRole("link", { name: project }).click();

  return { brand, campaign, client, project };
}
