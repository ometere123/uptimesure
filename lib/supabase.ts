import { createClient, SupabaseClient } from "@supabase/supabase-js";

let singleton: SupabaseClient | null | undefined;

export function getSupabase(): SupabaseClient | null {
  if (singleton !== undefined) return singleton;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  singleton = url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;
  return singleton;
}
