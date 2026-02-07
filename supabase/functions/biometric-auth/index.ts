import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { action, credentialId } = await req.json();

    if (action === "verify") {
      // Find the credential
      const { data: credential, error: credError } = await supabase
        .from("webauthn_credentials")
        .select("user_id, counter")
        .eq("credential_id", credentialId)
        .single();

      if (credError || !credential) {
        return new Response(
          JSON.stringify({ success: false, error: "Credential not found" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 404 }
        );
      }

      // Get user email from profiles
      const { data: profile, error: profileError } = await supabase
        .from("profiles")
        .select("email")
        .eq("user_id", credential.user_id)
        .single();

      if (profileError || !profile) {
        return new Response(
          JSON.stringify({ success: false, error: "User not found" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 404 }
        );
      }

      // Update counter and last_used_at
      await supabase
        .from("webauthn_credentials")
        .update({ 
          counter: credential.counter + 1,
          last_used_at: new Date().toISOString()
        })
        .eq("credential_id", credentialId);

      // Generate a temporary sign-in link
      const { data: signInData, error: signInError } = await supabase.auth.admin.generateLink({
        type: "magiclink",
        email: profile.email!,
        options: {
          redirectTo: `${req.headers.get("origin") || supabaseUrl}/`,
        },
      });

      if (signInError || !signInData) {
        return new Response(
          JSON.stringify({ success: false, error: "Failed to generate auth" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
        );
      }

      // Extract the token from the action link
      const actionLink = signInData.properties?.action_link || "";
      const tokenMatch = actionLink.match(/token=([^&]+)/);
      const token = tokenMatch ? tokenMatch[1] : "";

      return new Response(
        JSON.stringify({ 
          success: true, 
          email: profile.email,
          tempToken: token,
          actionLink: actionLink
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ error: "Invalid action" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 }
    );
  } catch (error) {
    console.error("Biometric auth error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
    );
  }
});
