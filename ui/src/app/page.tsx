import { HomeClient } from "@/components/home/HomeClient";

// Everything on this page talks to Cortex from the browser with a live Clerk JWT.
// force-dynamic keeps it out of the build-time prerender (the backend may not exist yet).
export const dynamic = "force-dynamic";

export default function HomePage() {
  return <HomeClient />;
}
