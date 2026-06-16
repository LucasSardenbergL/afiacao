// Classificação do resultado do envio ao portal Sayerlack (money-path).
//
// ⚠️ ESPELHO VERBATIM dentro de `supabase/functions/enviar-pedido-portal-sayerlack/index.ts`
// (o edge não importa de src/ — Deno). Manter as DUAS cópias em sincronia:
//   - `classifyEnvelopeStatus` → inlinado no `buildEnvelope` (roda no Browserless).
//   - `decidirStatusDeno`      → inlinado na máquina de estados do Deno (~L1978).
//
// Spec: docs/superpowers/specs/2026-06-15-sayerlack-reclassificacao-finalizacao-design.md
//
// INVARIANTE-MESTRA: `erro_retentavel` faz o motor AUTO-RE-DISPARAR. Se um pedido
// PODE ter sido colocado e cair em retentável → DUPLICATA no fornecedor. Só relaxar
// para `erro_retentavel` quando PROVADAMENTE não houve pedido — i.e. o clique de
// "Efetivar Pedido" (#btnSalvarNovoPedido) NUNCA ocorreu (`efetivarAttempted === false`
// EXPLÍCITO). Desconhecido / `undefined` / clicou → `indeterminado` (fail-closed).

export type EnvelopeStatus =
  | "sucesso_portal"
  | "aceito_portal_sem_protocolo"
  | "indeterminado_requer_conciliacao"
  | "erro_nao_retentavel"
  | "erro_retentavel";

export interface ClassifyInput {
  /** O script do portal determinou sucesso explícito (data.success === true). */
  success: boolean;
  /** Protocolo do pedido (número), se capturado. */
  protocolo: string | null;
  /** Um protocolo foi auto-extraído do recorder (recuperação PR1.5). */
  protocoloAutoExtraido: boolean;
  /**
   * O clique em "Efetivar Pedido" (#btnSalvarNovoPedido) foi disparado.
   * É o ÚNICO ponto que coloca o pedido na Sayerlack. `false` EXPLÍCITO = prova
   * de que nenhum pedido foi colocado. `undefined` (envelope velho/parcial) =
   * desconhecido → tratado como NÃO-prova (fail-closed → indeterminado).
   */
  efetivarAttempted: boolean | undefined;
  /** erroTipo do envelope (EXCEPTION, LOGIN_FAILED, etc.) ou null. */
  erroTipo: string | null;
}

export interface ClassifyResult {
  status: EnvelopeStatus;
  ok: boolean;
  safeToRetry: boolean;
  needsReconciliation: boolean;
}

// Erros lógicos exclusivamente PRÉ-clique: retentar não resolve (de-para/login/grupo).
// Todos ocorrem antes do "Efetivar" → nunca implicam pedido colocado.
const ERROS_LOGICOS_PRE_SUBMIT: ReadonlySet<string> = new Set([
  "LOGIN_FAILED",
  "CLIENTE_NOT_FOUND",
  "SKU_NOT_FOUND",
  "GRUPO_LEADTIME_MISMATCH",
]);

const STATUS_CONHECIDOS: ReadonlySet<string> = new Set<EnvelopeStatus>([
  "sucesso_portal",
  "aceito_portal_sem_protocolo",
  "indeterminado_requer_conciliacao",
  "erro_nao_retentavel",
  "erro_retentavel",
]);

/**
 * Camada 1 — classificação dentro do Browserless (espelha o `buildEnvelope`).
 * A decisão de FALHA é PURA por `efetivarAttempted` — `requestSent` NÃO entra
 * (era proxy ruim: falso-perigo no rascunho + falso-seguro quando o recorder
 * perde o POST de finalização).
 */
export function classifyEnvelopeStatus(input: ClassifyInput): ClassifyResult {
  const { success, protocolo, protocoloAutoExtraido, efetivarAttempted, erroTipo } = input;

  // 1. Sucesso explícito do script (só setado pós-clique pela lógica de submit).
  if (success === true) {
    const status: EnvelopeStatus = protocolo ? "sucesso_portal" : "aceito_portal_sem_protocolo";
    return { status, ok: true, safeToRetry: false, needsReconciliation: !protocolo };
  }

  // 2. Recuperação PR1.5: protocolo auto-extraído SÓ vira sucesso se o Efetivar
  //    foi REALMENTE clicado. Protocolo de resposta de rascunho é pré-clique
  //    (efetivarAttempted=false) → este ramo é pulado → não vira falso-sucesso.
  if (protocoloAutoExtraido && efetivarAttempted === true) {
    return { status: "sucesso_portal", ok: true, safeToRetry: false, needsReconciliation: false };
  }

  // 3. Falha.
  if (erroTipo !== null && ERROS_LOGICOS_PRE_SUBMIT.has(erroTipo)) {
    return { status: "erro_nao_retentavel", ok: false, safeToRetry: false, needsReconciliation: false };
  }
  if (efetivarAttempted === false) {
    // Provadamente sem clique de Efetivar → nenhum pedido colocado → seguro retentar.
    return { status: "erro_retentavel", ok: false, safeToRetry: true, needsReconciliation: false };
  }
  // efetivarAttempted === true (clicou → pode ter colocado) OU undefined (desconhecido).
  return { status: "indeterminado_requer_conciliacao", ok: false, safeToRetry: false, needsReconciliation: true };
}

/**
 * Camada 2 — rede de segurança do Deno sobre o `status` do envelope.
 * Só ENDURECE, nunca afrouxa:
 *   - status desconhecido → indeterminado (fail-closed);
 *   - `erro_retentavel` só sobrevive com `efetivarAttempted === false` EXPLÍCITO;
 *     true/undefined → endurece para indeterminado.
 * NUNCA rebaixa indeterminado/erro_nao_retentavel/sucesso.
 */
export function decidirStatusDeno(
  envStatus: string,
  efetivarAttempted: boolean | undefined,
): EnvelopeStatus {
  if (!STATUS_CONHECIDOS.has(envStatus)) {
    return "indeterminado_requer_conciliacao";
  }
  if (envStatus === "erro_retentavel" && efetivarAttempted !== false) {
    return "indeterminado_requer_conciliacao";
  }
  return envStatus as EnvelopeStatus;
}
