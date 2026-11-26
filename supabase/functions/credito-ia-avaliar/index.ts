// credito-ia-avaliar — crédito-IA PR 4: propõe o limite do GRUPO e o prazo máximo.
//
// Por invocação (cron a cada 15 min, ou "Avaliar agora" de staff):
//   1. reivindica até 12 raízes elegíveis (credito_reivindicar_raizes, ANTES de pagar o Claude:
//      dois workers nunca pagam a mesma raiz);
//   2. por raiz (concorrência 3): ficha SQL → entrada por LISTA FECHADA → Claude (tool-use,
//      não-forçado, 1 chamada exigida) → validação da saída → travas determinísticas;
//   3. grava pelo WRITER ÚNICO credito_registrar_avaliacao (confere o token e reconfere as travas
//      no banco). Falha ⇒ o mesmo writer persiste o backoff da raiz.
// A IA PROPÕE; nada fica vigente sem a aprovação do Lucas (credito_aprovar_proposta[_lote]).
// Lógica pura e testes: politica.ts / politica_test.ts.
import { createClient } from "npm:@supabase/supabase-js@2";
import { criarClienteAnthropic } from "../_shared/anthropic-cliente.ts";
import { extrairToolUseUnico, MODELO_PADRAO, TIMEOUT_ANTHROPIC_MS } from "../_shared/anthropic.ts";
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";
import { mensagemDeErro } from "../_shared/erro-mensagem.ts";
import { exigirLeitura } from "../_shared/leitura-critica.ts";
import { comRegistro, type DbRegistro } from "../_shared/registro-execucao.ts";
import {
  aplicarTravas, montarEntradaIA, NOME_TOOL, ORCAMENTO, restanteParaChamada, SYSTEM_POLITICA,
  TOOL_PROPOR, validarSaidaIA, VERSAO_POLITICA, type Ficha,
} from "./politica.ts";
import { classificarSonda, EFEITO, erroSondaAmbigua, respostaSonda, VERSAO } from "./versao.ts";

const ACAO_REGISTRO = "credito.avaliar_limites";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

type Db = ReturnType<typeof createClient>;
type Desfecho = "proposta" | "falha" | "adiada";

async function registrarFalha(db: Db, token: string, raiz: string, erro: string): Promise<void> {
  const { error } = await db.rpc("credito_registrar_avaliacao", {
    p_token: token, p_raiz: raiz, p_proposta: null, p_erro: erro.slice(0, 500),
  });
  // sem gravar o backoff, a reivindicação expira sozinha (TTL) — a raiz volta, nada vira proposta
  if (error) console.warn(`[credito-ia-avaliar] backoff não gravou (${raiz}):`, error.message);
}

async function avaliarRaiz(db: Db, apiKey: string, token: string, raiz: string, inicio: number): Promise<Desfecho> {
  const resta = restanteParaChamada(inicio, Date.now());
  if (resta === 0) return "adiada"; // sem tempo: não grava nada; a reivindicação expira e a raiz volta
  try {
    const ficha = exigirLeitura(await db.rpc("credito_ficha", { p_raiz: raiz }), "credito_ficha") as Ficha | null;
    if (!ficha || typeof ficha !== "object") throw new Error("ficha vazia");

    const entrada = montarEntradaIA(ficha);
    if (!entrada.ok) throw new Error(entrada.erro);

    const cliente = criarClienteAnthropic(apiKey, { timeoutMs: Math.min(resta, TIMEOUT_ANTHROPIC_MS), maxRetries: 0 });
    const resp = await cliente.messages.create({
      model: MODELO_PADRAO,
      // 4096: com tool_choice auto o modelo pode raciocinar em texto antes da tool — 1024 truncou 1 grupo em 59 (2026-11-26)
      max_tokens: 4096,
      temperature: 0,
      system: [{ type: "text", text: SYSTEM_POLITICA, cache_control: { type: "ephemeral" } }],
      tools: [{ ...TOOL_PROPOR, cache_control: { type: "ephemeral" } }],
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      messages: [{
        role: "user",
        content: `Ficha do grupo (JSON, só números e códigos):\n${JSON.stringify(entrada.entrada)}\n\nChame propor_limite uma vez.`,
      }],
    }, { signal: AbortSignal.timeout(resta) });

    // money-path: só a parada por tool_use é resposta completa (max_tokens/refusal/end_turn ⇒ erro)
    if (resp.stop_reason !== "tool_use") throw new Error(`stop_reason=${resp.stop_reason}`);
    const blocos = resp.content as ReadonlyArray<{ type: string; input?: unknown; name?: string }>;
    const uso = extrairToolUseUnico(blocos);
    if (!uso.ok) throw new Error(`tool_use ${uso.motivo} (${uso.quantidade})`);
    if (blocos.find((b) => b.type === "tool_use")?.name !== NOME_TOOL) throw new Error("tool inesperada");
    const saida = validarSaidaIA(uso.input);
    if (!saida.ok) throw new Error(`saída da IA inválida: ${saida.erro}`);

    const proposta = aplicarTravas(ficha, saida.saida);
    const { error } = await db.rpc("credito_registrar_avaliacao", {
      p_token: token,
      p_raiz: raiz,
      p_proposta: {
        ficha,
        limite_brl: proposta.limite_brl,
        prazo_max_dias: proposta.prazo_max_dias,
        risco: proposta.risco,
        confianca: proposta.confianca,
        saida_ia: { ...saida.saida, uso: resp.usage ?? null },
        travas: proposta.travas,
        modelo: MODELO_PADRAO,
        versao_politica: VERSAO_POLITICA,
      },
      p_erro: null,
    });
    if (error) throw new Error(`registro: ${error.message}`);
    return "proposta";
  } catch (e) {
    const msg = mensagemDeErro(e) ?? "erro sem mensagem";
    console.warn(`[credito-ia-avaliar] raiz ${raiz}: ${msg}`);
    await registrarFalha(db, token, raiz, msg);
    return "falha";
  }
}

/** Pool simples com concorrência fixa; cada raiz decide sozinha se ainda cabe no orçamento. */
async function emPool<T, R>(itens: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(itens.length);
  let i = 0;
  async function trabalhador(): Promise<void> {
    while (i < itens.length) {
      const k = i++;
      out[k] = await fn(itens[k]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, itens.length) }, trabalhador));
  return out;
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
  // ⚠️ SONDA DE VERSÃO — depois do gate, antes de reivindicar ou pagar tokens.
  const decisaoSonda = classificarSonda(body);
  if (decisaoSonda.tipo === "sonda") return json(respostaSonda(VERSAO));
  if (decisaoSonda.tipo === "ambiguo") return json({ ok: false, versao: VERSAO, error: erroSondaAmbigua(decisaoSonda.valor, EFEITO) }, 400);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ ok: false, versao: VERSAO, mensagem: "ANTHROPIC_API_KEY ausente" }, 500);
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const inicio = Date.now();
  try {
    const resumo = await comRegistro(db as unknown as DbRegistro, ACAO_REGISTRO, { via: auth.via, userId: auth.userId }, async () => {
      const token = crypto.randomUUID();
      const rec = await db.rpc("credito_reivindicar_raizes", {
        p_n: ORCAMENTO.raizesPorInvocacao, p_token: token, p_ttl_segundos: ORCAMENTO.ttlReivindicacaoS,
      });
      // erro ⇒ lança (nada reivindicado); null sem erro ⇒ nenhuma raiz elegível
      const lidas = exigirLeitura(rec, "credito_reivindicar_raizes") as unknown[] | null;
      const raizes = (lidas ?? []).filter((r): r is string => typeof r === "string");
      const desfechos = await emPool(raizes, ORCAMENTO.concorrencia, (r) => avaliarRaiz(db, apiKey, token, r, inicio));
      const conta = (d: Desfecho) => desfechos.filter((x) => x === d).length;
      return {
        reivindicadas: raizes.length,
        propostas: conta("proposta"),
        falhas: conta("falha"),
        adiadas: conta("adiada"),
        ms: Date.now() - inicio,
      };
    }, (r) => r);
    return json({ ok: true, versao: VERSAO, ...resumo });
  } catch (e) {
    return json({ ok: false, versao: VERSAO, mensagem: mensagemDeErro(e) ?? "erro sem mensagem" }, 500);
  }
});
