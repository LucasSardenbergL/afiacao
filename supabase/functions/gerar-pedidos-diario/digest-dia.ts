// Em que dia o digest matinal de e-mail sai.
//
// PEDIDO DO FOUNDER (2026-10-10): "não consigo colocar pedidos na Sayerlack no domingo, pode retirar
// o envio do e-mail nesse dia". A geração do ciclo continua rodando no domingo (o Cockpit segue
// atualizado); só o e-mail é suprimido.

/** `dataCiclo` no formato YYYY-MM-DD (dia de SP). Domingo ⇒ sem digest. */
export function digestSuprimidoNoDia(dataCiclo: string): boolean {
  const d = new Date(`${dataCiclo}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return false; // data inválida: não engole o e-mail por engano
  return d.getUTCDay() === 0;
}
