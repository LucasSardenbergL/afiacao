// picking-fila-omie — fila do picking v2 a partir da etapa 10 do Omie.
// Spec: docs/superpowers/specs/2026-10-10-picking-v2-design.md
//
// Modos: `diagnostico` (Fase 0.1) e `coleta` (Fase 0.5a — mede a coleta da fila, SÓ leitura: lista a
// etapa 10 com o corte de data e devolve números, sem chamar o banco).
//
// v0.1 é SÓ o diagnóstico da Fase 0.1: confirma, nas duas contas, os contratos que o picking vai
// depender (etapas, `ListarPedidos{etapa:'10'}`, EAN no cadastro). Read-only no Omie, sem banco,
// sem cron. Uma chamada por MÉTODO por conta, com trégua entre elas e SEM retentativa: a trava
// anti-redundância do Omie morde o método por app_key, e o `vendas-sync-continuacao` (*/6) chama
// o mesmo `ListarPedidos` — REDUNDANT aqui é reportado, nunca re-tentado.
import { createClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";
import { clienteCotaDoAmbiente, comVezOmie, metodoCoordenado } from "../_shared/omie-cota.ts";
import { mensagemDeErro } from "../_shared/erro-mensagem.ts";
import { redigirSegredo } from "../_shared/omie-falha.ts";
import { classificarSonda, EFEITO, erroSondaAmbigua, respostaSonda, VERSAO } from "./versao.ts";
import { resumirEtapas, resumirPedidos, resumirProdutos } from "./diagnostico.ts";
import { conferirFiltro, faultDeFimDePagina, type Pagina, paginar, resumirLeitura } from "./coleta.ts";
import { hojeSP, paraDataOmie, somarDias } from "../_shared/hoje-sp.ts";

const OMIE_TIMEOUT_MS = 25_000;
const TREGUA_MS = 1_500;
/** Corte de admissão (decisão do founder, spec §2.1): pedidos incluídos nos últimos 30 dias. */
const DIAS_DO_CORTE = 30;
/** Teto de páginas por conta numa coleta. 50 por página → 2.000 pedidos no filtro de data. */
const TETO_PAGINAS = 40;
const POR_PAGINA = 50;
const ENTRE_PAGINAS_MS = 700;

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
 * erro. Método coordenado (`ListarPedidos`) pede a vez na trava; vez negada (ou trava sem resposta —
 * fail-closed) volta como erro, sem chamar.
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
    // Timeout do método coordenado sobe para a trava NÃO devolver a vez: o Omie pode seguir
    // processando o que recebeu (o lease vence sozinho). `chamarOmie` o converte em erro.
    if (e instanceof DOMException && e.name === "TimeoutError" && metodoCoordenado(metodo)) throw e;
    return { ok: false, erro: redigirSegredo(mensagemDeErro(e) ?? "falha de rede sem mensagem") };
  }
}

const esperar = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

/** Uma página de `ListarPedidos` como `Pagina` da coleta ("não existem registros" = fim). */
async function paginaDePedidos(conta: Conta, cred: { key: string; secret: string }, param: Record<string, unknown>): Promise<Pagina> {
  const r = await chamarOmie(conta, cred, "produtos/pedido/", "ListarPedidos", param);
  if (r.ok) return { tipo: "corpo", corpo: r.corpo };
  return faultDeFimDePagina(r.erro) ? { tipo: "fim" } : { tipo: "erro", erro: r.erro };
}

/**
 * Modo `coleta` (só leitura): o total da etapa 10 sem filtro (1 registro, 1 chamada), a listagem
 * filtrada por data que a escrita vai usar, paginada até o fim, e a prova do filtro (os 100 mais
 * recentes sem filtro, 1 chamada) — sem tocar o banco.
 */
async function medirColeta(conta: Conta, corteIso: string): Promise<Record<string, unknown>> {
  const cred = credenciais(conta);
  if (!cred) return { conta, erro: "credenciais ausentes nos secrets" };
  const inicio = Date.now();
  const geral = await paginaDePedidos(conta, cred, {
    pagina: 1,
    registros_por_pagina: 1,
    etapa: "10",
    apenas_importado_api: "N",
  });
  const totalGeral = geral.tipo === "corpo"
    ? (geral.corpo as Record<string, unknown> | null)?.total_de_registros ?? null
    : geral.tipo === "fim" ? 0 : null;
  await esperar(TREGUA_MS);
  const res = await paginar(
    (pagina) =>
      paginaDePedidos(conta, cred, {
        pagina,
        registros_por_pagina: POR_PAGINA,
        etapa: "10",
        apenas_importado_api: "N",
        filtrar_apenas_inclusao: "N",
        filtrar_por_data_de: paraDataOmie(corteIso),
      }),
    { tetoPaginas: TETO_PAGINAS, entrePaginas: () => esperar(ENTRE_PAGINAS_MS) },
  );
  // Prova do filtro: os 100 mais recentes da etapa 10 SEM filtro têm de estar na filtrada.
  await esperar(TREGUA_MS);
  const recentes = await paginaDePedidos(conta, cred, {
    pagina: 1,
    registros_por_pagina: 100,
    etapa: "10",
    apenas_importado_api: "N",
    ordenar_por: "CODIGO",
    ordem_decrescente: "S",
  });
  const prova = !res.ok
    ? { erro: "sem listagem filtrada para comparar" }
    : recentes.tipo === "corpo"
    ? conferirFiltro(
      Array.isArray((recentes.corpo as Record<string, unknown> | null)?.pedido_venda_produto)
        ? (recentes.corpo as Record<string, unknown[]>).pedido_venda_produto
        : [],
      new Set(res.listagem.presentes),
      corteIso,
    )
    : { erro: recentes.tipo === "erro" ? recentes.erro : "etapa 10 vazia" };
  return {
    conta,
    prova_do_filtro: prova,
    etapa_10_total_sem_filtro: totalGeral,
    etapa_10_total_erro: geral.tipo === "erro" ? geral.erro : null,
    filtrada: res.ok ? resumirLeitura(res.listagem, corteIso) : { erro: res.erro, paginas: res.paginas },
    duracao_ms: Date.now() - inicio,
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
  if (modo === "coleta") {
    // Só leitura (Fase 0.5a): mede a coleta sem chamar o banco. Sequencial, com trégua entre contas.
    const corteIso = somarDias(hojeSP(), -DIAS_DO_CORTE);
    const oben = await medirColeta("oben", corteIso);
    await esperar(TREGUA_MS);
    const colacor = await medirColeta("colacor", corteIso);
    return jsonResponse({ versao: VERSAO, modo, corte_inclusao_desde: corteIso, contas: [oben, colacor] }, 200);
  }
  if (modo !== "diagnostico") {
    return jsonResponse({ versao: VERSAO, error: "modos desta versão: 'diagnostico', 'coleta'" }, 400);
  }

  // Sequencial e com trégua entre as contas: são app_keys distintas, mas não há pressa.
  const oben = await diagnosticarConta("oben");
  await esperar(TREGUA_MS);
  const colacor = await diagnosticarConta("colacor");
  return jsonResponse({ versao: VERSAO, modo, contas: [oben, colacor] }, 200);
});
