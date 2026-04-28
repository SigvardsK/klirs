"use client";

import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";

export function SignOutButton() {
  const router = useRouter();

  const handleSignOut = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
  };

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleSignOut}
      className="text-slate-400 hover:text-white"
    >
      <LogOut className="w-4 h-4" />
    </Button>
  );
}
