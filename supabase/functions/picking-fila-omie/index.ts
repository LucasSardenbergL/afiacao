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
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";
import { atenderSondaOptions } from "../_shared/sonda-cron.ts";
import { clienteCotaDoAmbiente, comVezOmie, metodoCoordenado } from "../_shared/omie-cota.ts";
import { mensagemDeErro } from "../_shared/erro-mensagem.ts";
import { redigirSegredo } from "../_shared/omie-falha.ts";
import { classificarSonda, EFEITO, erroSondaAmbigua, respostaSonda, VERSAO } from "./versao.ts";
import { resumirEtapas, resumirPedidos, resumirProdutos } from "./diagnostico.ts";
import {
  type Acompanhada,
  conferirFiltro,
  paginasDaCauda,
  faultDeFimDePagina,
  janelaDaListagem,
  montarLoteSync,
  type Pagina,
  paginar,
  resumirLeitura,
} from "./coleta.ts";
import { comRegistro, type DbRegistro } from "../_shared/registro-execucao.ts";
import { hojeSP, paraDataOmie, somarDias } from "../_shared/hoje-sp.ts";

const OMIE_TIMEOUT_MS = 25_000;
const TREGUA_MS = 1_500;
/** Corte de admissão (decisão do founder, spec §2.1): pedidos incluídos nos últimos 30 dias. */
const DIAS_DO_CORTE = 30;
/** Teto de páginas por conta numa coleta. 50 por página → 2.000 pedidos no filtro de data. */
const TETO_PAGINAS = 40;
const POR_PAGINA = 50;
const ENTRE_PAGINAS_MS = 700;
/** Prazos do modo escrita, desde o início da invocação. Uma página só COMEÇA até
 *  `PRAZO_INICIO_PAGINA_MS` (o fetch tem 25 s e a trava espera pouco); a sync só é chamada até
 *  `PRAZO_APLICAR_MS` — depois disso a rodada aborta e nada vai ao banco (o lease é 150 s). */
const PRAZO_INICIO_PAGINA_MS = 80_000;
const PRAZO_APLICAR_MS = 115_000;

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
  // Prova do filtro: a CAUDA da etapa 10 sem filtro (as duas últimas páginas na ordem padrão)
  // tem de estar na filtrada. Não usar `ordem_descrescente`: o Omie ordena só dentro da página
  // (medido 2026-10-12 — ver `conferirFiltro`).
  const cauda = typeof totalGeral === "number" ? paginasDaCauda(totalGeral, 100) : [];
  const amostra: unknown[] = [];
  let erroAmostra: string | null = cauda.length === 0 ? "total da etapa 10 indisponível" : null;
  for (const pagina of cauda) {
    if (erroAmostra) break;
    await esperar(TREGUA_MS);
    const r = await paginaDePedidos(conta, cred, { pagina, registros_por_pagina: 100, etapa: "10", apenas_importado_api: "N" });
    if (r.tipo === "corpo") {
      const lista = (r.corpo as Record<string, unknown> | null)?.pedido_venda_produto;
      if (Array.isArray(lista)) amostra.push(...lista);
      else erroAmostra = `página ${pagina} sem pedido_venda_produto`;
    } else erroAmostra = r.tipo === "erro" ? r.erro : `página ${pagina} vazia`;
  }
  const prova = !res.ok
    ? { erro: "sem listagem filtrada para comparar" }
    : erroAmostra
    ? { erro: erroAmostra, paginas_da_cauda: cauda }
    : { ...conferirFiltro(amostra, new Set(res.listagem.presentes), corteIso), paginas_da_cauda: cauda };
  return {
    conta,
    prova_do_filtro: prova,
    etapa_10_total_sem_filtro: totalGeral,
    etapa_10_total_erro: geral.tipo === "erro" ? geral.erro : null,
    filtrada: res.ok ? resumirLeitura(res.listagem, corteIso) : { erro: res.erro, paginas: res.paginas },
    duracao_ms: Date.now() - inicio,
  };
}

type Db = SupabaseClient;

/** Todas as tarefas da conta (paginado, ordem estável): o conjunto ACOMPANHADO. */
async function lerAcompanhadas(db: Db, conta: Conta): Promise<Acompanhada[]> {
  const out: Acompanhada[] = [];
  const PAGINA = 1000;
  for (let de = 0; ; de += PAGINA) {
    const { data, error } = await db
      .from("picking_tarefas")
      .select("omie_codigo_pedido, status, fora_da_etapa_em, incluido_em, ausente_rodadas")
      .eq("account", conta)
      .order("id", { ascending: true })
      .range(de, de + PAGINA - 1);
    if (error) throw new Error(`ler tarefas acompanhadas: ${error.message}`);
    // data nulo sem erro NÃO é fim: um conjunto acompanhado parcial esconderia tarefas da janela.
    if (data == null) throw new Error("ler tarefas acompanhadas: página sem dados e sem erro");
    const linhas = data as Array<Record<string, unknown>>;
    for (const l of linhas) {
      out.push({
        omie_codigo_pedido: String(l.omie_codigo_pedido),
        status: String(l.status),
        fora_da_etapa_em: (l.fora_da_etapa_em as string | null) ?? null,
        incluido_em: (l.incluido_em as string | null) ?? null,
        ausente_rodadas: Number(l.ausente_rodadas),
      });
    }
    if (linhas.length < PAGINA) return out;
  }
}

/**
 * Modo `sincronizar` (Fase 0.5b), UMA conta: reserva exclusiva → acompanhadas → listagem da etapa
 * 10 desde a janela (prazo duro) → UMA chamada a `picking_sincronizar_fila` com o token. Reserva
 * negada = rodada pulada, sem nenhuma chamada ao Omie. Erro de página ou prazo = nada vai ao banco.
 */
async function sincronizarConta(db: Db, conta: Conta, inicio: number): Promise<Record<string, unknown>> {
  const cred = credenciais(conta);
  if (!cred) throw new Error("credenciais ausentes nos secrets");

  const { data: reserva, error: eRes } = await db.rpc("picking_coleta_reservar", { p_account: conta });
  if (eRes) throw new Error(`reservar: ${eRes.message}`);
  const r = reserva as { ok?: boolean; token?: string; motivo?: string };
  if (r?.ok !== true || typeof r.token !== "string") {
    return { conta, pulada: true, motivo: r?.motivo ?? "reserva_sem_resposta" };
  }

  const acompanhadas = await lerAcompanhadas(db, conta);
  const corteIso = somarDias(hojeSP(), -DIAS_DO_CORTE);
  const janela = janelaDaListagem(corteIso, acompanhadas);
  if (janela === null) throw new Error("tarefa aberta sem incluido_em — janela da listagem indeterminada");

  const res = await paginar(
    (pagina) =>
      Date.now() - inicio > PRAZO_INICIO_PAGINA_MS
        ? Promise.resolve<Pagina>({ tipo: "erro", erro: `prazo de ${PRAZO_INICIO_PAGINA_MS / 1000} s da listagem estourado` })
        : paginaDePedidos(conta, cred, {
          pagina,
          registros_por_pagina: POR_PAGINA,
          etapa: "10",
          apenas_importado_api: "N",
          filtrar_apenas_inclusao: "N",
          filtrar_por_data_de: paraDataOmie(janela),
        }),
    { tetoPaginas: TETO_PAGINAS, entrePaginas: () => esperar(ENTRE_PAGINAS_MS) },
  );
  if (!res.ok) throw new Error(`listagem: ${res.erro}`);

  const lote = montarLoteSync(res.listagem, corteIso, new Set(acompanhadas.map((a) => a.omie_codigo_pedido)));
  if (!lote) throw new Error("listagem sem total_de_registros legível");
  // A última página pode ter terminado tarde (fetch e trava): reconfere antes de aplicar.
  const decorrido = Date.now() - inicio;
  if (decorrido > PRAZO_APLICAR_MS) throw new Error(`prazo de ${PRAZO_APLICAR_MS / 1000} s estourado antes de aplicar (${decorrido} ms)`);

  const { data: aplicado, error: eSync } = await db.rpc("picking_sincronizar_fila", {
    p_account: conta,
    p_lease_token: r.token,
    p_presentes: lote.p_presentes,
    p_total_de_registros: lote.p_total_de_registros,
    p_pedidos: lote.p_pedidos,
    p_confirmados_fora: lote.p_confirmados_fora,
    p_listagem_suspeita: lote.p_listagem_suspeita,
  });
  if (eSync) throw new Error(`picking_sincronizar_fila: ${eSync.message}`);
  // Recusa (reserva perdida para outra coleta) é ERRO no registro, não sucesso com motivo no JSON.
  const aplicou = aplicado as { aplicada?: boolean; motivo?: string } | null;
  if (aplicou?.aplicada !== true) throw new Error(`picking_sincronizar_fila não aplicou: ${aplicou?.motivo ?? "sem resposta"}`);
  return {
    conta,
    janela_desde: janela,
    corte_inclusao_desde: corteIso,
    paginas: res.listagem.paginas,
    presentes: lote.p_presentes.length,
    total_de_registros: lote.p_total_de_registros,
    motivos_incompleta: res.listagem.motivos_incompleta,
    detalhados: lote.p_pedidos.length,
    admitidos_pelo_corte: lote.admitidos_pelo_corte,
    acompanhados_presentes: lote.acompanhados_presentes,
    fora_do_corte: lote.fora_do_corte,
    resultado: aplicado,
    duracao_ms: Date.now() - inicio,
  };
}

Deno.serve(async (req) => {
  // A sonda de deploy por cron responde o marcador e SAI antes do gate de auth, do `createClient`
  // e de qualquer chamada ao Omie: esta edge escreve a fila (`sincronizar`), e uma sonda que caísse
  // no fluxo normal faria uma coleta de verdade. Mora DENTRO do bloco OPTIONS porque é a forma que
  // o `gateG1` de `scripts/sonda-cron-prova.ts` mede. Fora da sonda, o preflight segue `"ok"`.
  if (req.method === "OPTIONS") {
    const sonda = await atenderSondaOptions(req, respostaSonda, VERSAO);
    if (sonda) return sonda;
    return new Response("ok", { headers: corsHeaders });
  }
  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

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
  if (modo === "sincronizar") {
    // UMA conta por invocação (prazo de edge; cada conta tem o seu job de cron).
    const conta = (corpoBruto as Record<string, unknown>).conta;
    if (conta !== "oben" && conta !== "colacor") {
      return jsonResponse({ versao: VERSAO, error: "modo 'sincronizar' exige conta 'oben' ou 'colacor'" }, 400);
    }
    const inicio = Date.now();
    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    try {
      const resumo = await comRegistro(
        db as unknown as DbRegistro,
        `picking_fila.sincronizar_${conta}`,
        auth.via === "staff" ? { via: "staff", userId: auth.userId } : { via: "cron" },
        () => sincronizarConta(db, conta, inicio),
        (r) => r,
      );
      return jsonResponse({ versao: VERSAO, modo, ...resumo }, 200);
    } catch (e) {
      return jsonResponse({ versao: VERSAO, modo, conta, error: redigirSegredo(mensagemDeErro(e) ?? "falha sem mensagem") }, 500);
    }
  }
  if (modo !== "diagnostico") {
    return jsonResponse({ versao: VERSAO, error: "modos desta versão: 'diagnostico', 'coleta', 'sincronizar'" }, 400);
  }

  // Sequencial e com trégua entre as contas: são app_keys distintas, mas não há pressa.
  const oben = await diagnosticarConta("oben");
  await esperar(TREGUA_MS);
  const colacor = await diagnosticarConta("colacor");
  return jsonResponse({ versao: VERSAO, modo, contas: [oben, colacor] }, 200);
});
