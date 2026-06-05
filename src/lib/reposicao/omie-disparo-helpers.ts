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
