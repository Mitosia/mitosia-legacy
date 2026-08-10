import { expect, test } from "@playwright/test";
import { createAccountWithOrg } from "../e2e/support/auth";

// Guards the blind spot that let a hydration mismatch reach production: the
// main e2e suite runs against `next dev`, where React surfaces mismatches as
// a development warning rather than the minified runtime error thrown by a
// production build. The sidebar org label rendered a client-store value over
// a server-rendered fallback, and React responded by regenerating the whole
// client tree — intermittently, on every app page (PR #19).
//
// The two tests below do different jobs, and the difference matters:
//
//   1. The error sweep is a broad NET, not a guard. It catches anything a
//      production build throws on load, but it cannot be relied on for a
//      timing-dependent mismatch: reintroducing the #19 bug and running
//      this suite, the sweep passed (the mismatch needs the client store to
//      win a race, and it lost it 12 times running) while test 2 failed
//      immediately. Don't add a timing-dependent regression here and
//      consider it covered.
//   2. The SSR assertion is the actual regression guard — deterministic,
//      because it reads the server's bytes instead of waiting for a race.
//
// When guarding a future hydration bug, assert on the SSR payload.

// 418/423/425 are the hydration family; named so a failure explains itself
// rather than leaving a bare error code to look up.
const REACT_HYDRATION_ERROR = /Minified React error #(418|423|425)/;

const ROUTES = ["/dashboard", "/clients", "/settings/members"];

// Several passes per route: cheap against a prebuilt server (~1s total) and
// it widens the net, without pretending to make it deterministic.
const PASSES = 4;

test("no runtime errors on a full document load of every app page", async ({
  page,
}) => {
  test.setTimeout(120_000);

  const failures: string[] = [];
  page.on("pageerror", (error) => {
    failures.push(`pageerror on ${page.url()}: ${error.message}`);
  });
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      REACT_HYDRATION_ERROR.test(message.text())
    ) {
      failures.push(
        `hydration console error on ${page.url()}: ${message.text()}`
      );
    }
  });

  await createAccountWithOrg(page, "prodhydration");

  for (let pass = 0; pass < PASSES; pass += 1) {
    for (const route of ROUTES) {
      // A full document load, not client-side navigation: hydration only
      // happens when the browser parses server-rendered HTML.
      // biome-ignore lint/performance/noAwaitInLoops: sequential full loads are the point
      const response = await page.goto(route, { waitUntil: "load" });
      expect(response?.status(), `${route} should serve HTML`).toBe(200);
      await expect(page.getByRole("heading").first()).toBeVisible();
    }
  }

  expect(failures, failures.join("\n")).toEqual([]);
});

// The label that actually broke: it must be present in the server-rendered
// HTML, not painted in after hydration. Asserting on the SSR payload keeps
// the fix honest — a client-only render would still look right in a
// screenshot while reintroducing the mismatch. Verified to fail against a
// build with the #19 regression restored.
test("the sidebar org label is server-rendered", async ({ page, request }) => {
  const { org } = await createAccountWithOrg(page, "prodorglabel");

  const cookies = await page.context().cookies();
  const response = await request.get("/dashboard", {
    headers: {
      cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; "),
    },
  });

  expect(response.status()).toBe(200);
  const html = await response.text();
  expect(html, "org name missing from SSR HTML").toContain(org);
  expect(html, "SSR emitted the pre-hydration fallback").not.toContain(
    "Select organization"
  );
});
