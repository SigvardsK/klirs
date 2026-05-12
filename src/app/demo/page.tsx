import { redirect } from "next/navigation";

/**
 * /demo is preserved as a legacy URL after the landing rework (2026-05-12).
 * The screening form now lives on `/` and submission routes to `/screen/[id]`.
 * Anyone bookmarking the old /demo URL is redirected to the new entrypoint.
 */
export default function DemoPage() {
  redirect("/");
}
