// Gate de mínimo de faturamento no disparo de pedidos de compra (pacote intra-day, PR2).
// R$3.000 é o mínimo de faturamento da Sayerlack: pedido abaixo disso não fatura (fica parado
// no fornecedor). O gate barra o disparo ANTES do split e de qualquer envio (portal/Omie),
// marcando falha_envio com motivo claro — mesmo caminho do guard de custo/qtde zero (#422/#433).
//
// A régua vem de company_config (reposicao_alerta_pedido_valor_minimo +
// reposicao_alerta_pedido_fornecedor_ilike) — a MESMA do alerta R$3k: uma régua, dois usos
// (alertar quando atinge; barrar quando não atinge).
//
// ⚠️ Espelhado VERBATIM em supabase/functions/disparar-pedidos-aprovados/index.ts (Deno não
// importa de src/) — mudou aqui, mudou lá. Spec:
// docs/superpowers/specs/2026-06-09-reposicao-intraday-alerta-3k-design.md

export interface PedidoParaGate {
  fornecedor_nome: string | null;
  valor_total: number | string | null;
  split_parent_id?: number | null;
  portal_protocolo?: string | null;
  status_envio_portal?: string | null;
}

export interface GateConfig {
  /** Régua em R$ (company_config: reposicao_alerta_pedido_valor_minimo). */
  valorMinimo: number | null;
  /** Pattern ILIKE simples, ex. '%SAYERLACK%' — o espelho TS suporta só a forma %TEXTO%. */
  fornecedorPattern: string | null;
}

// Estados em que o fornecedor PODE já ter recebido o PO via portal — barrar agora criaria
// órfão pior (PO no portal sem Omie); o fluxo de reconciliação/idempotência segue.
const PORTAL_JA_TOCADO = new Set([
  "sucesso_portal",
  "enviado_portal",
  "aceito_portal_sem_protocolo",
  "indeterminado_requer_conciliacao",
]);

function fornecedorCasaPattern(nome: string, pattern: string): boolean {
  const alvo = pattern.replace(/%/g, "").trim().toUpperCase();
  if (!alvo) return false;
  return nome.toUpperCase().includes(alvo);
}

export function deveBloquearPorMinimoFaturamento(
  pedido: PedidoParaGate,
  cfg: GateConfig,
): { bloquear: boolean; motivo?: string } {
  // Config ausente/inválida = gate DESLIGADO (fail-open deliberado: régua comercial, não
  // barreira de segurança — sem config não se inventa régua).
  const minimo = Number(cfg.valorMinimo);
  if (!Number.isFinite(minimo) || minimo <= 0) return { bloquear: false };
  if (!cfg.fornecedorPattern || !cfg.fornecedorPattern.replace(/%/g, "").trim()) {
    return { bloquear: false };
  }

  // Filho de split herda a aprovação do pai (um pai ≥ régua vira filhos menores; barrá-los
  // re-quebraria o split). O gate roda ANTES do split — filho só chega aqui via re-disparo
  // individual.
  if (pedido.split_parent_id != null) return { bloquear: false };

  if (
    !pedido.fornecedor_nome ||
    !fornecedorCasaPattern(pedido.fornecedor_nome, cfg.fornecedorPattern)
  ) {
    return { bloquear: false };
  }

  if (pedido.portal_protocolo != null && pedido.portal_protocolo !== "") {
    return { bloquear: false };
  }
  if (
    pedido.status_envio_portal &&
    PORTAL_JA_TOCADO.has(pedido.status_envio_portal)
  ) {
    return { bloquear: false };
  }

  const valor = Number(pedido.valor_total);
  if (Number.isFinite(valor) && valor >= minimo) return { bloquear: false };

  // Valor nulo/NaN também barra: pedido Sayerlack sem valor não fatura.
  return {
    bloquear: true,
    motivo:
      `Pedido R$ ${Math.round(Number.isFinite(valor) ? valor : 0)} abaixo do mínimo de ` +
      `faturamento (R$ ${Math.round(minimo)}) — aguarde o ciclo acumular mais itens ou ` +
      `cancele o pedido.`,
  };
}
