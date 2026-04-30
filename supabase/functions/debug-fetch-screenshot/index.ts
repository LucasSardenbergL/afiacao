import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const file = url.searchParams.get("file") ?? "pedido_57_1777515376840.png";
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const { data, error } = await supabase.storage
    .from("portal_screenshots")
    .createSignedUrl(file, 3600);
  return new Response(JSON.stringify({ data, error }), {
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });
});
