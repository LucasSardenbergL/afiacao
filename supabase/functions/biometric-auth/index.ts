import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

// In-memory rate limiter: 5 attempts per IP per minute.
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60_000;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || bucket.resetAt < now) {
    rateBuckets.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (bucket.count >= RATE_LIMIT_MAX) return false;
  bucket.count += 1;
  return true;
}

function getClientIp(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const __auth = await authorizeCronOrStaff(req);
  if (!__auth.ok) return __auth.response;

  const ip = getClientIp(req);
  if (!checkRateLimit(ip)) {
    return new Response(
      JSON.stringify({ success: false, message: "Too many attempts" }),
      { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { action, credentialId } = await req.json();

    if (!action || typeof action !== "string") {
      return new Response(
        JSON.stringify({ success: false, message: "Ação inválida" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 },
      );
    }

    if (action === "verify") {
      if (!credentialId || typeof credentialId !== "string" || credentialId.length > 500) {
        return new Response(
          JSON.stringify({ success: false, message: "Credencial inválida" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 },
        );
      }

      const { data: credential, error: credError } = await supabase
        .from("webauthn_credentials")
        .select("user_id, counter")
        .eq("credential_id", credentialId)
        .single();

      if (credError || !credential) {
        return new Response(
          JSON.stringify({ success: false, message: "Credencial não encontrada" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 404 },
        );
      }

      await supabase
        .from("webauthn_credentials")
        .update({
          counter: credential.counter + 1,
          last_used_at: new Date().toISOString(),
        })
        .eq("credential_id", credentialId);

      // SECURITY: never disclose email or magic-link token to caller.
      return new Response(
        JSON.stringify({
          success: true,
          user_id: credential.user_id,
          message: "Credencial verificada",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({ success: false, message: "Ação não reconhecida" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 },
    );
  } catch (error) {
    console.error("Biometric auth error:", error);
    return new Response(
      JSON.stringify({ success: false, message: "Erro interno" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 },
    );
  }
});
