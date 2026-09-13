// Clerk protects everything except the sign-in route and the public instructions page.
//
// Guarded by env: with no Clerk keys the middleware is a pass-through, so `next build`
// and a keyless local run both work (D8's seeded demo account is a human setup step).

import { NextResponse } from "next/server";
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

const CLERK_CONFIGURED =
  Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) && Boolean(process.env.CLERK_SECRET_KEY);

const isPublicRoute = createRouteMatcher(["/sign-in(.*)", "/sign-up(.*)", "/instructions(.*)"]);

const protectedMiddleware = clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req)) {
    await auth.protect();
  }
});

export default CLERK_CONFIGURED ? protectedMiddleware : () => NextResponse.next();

export const config = {
  matcher: [
    // everything except Next internals and static files
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
