// Núcleo puro da recomendação da fila de crédito (PR 6a). Sem IO: roda sob `deno test --no-remote`.
// Migration: supabase/migrations/20261125200000_credito_fila_enforcement_dormente.sql.
//
// A IA é CONSULTIVA: nada daqui autoriza pedido. A entrada vem pronta do banco
// (`private.credito_fila_entrada_ia`: só números/flags/enums da decisão) e é revalidada aqui
// antes de sair para o modelo — defesa em profundidade contra texto livre (spec §9.9).

export const VERSAO_PROMPT = "fila-v1";

export const RECOMENDACOES = ["aprovar", "recusar", "sem_recomendacao"] as const;
export type Recomendacao = (typeof RECOMENDACOES)[number];

// Espelho do CHECK de credito_fila_recomendacao.codigos — mudou lá, muda aqui.
export const CODIGOS = [
  "dentro_historico", "estouro_pequeno", "estouro_grande", "prazo_acima_historico", "prazo_desconhecido",
  "risco_alto", "sem_historico", "exposicao_alta", "pagador_pontual", "atraso_recente",
  "limite_desatualizado", "sem_limite", "limite_mudou",
] as const;

// Degraus de prazo da spec §9 (builder-check).
export const DEGRAUS_PRAZO = [7, 14, 21, 28, 35, 42, 56, 63, 70, 84, 90, 120] as const;

const CHAVES_ENUM = new Set(["company", "modo", "faixa", "motivo", "risco"]);
const ENUM_RE = /^[a-z0-9_]{1,40}$/;

/** Espelho de private.credito_entrada_so_escalares: string só em chave de enum e só [a-z0-9_]. */
export function entradaSoEscalares(entrada: unknown): entrada is Record<string, number | boolean | string> {
  if (!entrada || typeof entrada !== "object" || Array.isArray(entrada)) return false;
  for (const [k, v] of Object.entries(entrada as Record<string, unknown>)) {
    if (v === null) continue;
    if (typeof v === "number") { if (!Number.isFinite(v)) return false; continue; }
    if (typeof v === "boolean") continue;
    if (typeof v === "string") { if (!CHAVES_ENUM.has(k) || !ENUM_RE.test(v)) return false; continue; }
    return false;
  }
  return true;
}

export const SISTEMA = `Você é analista de crédito B2B de uma distribuidora brasileira.
Recebe UM pedido que a política de crédito colocou em revisão manual (faixa amarela) e devolve uma
recomendação CONSULTIVA para o aprovador humano. Você não aprova nada: só recomenda.

A entrada é um JSON só com números, flags e códigos. Significado:
- valor_brl: valor do pedido; prazo_dias: prazo da condição de pagamento (ausente = prazo desconhecido).
- limite_brl / prazo_max_dias: limite de crédito vigente do grupo econômico quando a decisão foi tomada.
- exposicao_titulos_brl: títulos em aberto do grupo; exposicao_reservas_brl: pedidos já reservados.
- uso_limite_pos_pedido: (títulos + reservas + pedido) / limite. Acima de 1 = estoura.
- motivo: por que caiu na revisão (estoura_limite, prazo_acima, prazo_ilegivel, sem_limite,
  limite_desatualizado, risco_alto, risco_sem_evidencia, exposicao_indeterminada, …).
- risco: risco do limite (baixo/medio/alto/sem_evidencia); limite_mudou = o limite mudou depois da decisão.
- piso_*: dados de títulos vencidos.
- modo: 'efetivo' (pedido real esperando) ou 'sombra' (simulação).

Regras:
- Dado ausente NÃO é zero. Sem dado suficiente, recomende 'sem_recomendacao'.
- 'aprovar' só quando o risco incremental é pequeno e explicável pelos números; pode sugerir um prazo
  menor (um dos degraus 7,14,21,28,35,42,56,63,70,84,90,120) se o prazo pedido for o problema.
- 'recusar' quando os números indicam risco alto (estouro grande, atraso recente, exposição alta).
- Use os códigos da ferramenta para justificar; nunca escreva texto livre.
Responda SEMPRE chamando a ferramenta registrar_recomendacao.`;

export const TOOL = {
  name: "registrar_recomendacao",
  description: "Registra a recomendação consultiva para o aprovador de crédito.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      recomendacao: { type: "string", enum: [...RECOMENDACOES] },
      prazo_sugerido_dias: { type: ["integer", "null"], enum: [...DEGRAUS_PRAZO, null] },
      confianca: { type: ["number", "null"], minimum: 0, maximum: 1 },
      codigos: { type: "array", items: { type: "string", enum: [...CODIGOS] }, maxItems: 5 },
    },
    required: ["recomendacao", "codigos"],
  },
} as const;

export interface SaidaValida {
  recomendacao: Recomendacao;
  prazo_sugerido_dias: number | null;
  confianca: number | null;
  codigos: string[];
}

export type ResultadoValidacao = { ok: true; saida: SaidaValida } | { ok: false; erro: string };

/** Valida a saída da tool, incluindo a COERÊNCIA entre os campos (espelho dos CHECKs da tabela). */
export function validarSaida(input: unknown): ResultadoValidacao {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, erro: "saida_nao_objeto" };
  const o = input as Record<string, unknown>;
  const rec = o.recomendacao;
  if (typeof rec !== "string" || !(RECOMENDACOES as readonly string[]).includes(rec)) {
    return { ok: false, erro: "recomendacao_invalida" };
  }
  const codigos = o.codigos ?? [];
  if (!Array.isArray(codigos) || codigos.length > 5 ||
      codigos.some((c) => typeof c !== "string" || !(CODIGOS as readonly string[]).includes(c))) {
    return { ok: false, erro: "codigos_invalidos" };
  }
  const prazo = o.prazo_sugerido_dias ?? null;
  if (prazo !== null && !(typeof prazo === "number" && (DEGRAUS_PRAZO as readonly number[]).includes(prazo))) {
    return { ok: false, erro: "prazo_fora_dos_degraus" };
  }
  const conf = o.confianca ?? null;
  if (conf !== null && !(typeof conf === "number" && Number.isFinite(conf) && conf >= 0 && conf <= 1)) {
    return { ok: false, erro: "confianca_invalida" };
  }
  if (rec === "aprovar" && conf === null) return { ok: false, erro: "aprovar_sem_confianca" };
  if (rec === "recusar" && (conf === null || prazo !== null)) return { ok: false, erro: "recusar_incoerente" };
  if (rec === "sem_recomendacao" && (conf !== null || prazo !== null)) {
    return { ok: false, erro: "abstencao_incoerente" };
  }
  return {
    ok: true,
    saida: { recomendacao: rec as Recomendacao, prazo_sugerido_dias: prazo as number | null,
             confianca: conf as number | null, codigos: [...new Set(codigos as string[])] },
  };
}

/** Lote por invocação: 5 × ~25 s cabe abaixo do kill de ~150 s da edge. */
export const MAX_POR_INVOCACAO = 5;
export const TIMEOUT_POR_CHAMADA_MS = 25_000;

export function maxDoCorpo(corpo: unknown): number {
  const m = (corpo as { max?: unknown } | null)?.max;
  if (typeof m !== "number" || !Number.isInteger(m) || m < 1) return MAX_POR_INVOCACAO;
  return Math.min(m, MAX_POR_INVOCACAO);
}
