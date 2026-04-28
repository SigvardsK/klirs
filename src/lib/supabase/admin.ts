import { createClient } from "@supabase/supabase-js";

// Service role client for server-side operations (storage uploads, screening writes)
// NEVER expose this on the client side
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY!
  );
}
