// Edge `cep-geo-resolver` — resolve UM CEP em coord (lat/lng) para o worker do
// Roteirizador-campo, com o token do CEP Aberto guardado SERVER-SIDE (nunca no
// browser). Cadeia: cep_geo (cache/SoT) → CEP Aberto → não-resolvido. NÃO usa
// Nominatim: o gate (Sub-PR 3) provou que ele devolve lixo p/ CEP nu; o miss aqui
// cai no centróide do município (a RPC da carteira/prospect já faz COALESCE) — pino
// honestamente "aproximado", nunca um pino errado (precisão > recall, money-path).
//
// Persistência: reencaminha o JWT do staff e chama o cep_geo_upsert existente
// (SECURITY DEFINER, gate gestor/master, idempotente, anti-downgrade de precisão) —
// zero migration nova. Gate da fronteira: authorizeCronOrStaff.
//
// Secret necessária (founder seta no Lovable): CEP_ABERTO_TOKEN.
import { createClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const CEP_ABERTO_TOKEN = Deno.env.get("CEP_ABERTO_TOKEN") ?? "";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

function normalizarCep(raw: unknown): string | null {
  const d = String(raw ?? "").replace(/\D/g, "");
  return /^\d{8}$/.test(d) ? d : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const auth = await authorizeCronOrStaff(req);
    if (!auth.ok) return auth.response;

    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch {
      /* corpo vazio é tratado como CEP inválido abaixo */
    }
    const cep = normalizarCep(body.cep);
    if (!cep) return json({ resolved: false, error: "CEP inválido" }, 400);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // 1) Cache: cep_geo é a fonte da verdade. Já resolvido → devolve na hora
    //    (preserva a precisão real — pode ser melhor que postcode, ex.: rooftop).
    const { data: cached } = await admin
      .from("cep_geo")
      .select("lat,lng,precision,source")
      .eq("cep", cep)
      .maybeSingle();
    if (cached && cached.lat != null && cached.lng != null) {
      return json({
        resolved: true,
        lat: Number(cached.lat),
        lng: Number(cached.lng),
        precision: cached.precision ?? "postcode_centroid",
        source: cached.source ?? "cep_geo",
        cached: true,
      });
    }

    if (!CEP_ABERTO_TOKEN) {
      console.error("CEP_ABERTO_TOKEN ausente — defina a secret no Supabase.");
      return json({ resolved: false, error: "sem token" });
    }

    // 2) CEP Aberto (token server-side). Timeout curto p/ não travar o worker;
    //    429/5xx/timeout/{} → lat/lng ficam null → não-resolvido (cai no centróide).
    let lat: number | null = null;
    let lng: number | null = null;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const r = await fetch(`https://www.cepaberto.com/api/v3/cep?cep=${cep}`, {
        headers: { Authorization: `Token token=${CEP_ABERTO_TOKEN}` },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (r.ok) {
        const j = (await r.json()) as { latitude?: string; longitude?: string };
        if (j && j.latitude && j.longitude) {
          lat = parseFloat(j.latitude);
          lng = parseFloat(j.longitude);
        }
      } else {
        console.warn("CEP Aberto não-ok:", r.status);
      }
    } catch (e) {
      console.warn("CEP Aberto falhou/timeout:", e instanceof Error ? e.message : String(e));
    }

    if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      return json({ resolved: false });
    }

    // 3) Persiste no cep_geo via RPC gated/anti-downgrade, reencaminhando o JWT do
    //    staff (o worker roda em contexto gestor/master). Falha no upsert NÃO impede
    //    devolver a coord — só não popula o cache desta vez.
    const authHeader = req.headers.get("Authorization") ?? "";
    if (authHeader.startsWith("Bearer ")) {
      const userClient = createClient(SUPABASE_URL, ANON_KEY, {
        global: { headers: { Authorization: authHeader } },
      });
      const { error: upErr } = await userClient.rpc("cep_geo_upsert", {
        p_cep: cep,
        p_lat: lat,
        p_lng: lng,
        p_source: "cep_aberto",
        p_precision: "postcode_centroid",
      });
      if (upErr) console.error("cep_geo_upsert falhou:", upErr.message);
    }

    return json({
      resolved: true,
      lat,
      lng,
      precision: "postcode_centroid",
      source: "cep_aberto",
      cached: false,
    });
  } catch (err) {
    console.error("cep-geo-resolver erro:", err instanceof Error ? err.message : String(err));
    return json({ resolved: false, error: "erro interno" }, 500);
  }
});
