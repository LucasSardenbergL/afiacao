import { createClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";
import { classificarSonda, EFEITO, erroSondaAmbigua, respostaSonda, VERSAO } from "./versao.ts";

// Credencial SIP é POR VENDEDOR (vendor_sip_credentials). Não existe mais o fallback para o ramal
// compartilhado do env (NVOIP_SIP_USER/PASS): ele entregava a senha do ramal master a qualquer
// staff sem ramal próprio — e ao cron, que nem é gente. Sem ramal próprio → 403, nunca o master.
// (Lote 2 do rescan do scanner Lovable Security, 2026-11-14.)
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  // ⚠️ SONDA DE VERSÃO — depois do gate (cron alcança pelo `x-cron-secret`) e ANTES de qualquer
  // leitura de credencial: a resposta da sonda não carrega segredo nenhum.
  const corpoBruto: unknown = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const decisaoSonda = classificarSonda(corpoBruto);
  if (decisaoSonda.tipo === "sonda") return json(respostaSonda(VERSAO), 200);
  if (decisaoSonda.tipo === "ambiguo") {
    return json({ ok: false, versao: VERSAO, error: erroSondaAmbigua(decisaoSonda.valor, EFEITO) }, 400);
  }

  // Ramal é de uma PESSOA: o cron (sem usuário) não tem ramal para receber.
  if (!auth.userId) {
    return json({ error: "Credencial SIP é por vendedor — chamada sem usuário recusada" }, 403);
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: vendorCred, error: lookupErr } = await supabase
      .from("vendor_sip_credentials")
      .select("sip_user, sip_pass, sip_caller_id")
      .eq("user_id", auth.userId)
      .maybeSingle();

    // Falha de leitura NÃO cai em credencial alguma (fail-closed).
    if (lookupErr) {
      console.error("vendor_sip_credentials lookup error:", lookupErr.code ?? lookupErr.message);
      return json({ error: "Falha ao ler o ramal SIP" }, 500);
    }
    if (!vendorCred) {
      return json({ error: "Você ainda não tem ramal SIP próprio — peça ao master para cadastrar" }, 403);
    }

    const wsUri = Deno.env.get("NVOIP_SIP_WSS");
    const sipDomain = Deno.env.get("NVOIP_SIP_DOMAIN");
    if (!wsUri || !sipDomain) {
      return json({ error: "NVOIP_SIP_WSS ou NVOIP_SIP_DOMAIN não configurados" }, 500);
    }
    // Caller-ID único de empresa: lê company_config; cai no valor por vendedor se ausente.
    const { data: cfg } = await supabase
      .from("company_config").select("value").eq("key", "nvoip_outbound_caller_id").maybeSingle();
    const companyCallerId = cfg?.value ?? null;
    return json({
      wsUri,
      sipDomain,
      username: vendorCred.sip_user,
      password: vendorCred.sip_pass,
      callerId: companyCallerId ?? vendorCred.sip_caller_id ?? null,
    });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "Erro interno" }, 500);
  }
});
