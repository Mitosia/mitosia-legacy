import { getSessionCookie } from "better-auth/cookies";
import { type NextRequest, NextResponse } from "next/server";

const AUTH_PAGES = new Set([
  "/forgot-password",
  "/reset-password",
  "/sign-in",
  "/sign-up",
]);

// Optimistic redirect only — real session validation happens in server
// components and route handlers. Do not add authorization logic here.
export function proxy(request: NextRequest) {
  const sessionCookie = getSessionCookie(request);
  const { pathname } = request.nextUrl;

  if (!(sessionCookie || AUTH_PAGES.has(pathname))) {
    return NextResponse.redirect(new URL("/sign-in", request.url));
  }

  // Deliberately no cookie→dashboard bounce for auth pages: a stale cookie
  // (present in the browser, no session row behind it) would loop —
  // /dashboard's server check sends the user to /sign-in, the bounce sends
  // them back. Signed-in visitors to /sign-in simply see the form.
  return NextResponse.next();
}

export const config = {
  matcher: [
    "/accept-invitation/:path*",
    "/brands/:path*",
    "/campaigns/:path*",
    "/clients/:path*",
    "/dashboard/:path*",
    "/onboarding",
    "/projects/:path*",
    "/reset-password",
    "/settings/:path*",
    "/forgot-password",
    "/sign-in",
    "/sign-up",
  ],
};
