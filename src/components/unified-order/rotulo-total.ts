// Mesma formatação do `fmt` de useUnifiedOrder — sem importar o hook (puxaria o cliente Supabase).
const fmt = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/**
 * Rótulo do total do pedido — o MESMO no carrinho e na barra de envio (C2, rodada 2).
 * B4: com serviço "a orçar", o valor conhecido é subtotal, não "Total"; sem valor, "A definir".
 */
export function rotuloTotal(totalEstimated: number, servicosAOrcar: number): { rotulo: string; valor: string } {
  return {
    rotulo: servicosAOrcar > 0 && totalEstimated > 0 ? 'Subtotal conhecido' : 'Total',
    valor: totalEstimated > 0 ? fmt(totalEstimated) : 'A definir',
  };
}
