/**
 * Detecta a resposta do Omie de codigo_pedido_integracao DUPLICADO. Lê de Error.message
 * (callOmieVendasApi LANÇA em fault) ou string crua. ⚠️ ESPELHADO no edge. As frases
 * devem bater com a faultstring REAL do Omie (confirmar na Task 8).
 */
export function isOmieDuplicatePedido(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : typeof err === 'string' ? err : '').toLowerCase();
  if (!msg) return false;
  return msg.includes('já cadastrad') || msg.includes('ja cadastrad')
    || (msg.includes('integra') && msg.includes('cadastrad'));
}
