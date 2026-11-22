// omie-cliente-trocar-vendedor — troca, em lote, o vendedor do CADASTRO do cliente no Omie (AlterarCliente).
//
// Por quê: a carteira é derivada do vendedor do cadastro no Omie. Quando uma vendedora sai, remapear os códigos dela
// no app (omie_vendedor_map) resolve a tela, mas deixa o ERP errado. Esta edge corrige a FONTE.
// É a ÚNICA via do app que regrava cadastro de cliente no Omie, e regrava só `recomendacoes.codigo_vendedor`
// (ver `_shared/razao-fiscal.ts`: nada fiscal é reenviado).
//
// Contrato (POST JSON):
//   { modo: "dry_run" | "aplicar" | "verificar", lote: "saida_vendedora" | "orfaos" | "reparo_entidades", conta: "oben"|"colacor"|"colacor_sc",
//     limite?: 1..30 (15), apos?: codigo_cliente_omie (paginação), clientes?: [códigos] (canário, ≤10),
//     escolhas?: [{customer_user_id, dono: "REGINA"|"LUCAS"}] (lote orfaos), execucao_id?: uuid (verificar),
//     confirmo?: "TROCAR VENDEDOR NO OMIE" (obrigatório no aplicar) }
// Origem e alvo são CONSTANTES de `decisao.ts`, nunca do body.
//
// Gate: `authorizeCronOrStaff` (para a sonda), e a AÇÃO só para master, service_role ou cron-secret — employee 403.
// Não há cron agendado para esta edge, de propósito: o lote é disparado à mão, bloco a bloco.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";
import { atenderSondaOptions } from "../_shared/sonda-cron.ts";
import { chamarOmie } from "../_shared/omie-cliente.ts";
import { ehEscritaIndeterminada } from "../_shared/omie-chamada-relogio.ts";
import { redigirSegredo } from "../_shared/omie-falha.ts";
import { mensagemDeErro } from "../_shared/erro-mensagem.ts";
import { type Conta, lerParametros, ORIGEM_SAIDA, type Parametros, REPARO_ENTIDADES, VENDEDOR } from "./decisao.ts";
import { type Candidato, type Dependencias, processarBloco, type Recibo, type RespostaOmieSimples } from "./processar.ts";
import { classificarSonda, EFEITO, erroSondaAmbigua, respostaSonda, VERSAO } from "./versao.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const URL_CLIENTES = "https://app.omie.com.br/api/v1/geral/clientes/";
const URL_VENDEDORES = "https://app.omie.com.br/api/v1/geral/vendedores/";
const TABELA = "omie_cliente_vendedor_troca";
const CORPO_ILEGIVEL = Symbol("corpo-ilegivel");
/** Intervalo mínimo entre chamadas Omie da mesma conta (o limite do Omie é por app_key). */
const INTERVALO_OMIE_MS = 300;
/** Prazo de UMA chamada lógica ao Omie (com retentativas): curto, para o orçamento do bloco valer (Codex P1). */
const PRAZO_CHAMADA_OMIE_MS = 15_000;

const ENV_CONTA: Record<Conta, string> = { oben: "OBEN", colacor: "COLACOR", colacor_sc: "COLACOR_SC" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function credenciais(conta: Conta): { appKey: string; appSecret: string } | null {
  const appKey = Deno.env.get(`OMIE_${ENV_CONTA[conta]}_APP_KEY`);
  const appSecret = Deno.env.get(`OMIE_${ENV_CONTA[conta]}_APP_SECRET`);
  return appKey && appSecret ? { appKey, appSecret } : null;
}

function montarDependencias(db: SupabaseClient, p: Parametros, cred: { appKey: string; appSecret: string }): Dependencias {
  let ultimaChamada = 0;
  const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  async function omie(url: string, metodo: string, param: unknown): Promise<RespostaOmieSimples> {
    const falta = ultimaChamada + INTERVALO_OMIE_MS - Date.now();
    if (falta > 0) await dormir(falta);
    ultimaChamada = Date.now();
    // AlterarCliente: UMA tentativa — repetir reenviaria o `recomendacoes` lido antes por cima de uma edição feita na
    // espera (Codex r2 P1). Quem decide o desfecho é a releitura, sempre feita depois.
    const escrita = metodo === "AlterarCliente";
    let r;
    try {
      r = await chamarOmie({ url, metodo, param, credenciais: cred }, {
        conta: p.conta, maxTentativas: escrita ? 1 : 3, deadline: Date.now() + PRAZO_CHAMADA_OMIE_MS,
      });
    } catch (e) {
      // Leitura que estoura vira fault (o bloco segue e devolve o execucao_id); escrita indeterminada sobe.
      if (ehEscritaIndeterminada(e)) throw e;
      return { corpo: null, fault: redigirSegredo(mensagemDeErro(e) ?? "falha de transporte") };
    }
    const fault = r.faultstring ? redigirSegredo(r.faultstring) : (!r.ok ? `HTTP ${r.status}` : (r.corpo ? null : "resposta ilegível"));
    return { corpo: r.corpo, fault };
  }

  return {
    consultarCliente: (codigo) => omie(URL_CLIENTES, "ConsultarCliente", { codigo_cliente_omie: codigo }),
    relerCliente: (codigo) =>
      omie(URL_CLIENTES, "ListarClientes", { pagina: 1, registros_por_pagina: 5, clientesFiltro: { codigo_cliente_omie: codigo } }),
    alterarCliente: (payload) => omie(URL_CLIENTES, "AlterarCliente", payload),
    async listarVendedores() {
      const r = await omie(URL_VENDEDORES, "ListarVendedores", { pagina: 1, registros_por_pagina: 500 });
      if (r.fault || !r.corpo) return { erro: r.fault ?? "sem corpo" };
      // Página única de 500: a conta tem dezenas de vendedores. Mais de uma página = conferência incompleta → recusa.
      // Total AUSENTE também recusa (não se presume 1): conferência incompleta não autoriza escrita.
      if (r.corpo.total_de_paginas !== 1) return { erro: `ListarVendedores: total_de_paginas ${String(r.corpo.total_de_paginas)} (esperado 1)` };
      const cad = r.corpo.cadastro;
      return Array.isArray(cad) ? { vendedores: cad as { codigo?: unknown; nome?: unknown; inativo?: unknown }[] } : { erro: "sem cadastro" };
    },
    ehIndeterminada: ehEscritaIndeterminada,
    async candidatos(pp): Promise<Candidato[]> {
      // saida_vendedora: espelho BRUTO — o filtro é o código de vendedor e a verdade é relida no Omie, cliente a cliente.
      // orfaos: espelho FRESCO — a escolha do founder é por CLIENTE (user_id), e um vínculo vencido mandaria o vendedor
      // escolhido para A ao código que hoje é de B (Codex P1).
      let q = db.from(pp.lote === "orfaos" ? "omie_customer_account_map_fresco" : "omie_customer_account_map")
        .select("omie_codigo_cliente, user_id, omie_codigo_vendedor")
        .eq("account", pp.conta)
        .gt("omie_codigo_cliente", pp.apos)
        .order("omie_codigo_cliente", { ascending: true })
        .limit(pp.limite);
      if (pp.clientes) q = q.in("omie_codigo_cliente", pp.clientes);
      const donoPorUser = new Map<string, "REGINA" | "LUCAS">();
      if (pp.lote === "saida_vendedora") {
        q = q.in("omie_codigo_vendedor", [...ORIGEM_SAIDA[pp.conta]]);
      } else if (pp.lote === "reparo_entidades") {
        // Lista FECHADA no código (v1.6); o vendedor é conferido no Omie pelo decidir(), não pelo espelho.
        q = q.in("omie_codigo_cliente", [...REPARO_ENTIDADES[pp.conta]]);
      } else {
        for (const e of pp.escolhas ?? []) donoPorUser.set(e.customer_user_id, e.dono);
        q = q.in("user_id", [...donoPorUser.keys()]);
      }
      const { data, error } = await q;
      if (error) throw new Error(`candidatos: ${error.message}`);
      return (data ?? []).map((r: { omie_codigo_cliente: number; user_id: string | null }) => ({
        omie_codigo_cliente: Number(r.omie_codigo_cliente),
        customer_user_id: r.user_id,
        dono: pp.lote !== "orfaos" ? "REGINA" : donoPorUser.get(String(r.user_id).toLowerCase())!,
      }));
    },
    async registrar(r: Recibo) {
      const { data, error } = await db.from(TABELA).insert(r).select("id").single();
      if (error || !data) throw new Error(`recibo não gravou: ${error?.message ?? "sem id"}`);
      return Number((data as { id: number }).id);
    },
    async atualizar(id, patch) {
      const { error } = await db.from(TABELA).update({ ...patch, atualizado_em: new Date().toISOString() }).eq("id", id);
      if (error) throw new Error(`recibo ${id} não atualizou: ${error.message}`);
    },
    async atualizarEspelho(conta, codigo, userId, alvo) {
      // UPDATE estreito, de propósito, e não `register_carteira_member`: a RPC zera `evidence_document_normalized`
      // (a prova do vínculo conferido) e reclassifica `source`. Aqui só o vendedor muda — nem `updated_at`, que é o
      // TTL da view fresca: renovar recolocaria na carteira um vínculo vencido sem conferir o documento (Codex P1).
      let q = db.from("omie_customer_account_map")
        .update({ omie_codigo_vendedor: alvo })
        .eq("account", conta).eq("omie_codigo_cliente", codigo);
      if (userId) q = q.eq("user_id", userId);
      const { data, error } = await q.select("id");
      if (error) { console.warn(`[trocar-vendedor] espelho ${conta}/${codigo} não atualizou: ${error.message}`); return false; }
      return (data ?? []).length === 1;
    },
    async confirmarVinculo(conta, codigo, userId) {
      const { data, error } = await db.from("omie_customer_account_map_fresco")
        .select("user_id").eq("account", conta).eq("omie_codigo_cliente", codigo);
      if (error) throw new Error(`vínculo ${conta}/${codigo}: ${error.message}`);
      return (data ?? []).length === 1 && String((data as { user_id: string }[])[0].user_id).toLowerCase() === userId.toLowerCase();
    },
    async pendentesVerificacao(execucaoId, conta) {
      const { data, error } = await db.from(TABELA)
        .select("id, omie_codigo_cliente, customer_user_id, status, vendedor_antes, vendedor_alvo, hash_antes, criado_em")
        .eq("execucao_id", execucaoId).eq("account", conta).in("status", ["alterado", "indeterminado"])
        .order("atualizado_em", { ascending: true }).order("id", { ascending: true })
        .limit(1000);
      if (error) throw new Error(`pendentes: ${error.message}`);
      const linhas = data ?? [];
      if (linhas.length >= 1000) throw new Error("pendentes: 1000+ recibos numa execução — acima do bloco máximo, algo está errado");
      return linhas.map((r: Record<string, unknown>) => ({
        id: Number(r.id), omie_codigo_cliente: Number(r.omie_codigo_cliente),
        customer_user_id: (r.customer_user_id as string | null) ?? null,
        status: r.status as "alterado" | "indeterminado",
        vendedor_antes: r.vendedor_antes === null ? null : Number(r.vendedor_antes),
        vendedor_alvo: Number(r.vendedor_alvo), hash_antes: (r.hash_antes as string | null) ?? null,
        criado_em_ms: Date.parse(String(r.criado_em)),
      }));
    },
    agora: () => Date.now(),
    dormir,
    novoId: () => crypto.randomUUID(),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    const sonda = await atenderSondaOptions(req, respostaSonda, VERSAO);
    if (sonda) return sonda;
    return new Response("ok", { headers: corsHeaders });
  }

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  try {
    const corpo: unknown = req.method === "POST" ? await req.json().catch(() => CORPO_ILEGIVEL) : {};
    if (corpo === CORPO_ILEGIVEL) return json({ versao: VERSAO, error: "o corpo não é JSON válido" }, 400);

    const decisaoSonda = classificarSonda(corpo);
    if (decisaoSonda.tipo === "sonda") return json(respostaSonda(VERSAO));
    if (decisaoSonda.tipo === "ambiguo") return json({ error: erroSondaAmbigua(decisaoSonda.valor, EFEITO) }, 400);

    // A ação: master, service_role ou cron-secret. Employee passa no gate da sonda, não aqui.
    let executadoPor: string;
    if (auth.via === "staff") {
      const db0 = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
      const { data: papeis, error } = await db0.from("user_roles").select("role").eq("user_id", auth.userId!);
      if (error) return json({ versao: VERSAO, error: "papel não conferido" }, 503);
      // O papel é conferido no CÓDIGO (não só no filtro da query): employee tem linha em user_roles, e "achou linha" ≠ master.
      if (!(papeis ?? []).some((x: { role: string }) => x.role === "master")) return json({ versao: VERSAO, error: "só o master troca vendedor no Omie" }, 403);
      executadoPor = `master:${auth.userId}`;
    } else {
      // cron-secret/service_role não identificam pessoa: o body tem de dizer quem disparou (Codex P2: autoria no recibo).
      const autor = (corpo as Record<string, unknown>)?.autor;
      if (typeof autor !== "string" || autor.trim().length < 2 || autor.length > 80) {
        return json({ versao: VERSAO, error: "via cron/service_role, informe autor (quem disparou)" }, 400);
      }
      executadoPor = `${auth.via}:${autor.trim()}`;
    }

    const leitura = lerParametros(corpo);
    if (!leitura.ok) return json({ versao: VERSAO, error: leitura.erro }, 400);
    const p = leitura.p;
    const cred = credenciais(p.conta);
    if (!cred) return json({ versao: VERSAO, error: `credenciais Omie da conta ${p.conta} ausentes` }, 503);

    const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const resultado = await processarBloco(p, montarDependencias(db, p, cred), {
      executadoPor,
      orcamentoEscritaMs: 50_000,
      orcamentoTotalMs: 115_000,
    });
    return json({ versao: VERSAO, alvo: p.lote === "saida_vendedora" ? VENDEDOR.REGINA[p.conta] : null, ...resultado });
  } catch (e) {
    const msg = redigirSegredo(mensagemDeErro(e) ?? "erro");
    console.error(`[trocar-vendedor] ${msg}`);
    return json({ versao: VERSAO, error: msg }, 500);
  }
});
