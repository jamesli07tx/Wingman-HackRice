import { FairClient } from "@/components/fair/FairClient";

// Fair list drop-in — new route, new files only (the UI redesign owns the
// existing console files). Linked from the NavBar after the redesign merges;
// until then reach it at /fair.

export const dynamic = "force-dynamic";

export default function FairPage() {
  return <FairClient />;
}
