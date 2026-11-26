// Edge Function: omie-os-sync  [money-path · crédito-IA PR 7, opção C, fatia 1]
//
// Espelha as OS que a Colacor SC cria DIRETO no Omie (`servicos/os/ListarOS`) em `omie_os_espelho`, para a sombra
// de crédito das OS (fatia 2) medir a OS aberta ainda não faturada. Só `colacor_sc`. Nunca escreve no Omie.
//   1. gate `authorizeCronOrStaff`; a sonda de versão responde ANTES de qualquer leitura;
//   2. `probe` (action ausente) e `sync` só para cron/service_role (Codex P0) — staff recebe 403 sem tocar o Omie;
//   3. `sync`: abre um run (RPC, lock por empresa), pagina até a página vazia gravando em STAGING, e fecha. Só um run
//      ÍNTEGRO (varredura.ts) promove a geração ao espelho e conta para o sumiço (2 varreduras íntegras). Nunca DELETE.
// Doc: docs/historico/credito-os-omie-2026-11.md · prova: db/test-omie-os-sync.sh · parser: os-parse.ts.
import { createClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";
import { mensagemDeErro } from "../_shared/erro-mensagem.ts";
import { chamarOmie, fimDePaginacao } from "../_shared/omie-cliente.ts";
import { extrairLista, parseOS, totalDeclarado } from "./os-parse.ts";
import { type Listar, REG_POR_PAGINA, type Resumo, VarreduraAbortada, varrer } from "./varredura.ts";
import { classificarSonda, EFEITO, erroSondaAmbigua, respostaSonda, VERSAO } from "./versao.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OMIE_OS_URL = "https://app.omie.com.br/api/v1/servicos/os/";
const COMPANY = "colacor_sc";
const ORCAMENTO_MS = 110_000; // o cron dá 150 s; sobra para fechar o run

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function credenciais(): { appKey: string; appSecret: string } {
  const appKey = Deno.env.get("OMIE_COLACOR_SC_APP_KEY");
  const appSecret = Deno.env.get("OMIE_COLACOR_SC_APP_SECRET");
  if (!appKey || !appSecret) throw new Error("OMIE_COLACOR_SC_APP_KEY/SECRET ausentes no ambiente");
  return { appKey, appSecret };
}

/** Uma página do ListarOS. `null` = fim-de-paginação do Omie (quem decide se é fim legítimo é a varredura). */
function listarOS(registrosPorPagina: number, deadline: number): Listar {
  const cred = credenciais();
  return async (pagina) => {
    const res = await chamarOmie(
      { url: OMIE_OS_URL, metodo: "ListarOS",
        param: { pagina, registros_por_pagina: registrosPorPagina, apenas_importado_api: "N" }, credenciais: cred },
      { conta: COMPANY, maxTentativas: 3, deadline },
    );
    if (fimDePaginacao(res)) return null;
    if (res.faultstring) throw new Error(`Omie ListarOS p.${pagina}: ${res.faultstring.slice(0, 300)}`);
    if (!res.ok) throw new Error(`Omie ListarOS p.${pagina} HTTP ${res.status}: ${res.texto.slice(0, 300)}`);
    if (res.corpo === null) throw new Error(`Omie ListarOS p.${pagina}: resposta não-JSON após retentativas`);
    return res.corpo;
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown> = {};
  try {
    const texto = await req.text();
    const b = texto.trim() ? JSON.parse(texto) : {};
    body = b && typeof b === "object" && !Array.isArray(b) ? b as Record<string, unknown> : {};
  } catch {
    return json({ ok: false, mensagem: "Body JSON inválido" }, 400);
  }

  // ⚠️ SONDA DE VERSÃO — depois do gate de credencial, antes de qualquer leitura/escrita ou do Omie.
  // Colisão de nomes: o campo `probe` do corpo é a sonda de VERSÃO; o `action:"probe"` abaixo inspeciona o Omie.
  const decisaoSonda = classificarSonda(body);
  if (decisaoSonda.tipo === "sonda") return json(respostaSonda(VERSAO));
  if (decisaoSonda.tipo === "ambiguo") return json({ ok: false, versao: VERSAO, error: erroSondaAmbigua(decisaoSonda.valor, EFEITO) }, 400);

  // Codex P0 (2026-11-26): tudo daqui em diante lê OS REAL da SC → só cron/service_role, nunca staff.
  if (auth.via !== "cron" && auth.via !== "service_role") {
    return json({ ok: false, versao: VERSAO, error: "omie-os-sync: probe e sync só pelo cron/service_role" }, 403);
  }

  const action = body.action === undefined ? "probe" : body.action;
  try {
    if (action === "probe") {
      const resp = await listarOS(2, Date.now() + 30_000)(1);
      if (resp === null) return json({ ok: true, versao: VERSAO, aviso: "Omie sinalizou fim já na página 1 (nenhuma OS?)" });
      const lista = extrairLista(resp);
      const primeiro = (lista?.[0] ?? null) as Record<string, unknown> | null;
      const chaves = (v: unknown) => v && typeof v === "object" ? Object.keys(v as Record<string, unknown>) : null;
      const parcelas = primeiro?.Parcelas;
      return json({
        ok: true, versao: VERSAO,
        topKeys: Object.keys(resp),
        total_de_paginas: totalDeclarado(resp, "total_de_paginas") ?? null,
        total_de_registros: totalDeclarado(resp, "total_de_registros") ?? null,
        listaDetectada: lista ? lista.length : null,
        itemKeys: chaves(primeiro),
        cabecalhoKeys: chaves(primeiro?.Cabecalho),
        infoCadastroKeys: chaves(primeiro?.InfoCadastro),
        parcelaKeys: chaves(Array.isArray(parcelas) ? parcelas[0] : parcelas),
        // o parser sobre o 1º item, SEM o payload (as chaves acima bastam para travar a forma)
        parse: primeiro ? (() => {
          const p = parseOS(primeiro);
          if (!p.ok) return p;
          const { payload: _payload, parcelas: _parcelas, ...resto } = p.linha;
          return { ok: true, linha: resto };
        })() : null,
      });
    }
    if (action !== "sync") return json({ ok: false, versao: VERSAO, error: `action desconhecida: ${String(action)}` }, 400);
  } catch (e) {
    return json({ ok: false, versao: VERSAO, mensagem: (mensagemDeErro(e) ?? "erro").slice(0, 600) }, 500);
  }

  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: runId, error: abrirErr } = await db.rpc("omie_os_sync_abrir", { p_company: COMPANY });
  if (abrirErr || typeof runId !== "number") {
    return json({ ok: false, versao: VERSAO, mensagem: `omie_os_sync_abrir: ${abrirErr?.message ?? "sem run"}` }, 409);
  }
  const deadline = Date.now() + ORCAMENTO_MS;
  let resumo: Partial<Resumo> & { integra: boolean } = { integra: false };
  let erro: string | null = null;
  try {
    resumo = await varrer(listarOS(REG_POR_PAGINA, deadline), async (linhas) => {
      const { error } = await db.rpc("omie_os_sync_gravar", { p_run: runId, p_linhas: linhas });
      if (error) throw new Error(`omie_os_sync_gravar: ${error.message}`);
    }, { deadline });
  } catch (e) {
    erro = (mensagemDeErro(e) ?? "erro").slice(0, 600);
    resumo = e instanceof VarreduraAbortada ? { ...e.parcial, integra: false } : { integra: false };
  }
  const { data: fechado, error: fecharErr } = await db.rpc("omie_os_sync_fechar", {
    p_run: runId, p_resumo: resumo, p_erro: erro,
  });
  if (fecharErr) {
    return json({ ok: false, versao: VERSAO, run: runId, mensagem: `omie_os_sync_fechar: ${fecharErr.message}`, erro }, 500);
  }
  return json({ ok: erro === null, versao: VERSAO, run: runId, resumo, fechado, erro }, erro === null ? 200 : 500);
});
