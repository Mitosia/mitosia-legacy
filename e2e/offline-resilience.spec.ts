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
const CLIENTS_LINK = /Clients/i;

test("a connectivity drop does not replace the document", async ({
  page,
  context,
}) => {
  await createAccountWithOrg(page, "offline");
  await page.goto("/dashboard");

  // Tag the live document. Only a real navigation clears this, so it is the
  // difference between "the soft navigation was held pending" (the fix) and
  // "the browser navigated and rendered its error page" (the bug).
  const MARKER = "__mitosiaOfflineProbe";
  await page.evaluate((key) => {
    (window as unknown as Record<string, string>)[key] = "alive";
  }, MARKER);

  await context.setOffline(true);

  // A soft navigation issues exactly the RSC fetch the 3.5s poller issues.
  // Offline and unfixed, fetchServerResponse falls through to its MPA
  // fallback and the browser leaves the app.
  await page
    .getByRole("link", { name: CLIENTS_LINK })
    .first()
    .click({ timeout: 5000 })
    .catch(() => {
      // Whether the click resolves is not the assertion; surviving is.
    });

  // Give the failed fetch time to fall back, if it is going to.
  await page.waitForTimeout(3000);

  const survived = await page
    .evaluate(
      (key) => (window as unknown as Record<string, string>)[key] ?? null,
      MARKER
    )
    .catch(() => null);

  expect(
    survived,
    "the document was replaced — Next fell back to a browser navigation while offline"
  ).toBe("alive");

  await context.setOffline(false);
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
