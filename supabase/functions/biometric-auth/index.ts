import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { verifyAuthenticationResponse } from "npm:@simplewebauthn/server@10.0.1";

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

  // Pre-login WebAuthn flow: no JWT yet. Rate limit instead of auth guard.
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

    const body = await req.json();
    const { action, credentialId } = body ?? {};

    if (!action || typeof action !== "string") {
      return new Response(
        JSON.stringify({ success: false, message: "Ação inválida" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 },
      );
    }

    if (action === "challenge") {
      if (!credentialId || typeof credentialId !== "string" || credentialId.length > 500) {
        return new Response(
          JSON.stringify({ success: false, message: "credentialId inválido" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 },
        );
      }
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      const challenge = btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=/g, "");
      await supabase
        .from("webauthn_challenges")
        .upsert(
          {
            credential_id: credentialId,
            challenge,
            expires_at: new Date(Date.now() + 300_000).toISOString(),
          },
          { onConflict: "credential_id" },
        );
      return new Response(
        JSON.stringify({ success: true, challenge }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (action === "verify") {
      const { authenticatorData, clientDataJSON, signature, origin } = body ?? {};

      if (
        !credentialId || typeof credentialId !== "string" || credentialId.length > 500 ||
        !authenticatorData || typeof authenticatorData !== "string" ||
        !clientDataJSON || typeof clientDataJSON !== "string" ||
        !signature || typeof signature !== "string" ||
        !origin || typeof origin !== "string"
      ) {
        return new Response(
          JSON.stringify({ success: false, message: "Payload inválido" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 },
        );
      }

      const { data: credential, error: credError } = await supabase
        .from("webauthn_credentials")
        .select("user_id, counter, public_key")
        .eq("credential_id", credentialId)
        .single();

      if (credError || !credential) {
        return new Response(
          JSON.stringify({ success: false, message: "Credencial não encontrada" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 404 },
        );
      }

      // Origin allow-list (csv via env). Reject unknown origins.
      const allowedOrigins = (Deno.env.get("WEBAUTHN_ALLOWED_ORIGINS") ?? "")
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean);
      if (allowedOrigins.length === 0 || !allowedOrigins.includes(origin)) {
        return new Response(
          JSON.stringify({ success: false, message: "Origem não permitida" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 401 },
        );
      }

      const expectedRPID = Deno.env.get("WEBAUTHN_RP_ID") ?? new URL(origin).hostname;

      // Fetch stored challenge (server-side, single use, 5 min TTL).
      const { data: chalRec } = await supabase
        .from("webauthn_challenges")
        .select("challenge")
        .eq("credential_id", credentialId)
        .gt("expires_at", new Date().toISOString())
        .maybeSingle();

      if (!chalRec) {
        return new Response(
          JSON.stringify({ success: false, message: "Challenge expirado ou não encontrado" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 },
        );
      }

      // Cryptographic proof-of-possession.
      let verification;
      try {
        verification = await verifyAuthenticationResponse({
          response: {
            id: credentialId,
            rawId: credentialId,
            type: "public-key",
            clientExtensionResults: {},
            response: {
              authenticatorData,
              clientDataJSON,
              signature,
            },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- shape exato do AuthenticationResponseJSON do @simplewebauthn varia por versão; cast no boundary da lib
          } as any,
          expectedChallenge: (c) => c === chalRec.challenge,
          expectedOrigin: allowedOrigins,
          expectedRPID,
          authenticator: {
            credentialID: Uint8Array.from(atob(credentialId.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)),
            credentialPublicKey: Uint8Array.from(atob(credential.public_key), (c) => c.charCodeAt(0)),
            counter: credential.counter ?? 0,
          },
          requireUserVerification: false,
        });
      } catch (err) {
        console.error("WebAuthn verification threw:", err);
        return new Response(
          JSON.stringify({ success: false, message: "Verificação falhou" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 401 },
        );
      }

      if (!verification.verified || !verification.authenticationInfo) {
        return new Response(
          JSON.stringify({ success: false, message: "Verificação falhou" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 401 },
        );
      }

      const newCounter = verification.authenticationInfo.newCounter ?? 0;
      // Replay protection: if either side reports a counter > 0, require strictly greater.
      if ((credential.counter ?? 0) > 0 || newCounter > 0) {
        if (newCounter <= (credential.counter ?? 0)) {
          return new Response(
            JSON.stringify({ success: false, message: "Counter inválido" }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 401 },
          );
        }
      }

      // Consume challenge (single use).
      await supabase
        .from("webauthn_challenges")
        .delete()
        .eq("credential_id", credentialId);

      // Only update counter / last_used_at after successful verification.
      await supabase
        .from("webauthn_credentials")
        .update({
          counter: newCounter,
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
