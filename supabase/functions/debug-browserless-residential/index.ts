import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const token = Deno.env.get("BROWSERLESS_TOKEN")!;
  const url = `https://chrome.browserless.io/function?token=${token}&proxy=residential`;

  const code = `
export default async ({ page }) => {
  await page.goto('http://portal.sayerlack.com.br:9092/login', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await new Promise(r => setTimeout(r, 3000));
  const screenshot = await page.screenshot({ type: 'png', encoding: 'base64' });
  const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 2000));
  return {
    data: {
      bodyText,
      hasBlockMessage: bodyText.includes('Não é possível fazer login no momento')
    },
    type: 'application/json',
    screenshot
  };
};
`;

  const t0 = Date.now();
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/javascript" },
      body: code,
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ stage: "fetch_failed", error: String(e?.message ?? e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const elapsed = Date.now() - t0;
  const status = resp.status;
  const ctype = resp.headers.get("content-type") ?? "";
  const rawText = await resp.text();

  let parsed: any = null;
  let parseErr: string | null = null;
  try { parsed = JSON.parse(rawText); } catch (e: any) { parseErr = String(e?.message ?? e); }

  let uploadedPath: string | null = null;
  let uploadErr: string | null = null;
  let signedUrl: string | null = null;

  if (status === 200 && parsed?.screenshot) {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const filename = `teste_residential_${Date.now()}.png`;
    const b64 = String(parsed.screenshot).replace(/^data:image\/png;base64,/, "");
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const { error: upErr } = await supabase.storage
      .from("portal_screenshots")
      .upload(filename, bytes, { contentType: "image/png", upsert: true });
    if (upErr) uploadErr = upErr.message;
    else {
      uploadedPath = filename;
      const { data: signed } = await supabase.storage
        .from("portal_screenshots")
        .createSignedUrl(filename, 3600);
      signedUrl = signed?.signedUrl ?? null;
    }
  }

  return new Response(JSON.stringify({
    browserless: {
      status,
      elapsed_ms: elapsed,
      content_type: ctype,
      raw_preview: rawText.substring(0, 600),
      parse_error: parseErr,
      data: parsed?.data ?? null,
      has_screenshot: !!parsed?.screenshot,
    },
    upload: { uploadedPath, uploadErr, signedUrl },
  }, null, 2), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
