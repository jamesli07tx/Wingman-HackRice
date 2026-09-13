import { FeedClient } from "@/components/feed/FeedClient";

// INTEGRATION(X-MACHINE):
// COUNTERPART: the human debugging GlassBridge on the Mac — this page is the Mac
//   side's observability window into what Cortex thinks the glasses are seeing.
// CONTRACT: DESIGN.md §4.3 — dashboard WebSocket (wss://…/ws/dashboard?token=<Clerk JWT>),
//   read-only mirror of render/status plus gate telemetry and silenced identifications.
// AT-INTEGRATION: none — observability window; it lights up on its own once Cortex is
//   deployed and a device connects.

export const dynamic = "force-dynamic";

export default function FeedPage() {
  return <FeedClient />;
}
