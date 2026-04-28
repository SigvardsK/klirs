"use client";

import { ScreeningViewer } from "./screening-viewer";
import { DEMO_SCREENING, DEMO_CHECKS } from "@/lib/demo-data";

export function DemoScreeningViewer() {
  return (
    <ScreeningViewer
      screening={DEMO_SCREENING}
      checks={DEMO_CHECKS}
      supabaseUrl=""
      demoMode={true}
    />
  );
}
