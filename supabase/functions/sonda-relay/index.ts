// Edge-relé da sonda de deploy por cron (spec v5 §4.3).
//
// POR QUE ELA EXISTE: o `pg_net` (0.19.5 em prod) só emite GET/POST/DELETE — não há `OPTIONS` por
// cron. E `OPTIONS` é a única requisição que TODO bundle histórico interrompe antes de qualquer IO
// (inclusive os que não autenticam nada: `monthly-report@ef08dddd2` manda e-mail para qualquer
// POST). Então o cron fala com este relé por POST autenticado, e o relé emite o `OPTIONS`.
//
// ESTE É O ÚNICO COMPONENTE CUJO BUG SERIA CATASTRÓFICO: se ele mandasse POST à alvo, executaria o
// fluxo real em bundle velho. Três camadas impedem isso, e nenhuma cobre a outra:
//   1. o request nasce em `montarRequestSonda`, que NÃO tem parâmetro de método;
//   2. `barreiraSaida` reconfere o objeto (método, headers, corpo, redirect, origem, path) em
//      RUNTIME, imediatamente antes do fetch;
//   3. o gate `sonda:cron-prova` exige que este arquivo tenha EXATAMENTE um `fetch(`, que ele passe
//      por `montarRequestSonda` + `barreiraSaida`, e que `x-cron-secret` não apareça na saída.
// `redirect: "manual"` é parte da camada 1: com o default, um `303` faria o fetch repetir como GET
// (medido), e GET num bundle velho é o fluxo real.
import { authorizeCron } from "../_shared/auth.ts";
import { classificarSonda, EFEITO, erroSondaAmbigua, respostaSonda, VERSAO } from "./versao.ts";
import {
  atenderSondaOptions,
  barreiraSaida,
  chaveUtilizavel,
  classificarRespostaAlvo,
  derivarCredencial,
  ENV_CHAVE_SONDA,
  lerChaveDoAmbiente,
  montarRequestSonda,
} from "../_shared/sonda-cron.ts";
import { slugsDaAllowlist } from "../_shared/sonda-cron-alvos.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

const ALLOWLIST = slugsDaAllowlist();
const TIMEOUT_MS = 8_000;

function json(corpo: unknown, status: number): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    const sonda = await atenderSondaOptions(req, respostaSonda, VERSAO);
    if (sonda) return sonda;
    return new Response(null, { headers: corsHeaders });
  }

  const auth = authorizeCron(req);
  if (!auth.ok) return auth.response;

  // O corpo é lido UMA vez e reusado (gate de contrato): a segunda leitura devolveria vazio e o
  // `alvo` sumiria em silêncio.
  const corpoBruto = await req.json().catch(() => ({}));

  const decisaoSonda = classificarSonda(corpoBruto);
  if (decisaoSonda.tipo === "sonda") return json(respostaSonda(VERSAO), 200);
  if (decisaoSonda.tipo === "ambiguo") {
    return json({ error: erroSondaAmbigua(decisaoSonda.valor, EFEITO) }, 400);
  }

  const { alvo, tick } = corpoBruto as { alvo?: unknown; tick?: unknown };
  if (typeof alvo !== "string" || !ALLOWLIST.has(alvo)) {
    // Default-deny também aqui, e não só no banco: a allowlist do repo é a fonte única.
    return json({ ok: false, alvo: String(alvo), tick, classe: "fora-da-allowlist" }, 400);
  }

  const chave = lerChaveDoAmbiente();
  if (!chaveUtilizavel(chave)) {
    return json({ ok: false, alvo, tick, classe: "sem-chave", env: ENV_CHAVE_SONDA }, 500);
  }
  const baseUrl = Deno.env.get("SUPABASE_URL");
  if (!baseUrl) return json({ ok: false, alvo, tick, classe: "sem-base-url" }, 500);

  const saida = montarRequestSonda(baseUrl, alvo, await derivarCredencial(chave, alvo));
  const violacao = barreiraSaida(saida, baseUrl, alvo, ALLOWLIST);
  if (violacao) return json({ ok: false, alvo, tick, classe: "barreira", motivo: violacao }, 500);

  let resposta: Response;
  try {
    resposta = await fetch(saida, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    const timeout = e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");
    return json({ ok: false, alvo, tick, classe: timeout ? "timeout" : "erro-http" }, 200);
  }

  const texto = await resposta.text().catch(() => "");
  const r = classificarRespostaAlvo(alvo, resposta.status, resposta.headers.get("content-type"), texto);
  if (r.classe === "atestou") {
    // Verbatim: é o corpo da ALVO que precisa chegar a `net._http_response` para o coletor do
    // ledger reconhecê-lo. Reembrulhar mudaria a forma que a janela viva exige.
    return new Response(r.corpo, {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  return json({ ok: false, alvo, tick, classe: r.classe, status: resposta.status }, 200);
});
