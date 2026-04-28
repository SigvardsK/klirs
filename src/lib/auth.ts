import { createClient } from "@/lib/supabase/server";

export interface CurrentUser {
  id: string;
  email: string;
  full_name: string;
  initials: string;
}

export async function getCurrentUserProfile(): Promise<CurrentUser | null> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user?.email) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, email, organization")
    .eq("id", user.id)
    .single();

  const name = profile?.full_name
    || user.user_metadata?.full_name
    || user.user_metadata?.name
    || user.email?.split("@")[0]
    || "User";

  const parts = name.split(" ").filter(Boolean);
  const initials = parts.length >= 2
    ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    : name.substring(0, 2).toUpperCase();

  return {
    id: user.id,
    email: user.email,
    full_name: name,
    initials,
  };
}
