const SUPABASE_URL = "https://bfolaqggvojflrfgqqga.supabase.co";

const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJmb2xhcWdndm9qZmxyZmdxcWdhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg1MjQyMTYsImV4cCI6MjA5NDEwMDIxNn0.7HB2QWO6IRt-8QpclJMcbPf9rKWjsZW8xCodRzsxeDI";

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
