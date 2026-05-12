const SUPABASE_URL = "https://bfolaqggvojflrfgqqga.supabase.co";

const SUPABASE_ANON_KEY = "YOUR_REAL_KEY_HERE";

const supabaseClient = supabase.createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storage: window.localStorage
    }
  }
);
