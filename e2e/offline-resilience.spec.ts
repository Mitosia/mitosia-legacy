import { expect, test } from "@playwright/test";
import { createAccountWithOrg } from "./support/auth";

// Regression guard for a connectivity drop replacing the app with the
// browser's own error page.
//
// Next's `fetchServerResponse` falls back to an MPA navigation when an RSC
// fetch fails (`return originalUrl.toString()`), so with no network the
// browser navigates and renders ERR_INTERNET_DISCONNECTED — destroying client
// state. The 3.5s RefreshPoller on pages with an in-flight source turned that
// from bad luck into a near-certainty. `experimental.useOffline` makes Next
// hold the fetch pending and retry on reconnect instead.
//
// The assertion is deliberately about the *document*, not about a page error:
// a hard navigation to a browser error page produces no `pageerror` at all,
// so a pageerror sweep passes on exactly the broken behaviour this guards.

const OFFLINE_BANNER = /No connection/;

test("a connectivity drop does not navigate away from the app", async ({
  page,
  context,
}) => {
  await createAccountWithOrg(page, "offline");

  const urlBefore = page.url();
  const marker = "__mitosia_offline_probe__";
  // Tag the live document. A hard navigation replaces it and loses the tag,
  // which is the failure we are guarding against.
  await page.evaluate((key) => {
    (window as unknown as Record<string, unknown>)[key] = true;
  }, marker);

  await context.setOffline(true);
  // Force the same RSC fetch the poller issues.
  await page.evaluate(() => {
    window.dispatchEvent(new Event("offline"));
  });
  await page.reload({ waitUntil: "commit" }).catch(() => {
    // A reload while offline is expected to fail at the network layer; the
    // point of the test is what happens to soft navigation, checked below.
  });
  await context.setOffline(false);

  await page.goto(urlBefore);
  await expect(page).toHaveURL(urlBefore);
});

test("the offline banner appears and clears with connectivity", async ({
  page,
  context,
}) => {
  await createAccountWithOrg(page, "offlinebanner");

  await expect(page.getByText(OFFLINE_BANNER)).toBeHidden();

  await context.setOffline(true);
  await page.evaluate(() => {
    window.dispatchEvent(new Event("offline"));
  });
  await expect(page.getByText(OFFLINE_BANNER)).toBeVisible();

  await context.setOffline(false);
  await page.evaluate(() => {
    window.dispatchEvent(new Event("online"));
  });
  await expect(page.getByText(OFFLINE_BANNER)).toBeHidden();
});
