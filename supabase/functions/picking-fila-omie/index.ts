// picking-fila-omie — fila do picking v2 a partir da etapa 10 do Omie.
// Spec: docs/superpowers/specs/2026-10-10-picking-v2-design.md
//
// v0.1 é SÓ o diagnóstico da Fase 0.1: confirma, nas duas contas, os contratos que o picking vai
// depender (etapas, `ListarPedidos{etapa:'10'}`, EAN no cadastro). Read-only no Omie, sem banco,
// sem cron. Uma chamada por MÉTODO por conta, com trégua entre elas e SEM retentativa: a trava
// anti-redundância do Omie morde o método por app_key, e o `vendas-sync-continuacao` (*/6) chama
// o mesmo `ListarPedidos` — REDUNDANT aqui é reportado, nunca re-tentado.
import { createClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";
import { clienteCotaDoAmbiente, comVezOmie } from "../_shared/omie-cota.ts";
import { mensagemDeErro } from "../_shared/erro-mensagem.ts";
import { redigirSegredo } from "../_shared/omie-falha.ts";
import { classificarSonda, EFEITO, erroSondaAmbigua, respostaSonda, VERSAO } from "./versao.ts";
import { resumirEtapas, resumirPedidos, resumirProdutos } from "./diagnostico.ts";

const OMIE_TIMEOUT_MS = 25_000;
const TREGUA_MS = 1_500;

type Conta = "oben" | "colacor";

// Trava compartilhada do Omie (Fase 0.2): `ListarPedidos` pede a vez às outras edges antes de chamar.
const clienteCota = clienteCotaDoAmbiente((url, chave) => createClient(url, chave));

function credenciais(conta: Conta): { key: string; secret: string } | null {
  const prefixo = conta === "oben" ? "OMIE_OBEN" : "OMIE_COLACOR";
  const key = Deno.env.get(`${prefixo}_APP_KEY`);
  const secret = Deno.env.get(`${prefixo}_APP_SECRET`);
  return key && secret ? { key, secret } : null;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

type Chamada = { ok: true; corpo: unknown } | { ok: false; erro: string };

/**
 * UMA chamada, sem retentativa. Falha do Omie no corpo (faultstring) com qualquer HTTP volta como
 * erro. Método coordenado (`ListarPedidos`) pede a vez na trava; vez negada volta como erro, sem chamar.
 */
async function chamarOmie(
  conta: Conta,
  cred: { key: string; secret: string },
  endpoint: string,
  metodo: string,
  param: Record<string, unknown>,
): Promise<Chamada> {
  try {
    return await comVezOmie(clienteCota(), conta, metodo, () => chamarOmieSemTrava(cred, endpoint, metodo, param), (r) =>
      r.ok ? null : r.erro
    );
  } catch (e) {
    return { ok: false, erro: redigirSegredo(mensagemDeErro(e) ?? "trava do Omie sem mensagem") };
  }
}

async function chamarOmieSemTrava(
  cred: { key: string; secret: string },
  endpoint: string,
  metodo: string,
  param: Record<string, unknown>,
): Promise<Chamada> {
  try {
    const res = await fetch(`https://app.omie.com.br/api/v1/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ call: metodo, app_key: cred.key, app_secret: cred.secret, param: [param] }),
      signal: AbortSignal.timeout(OMIE_TIMEOUT_MS),
    });
    const txt = await res.text();
    let corpo: unknown = null;
    try {
      corpo = JSON.parse(txt);
    } catch {
      return { ok: false, erro: `HTTP ${res.status}, corpo não-JSON: ${redigirSegredo(txt.slice(0, 200))}` };
    }
    const fault = corpo !== null && typeof corpo === "object" ? (corpo as Record<string, unknown>).faultstring : undefined;
    if (typeof fault === "string" && fault !== "") return { ok: false, erro: redigirSegredo(fault.slice(0, 300)) };
    if (!res.ok) return { ok: false, erro: `HTTP ${res.status}: ${redigirSegredo(txt.slice(0, 200))}` };
    return { ok: true, corpo };
  } catch (e) {
    return { ok: false, erro: redigirSegredo(mensagemDeErro(e) ?? "falha de rede sem mensagem") };
  }
}

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function diagnosticarConta(conta: Conta): Promise<Record<string, unknown>> {
  const cred = credenciais(conta);
  if (!cred) return { conta, erro: "credenciais ausentes nos secrets" };

  const etapas = await chamarOmie(conta, cred, "produtos/etapafat/", "ListarEtapasFaturamento", {
    pagina: 1,
    registros_por_pagina: 50,
  });
  await esperar(TREGUA_MS);
  const pedidos = await chamarOmie(conta, cred, "produtos/pedido/", "ListarPedidos", {
    pagina: 1,
    registros_por_pagina: 50,
    etapa: "10",
    apenas_importado_api: "N",
  });
  await esperar(TREGUA_MS);
  const produtos = await chamarOmie(conta, cred, "geral/produtos/", "ListarProdutos", {
    pagina: 1,
    registros_por_pagina: 50,
    apenas_importado_api: "N",
    filtrar_apenas_omiepdv: "N",
  });

  return {
    conta,
    etapas: etapas.ok ? resumirEtapas(etapas.corpo) : { erro: etapas.erro },
    pedidos_etapa_10: pedidos.ok ? resumirPedidos(pedidos.corpo) : { erro: pedidos.erro },
    produtos_amostra: produtos.ok ? resumirProdutos(produtos.corpo) : { erro: produtos.erro },
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  {
    const __auth = await authorizeCronOrStaff(req);
    if (!__auth.ok) return __auth.response;
  }

  const corpoBruto: unknown = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const decisaoSonda = classificarSonda(corpoBruto);
  if (decisaoSonda.tipo === "sonda") return jsonResponse(respostaSonda(VERSAO), 200);
  if (decisaoSonda.tipo === "ambiguo") {
    return jsonResponse({ versao: VERSAO, error: erroSondaAmbigua(decisaoSonda.valor, EFEITO) }, 400);
  }

  const modo = corpoBruto !== null && typeof corpoBruto === "object" ? (corpoBruto as Record<string, unknown>).modo : undefined;
  if (modo !== "diagnostico") {
    return jsonResponse({ versao: VERSAO, error: "só o modo 'diagnostico' existe nesta versão" }, 400);
  }

  // Sequencial e com trégua entre as contas: são app_keys distintas, mas não há pressa.
  const oben = await diagnosticarConta("oben");
  await esperar(TREGUA_MS);
  const colacor = await diagnosticarConta("colacor");
  return jsonResponse({ versao: VERSAO, modo, contas: [oben, colacor] }, 200);
});
