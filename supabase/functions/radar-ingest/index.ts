import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const MES_RE = /^\d{4}-\d{2}$/;
const CNPJ_RE = /^\d{14}$/;

// Espelho fino do authorizeCronOrStaff: cron-secret OU staff master via JWT.
async function autorizado(req: Request): Promise<boolean> {
  const secret = req.headers.get("x-cron-secret");
  if (secret && CRON_SECRET && secret === CRON_SECRET) return true;
  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return false;
  const supa = createClient(SUPABASE_URL, SERVICE_KEY, { global: { headers: { Authorization: auth } } });
  const { data: { user } } = await supa.auth.getUser();
  if (!user) return false;
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data } = await admin.from("user_roles").select("role").eq("user_id", user.id).eq("role", "master");
  return (data?.length ?? 0) > 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (!(await autorizado(req))) return json({ error: "unauthorized" }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "body inválido" }, 400); }
  const action = String(body.action ?? "");
  const mes = String(body.mes ?? "");

  try {
    if (action === "begin_lote") {
      if (!MES_RE.test(mes)) return json({ error: "mes inválido (YYYY-MM)" }, 400);
      const { error } = await admin.from("radar_ingest_state").upsert({
        mes_referencia: mes, status: "running", total_recebido: 0, novos: null,
        iniciado_em: new Date().toISOString(), finalizado_em: null, erro: null,
      }, { onConflict: "mes_referencia" });
      if (error) throw error;
      return json({ ok: true, mes });
    }

    if (action === "chunk") {
      if (!MES_RE.test(mes)) return json({ error: "mes inválido" }, 400);
      const linhas = (body.linhas ?? []) as Record<string, unknown>[];
      if (!Array.isArray(linhas) || linhas.length === 0) return json({ error: "linhas vazio" }, 400);
      if (linhas.length > 1000) return json({ error: "máx 1000 linhas/chunk" }, 400);
      const validas = linhas.filter((l) =>
        CNPJ_RE.test(String(l.cnpj ?? "")) && /^\d{7}$/.test(String(l.cnae_principal ?? "")));
      if (validas.length !== linhas.length) {
        console.warn(`chunk: ${linhas.length - validas.length} linhas inválidas descartadas`);
      }
      if (validas.length === 0) return json({ ok: true, upserted: 0, descartadas: linhas.length });
      // ⚠️ payload SÓ com campos cadastrais + ultimo_lote: o UPDATE do upsert não
      // toca primeira_vista_em / prospeccao_status / ja_cliente (preservação por omissão).
      const payload = validas.map((l) => ({
        cnpj: l.cnpj, razao_social: l.razao_social ?? null, nome_fantasia: l.nome_fantasia ?? null,
        cnae_principal: l.cnae_principal, cnae_descricao: l.cnae_descricao ?? null,
        cnaes_secundarios: l.cnaes_secundarios ?? [], data_abertura: l.data_abertura ?? null,
        porte: l.porte ?? null, capital_social: l.capital_social ?? null,
        logradouro: l.logradouro ?? null, numero: l.numero ?? null, complemento: l.complemento ?? null,
        bairro: l.bairro ?? null, municipio_codigo: l.municipio_codigo ?? null,
        municipio_nome: l.municipio_nome ?? null, uf: l.uf ?? null, cep: l.cep ?? null,
        telefone1: l.telefone1 ?? null, telefone2: l.telefone2 ?? null, email: l.email ?? null,
        socios_nomes: l.socios_nomes ?? null,
        ultimo_lote: mes, updated_at: new Date().toISOString(),
      }));
      const { error } = await admin.from("radar_empresas").upsert(payload, { onConflict: "cnpj" });
      if (error) throw error;
      // Sem contador incremental no chunk: a contagem oficial (total/novos) é
      // recomputada no finalize com count real da tabela — chunk replay-safe.
      return json({ ok: true, upserted: payload.length });
    }

    if (action === "chunk_municipios") {
      const linhas = (body.linhas ?? []) as Record<string, unknown>[];
      if (!Array.isArray(linhas) || linhas.length === 0 || linhas.length > 1000)
        return json({ error: "linhas inválido (1..1000)" }, 400);
      const payload = linhas
        .filter((l) => String(l.codigo ?? "").trim() && String(l.nome ?? "").trim())
        .map((l) => ({ codigo: String(l.codigo), nome: l.nome, uf: l.uf ?? "", lat: l.lat ?? null, lng: l.lng ?? null }));
      const { error } = await admin.from("radar_municipios").upsert(payload, { onConflict: "codigo" });
      if (error) throw error;
      return json({ ok: true, upserted: payload.length });
    }

    if (action === "finalize") {
      if (!MES_RE.test(mes)) return json({ error: "mes inválido" }, 400);
      const { data: st, error: eSt } = await admin.from("radar_ingest_state")
        .select("iniciado_em").eq("mes_referencia", mes).single();
      if (eSt || !st) return json({ error: "lote não iniciado" }, 400);
      const { error: eRe } = await admin.rpc("radar_recruzar_ja_cliente");
      if (eRe) throw eRe;
      const { count: total, error: eT } = await admin.from("radar_empresas")
        .select("cnpj", { count: "exact", head: true }).eq("ultimo_lote", mes);
      if (eT) throw eT;
      const { count: novos, error: eN } = await admin.from("radar_empresas")
        .select("cnpj", { count: "exact", head: true }).gte("primeira_vista_em", st.iniciado_em);
      if (eN) throw eN;
      const { error: eUp } = await admin.from("radar_ingest_state").update({
        status: "complete", total_recebido: total ?? 0, novos: novos ?? 0,
        finalizado_em: new Date().toISOString(),
      }).eq("mes_referencia", mes);
      if (eUp) throw eUp;
      return json({ ok: true, mes, total, novos });
    }

    if (action === "status") {
      const { data, error } = await admin.from("radar_ingest_state")
        .select("*").order("mes_referencia", { ascending: false }).limit(3);
      if (error) throw error;
      return json({ ok: true, lotes: data });
    }

    return json({ error: `ação desconhecida: ${action}`, acoes: ["begin_lote", "chunk", "chunk_municipios", "finalize", "status"] }, 400);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`radar-ingest ${action} falhou:`, msg);
    if (MES_RE.test(mes)) {
      await admin.from("radar_ingest_state").update({ status: "error", erro: msg })
        .eq("mes_referencia", mes).then(() => {}, () => {});
    }
    return json({ error: msg }, 500);
  }
});
