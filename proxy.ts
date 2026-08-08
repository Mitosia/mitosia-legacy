import { getSessionCookie } from "better-auth/cookies";
import { type NextRequest, NextResponse } from "next/server";

const AUTH_PAGES = new Set(["/sign-in", "/sign-up"]);

// Optimistic redirect only — real session validation happens in server
// components and route handlers. Do not add authorization logic here.
export function proxy(request: NextRequest) {
  const sessionCookie = getSessionCookie(request);
  const { pathname } = request.nextUrl;

  if (!(sessionCookie || AUTH_PAGES.has(pathname))) {
    return NextResponse.redirect(new URL("/sign-in", request.url));
  }

  if (sessionCookie && AUTH_PAGES.has(pathname)) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*", "/sign-in", "/sign-up"],
};
