// Edge `credito-fila-recomendar` — recomendação ASSÍNCRONA da IA para a fila de crédito (PR 6a).
// Spec: docs/superpowers/specs/2026-11-20-credito-ia-design.md §5.5 ("a fila mostra 'recomendação
// chegando' até ela existir") e §9.9 (anti-injection: só números, enums e flags).
// Migration: supabase/migrations/20261125230000_credito_fila_enforcement_dormente.sql.
//
// Disparo SÓ por cron/service_role (`x-cron-secret`, pg_cron a cada 10 min): o gate do topo aceita
// staff (para a sonda), mas o disparo pago recusa staff — ninguém precisa disparar à mão (Codex P1).
// Ciclo: reivindica até 5 itens (claim atômico ANTES da chamada paga) → Claude com tool-use
// não forçado → valida saída e coerência → grava pelo único escritor, que descarta claim velho.

import { createClient } from "npm:@supabase/supabase-js@2";
import type Anthropic from "npm:@anthropic-ai/sdk@^0.93.0";
import { criarClienteAnthropic } from "../_shared/anthropic-cliente.ts";
import { extrairToolUseUnico, MODELO_PADRAO, statusDoErro } from "../_shared/anthropic.ts";
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";
import { atenderSondaOptions } from "../_shared/sonda-cron.ts";
import { classificarSonda, EFEITO, erroSondaAmbigua, respostaSonda, VERSAO } from "./versao.ts";
import {
  entradaSoEscalares,
  maxDoCorpo,
  ORCAMENTO_MS,
  SISTEMA,
  TIMEOUT_POR_CHAMADA_MS,
  TOOL,
  validarSaida,
  VERSAO_PROMPT,
} from "./recomendacao.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

interface ItemReivindicado {
  decisao_id: string;
  claim_id: string;
  entrada: unknown;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    const sonda = await atenderSondaOptions(req, respostaSonda, VERSAO);
    if (sonda) return sonda;
    return new Response(null, { headers: corsHeaders });
  }

  // Gate de papel no TOPO (domina sonda e disparo): cron, service_role ou staff. O disparo pago
  // ainda recusa staff logo abaixo — só o cron dispara (Codex desenho P1).
  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  // Corpo lido UMA vez (a sonda e o disparo usam o mesmo). Ilegível → 400, nunca `{}` silencioso.
  let corpo: unknown = {};
  if (req.method === "POST") {
    try {
      corpo = await req.json();
    } catch {
      return json({ ok: false, versao: VERSAO, error: "corpo JSON ilegível" }, 400);
    }
  }
  const decisaoSonda = classificarSonda(corpo);
  if (decisaoSonda.tipo !== "disparo") {
    if (decisaoSonda.tipo === "sonda") return json(respostaSonda(VERSAO), 200);
    return json({ ok: false, versao: VERSAO, error: erroSondaAmbigua(decisaoSonda.valor, EFEITO) }, 400);
  }

  if (auth.via === "staff") return json({ ok: false, versao: VERSAO, error: "disparo só pelo cron" }, 403);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ ok: false, versao: VERSAO, error: "ANTHROPIC_API_KEY ausente" }, 500);
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const { data, error } = await supabase.rpc("credito_fila_reivindicar_recomendacao", { p_max: maxDoCorpo(corpo) });
  if (error) return json({ ok: false, versao: VERSAO, error: `reivindicar: ${error.message}` }, 500);
  const itens = (data ?? []) as ItemReivindicado[];

  // sem retry do SDK: 5 × 25 s cabe no kill da edge; a retentativa é do banco (conta tentativa)
  const anthropic = criarClienteAnthropic(apiKey, { timeoutMs: TIMEOUT_POR_CHAMADA_MS, maxRetries: 0 });
  const inicio = Date.now();
  const placar = { reivindicados: itens.length, ok: 0, erro: 0, descartadas: 0, falha_gravacao: 0, adiados: 0 };
  let semCredito = false;

  for (const item of itens) {
    if (Date.now() - inicio > ORCAMENTO_MS) {
      placar.adiados++;   // claim vence em 5 min e volta (contando tentativa)
      continue;
    }
    let saida: { recomendacao: string; prazo_sugerido_dias: number | null; confianca: number | null; codigos: string[] } | null = null;
    let erro: string | null = null;

    if (semCredito) {
      erro = "anthropic_402_sem_credito";
    } else if (!entradaSoEscalares(item.entrada)) {
      erro = "entrada_com_texto_livre";   // o banco já filtra; isto é a rede
    } else {
      try {
        const resp = await anthropic.messages.create({
          model: MODELO_PADRAO,
          max_tokens: 400,
          system: [{ type: "text", text: SISTEMA, cache_control: { type: "ephemeral" } }],
          tools: [TOOL as unknown as Anthropic.Tool],
          tool_choice: { type: "auto", disable_parallel_tool_use: true },
          messages: [{ role: "user", content: JSON.stringify(item.entrada) }],
        });
        const uso = extrairToolUseUnico(resp.content as { type: string; input?: unknown }[]);
        if (!uso.ok) {
          erro = `sem_tool_use_${uso.motivo}`;
        } else {
          const v = validarSaida(uso.input);
          if (v.ok) saida = v.saida;
          else erro = `saida_invalida_${v.erro}`;
        }
      } catch (e) {
        const st = statusDoErro(e);
        if (st === 402) semCredito = true;
        erro = st ? `anthropic_${st}` : "anthropic_timeout_ou_rede";
      }
    }

    const { data: st, error: errGrava } = await supabase.rpc("credito_registrar_recomendacao", {
      p_decisao_id: item.decisao_id,
      p_claim_id: item.claim_id,
      p_recomendacao: saida?.recomendacao ?? null,
      p_prazo_sugerido_dias: saida?.prazo_sugerido_dias ?? null,
      p_confianca: saida?.confianca ?? null,
      p_codigos: saida?.codigos ?? [],
      p_modelo: MODELO_PADRAO,
      p_versao_prompt: VERSAO_PROMPT,
      p_erro: erro,
    });
    if (errGrava) {
      // o claim vence em 5 min e o item volta a ser reivindicável: nada fica preso
      console.error(`[credito-fila-recomendar] gravar ${item.decisao_id}: ${errGrava.message}`);
      placar.falha_gravacao++;
    } else if (st === "descartada") placar.descartadas++;
    else if (st === "ok") placar.ok++;
    else placar.erro++;
  }

  return json({ ok: true, versao: VERSAO, ...placar, sem_credito: semCredito });
});
