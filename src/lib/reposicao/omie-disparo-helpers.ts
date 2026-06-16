// Helpers puros do disparo de pedido de compra ao Omie.
// ⚠️ ESPELHADO VERBATIM em supabase/functions/disparar-pedidos-aprovados/index.ts
// (Deno não importa de @/). Mudou aqui? Copie lá.

/**
 * Detecta o erro do Omie de pedido de compra com código de integração duplicado.
 * O Omie REJEITA IncluirPedCompra com cCodIntPed já existente ("já cadastrado").
 * Como cCodIntPed=AFI-<id> é estável, isso significa que o PV JÁ existe (corrida
 * disparo×cron ou retry pós-crash) → tratamos como reconciliação, não falha.
 */
export function isOmiePedidoJaCadastrado(msg: string | null | undefined): boolean {
  if (!msg) return false;
  const m = msg.toLowerCase();
  if (/j[áa]\s+(foi\s+)?cadastrad/.test(m)) return true;
  if (/c[óo]digo\s+de\s+integra\w*/.test(m) && /cadastrad/.test(m)) return true;
  if (/already\s+(registered|exists)/.test(m)) return true;
  return false;
}

/** Extrai { id, numero } do cabeçalho retornado por ConsultarPedCompra/PesquisarPedCompra. */
export function extrairPedidoOmie(
  resp: unknown,
): { id: string; numero: string } | null {
  if (!resp || typeof resp !== 'object') return null;
  const r = resp as Record<string, unknown>;
  const cab = (r.pedido_compra_cabecalho ??
    r.cabecalho ??
    r.cabecalho_consulta ??
    r) as Record<string, unknown>;
  const idRaw = cab?.nCodPed ?? r.nCodPed;
  if (idRaw == null) return null;
  const numeroRaw = cab?.cNumero ?? r.cNumero;
  return { id: String(idRaw), numero: numeroRaw != null ? String(numeroRaw) : '' };
}

/**
 * Guard anti-PO-duplicado da conciliação manual (Fase 3 · 3b, §4.4).
 *
 * O pedido JÁ tem um pedido de compra criado no Omie quando `omie_pedido_compra_id`
 * está preenchido (qualquer string não-vazia após trim). Nesse caso a conciliação
 * NÃO deve recriar o PO no Omie — só registrar o protocolo. O dedup por cCodIntPed
 * do próprio Omie é um backstop, mas este guard evita a chamada por completo.
 *
 * Retorna `true` quando o Omie AINDA NÃO tem o PO → seguro disparar a criação.
 * Conservador: NULL/''/whitespace/0 numérico-como-string == "não tem" → cria
 * (igual ao comportamento de hoje); só pula quando há um id real.
 */
export function deveCriarPedidoOmie(
  omiePedidoCompraId: string | number | null | undefined,
): boolean {
  if (omiePedidoCompraId == null) return true;
  const s = String(omiePedidoCompraId).trim();
  if (s === '') return true;
  // O disparo grava "" quando o Omie não devolveu id; trate strings que representam
  // "vazio/zero" como ausência de PO (não bloqueia uma criação legítima).
  if (s === '0') return true;
  return false;
}

/**
 * O pedido de portal é enviado por AUTOMAÇÃO (Browserless cola sozinho no portal
 * B2B) e não exige cole manual do staff. Hoje a única automação de portal é o
 * Sayerlack/OBEN.
 * ⚠️ Espelha isSayerlackOben() do edge — se outra automação de portal surgir,
 * estenda os dois lados juntos.
 */
export function portalEnviadoPorAutomacao(p: {
  empresa?: string | null;
  fornecedor_nome?: string | null;
}): boolean {
  return (
    (p.empresa ?? '').toUpperCase() === 'OBEN' &&
    /sayerlack/i.test(p.fornecedor_nome ?? '')
  );
}

/**
 * O e-mail "[Portal B2B] pronto para colar no portal" só é útil para portais SEM
 * automação — onde o staff realmente cola o pedido na mão. Para o Sayerlack/OBEN
 * (Browserless cola sozinho → "✓ Enviado") esse aviso "insere manualmente" é ruído
 * enganoso: o pedido já foi enviado, e o e-mail-resumo do ciclo ("Pedidos
 * disparados: …") já confirma o sucesso.
 *
 * Retorna true quando o e-mail manual do portal AINDA deve ser enviado.
 * Conservador: na dúvida (sem sinal claro de automação) → envia.
 */
export function deveEnviarEmailPortalManual(p: {
  empresa?: string | null;
  fornecedor_nome?: string | null;
}): boolean {
  return !portalEnviadoPorAutomacao(p);
}
