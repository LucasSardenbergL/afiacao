const STOP = new Set(['PARAR', 'SAIR', 'STOP', 'CANCELAR', 'DESCADASTRAR']);

export function isStopKeyword(body: string | null | undefined): boolean {
  if (!body) return false;
  // só dispara quando a mensagem É a palavra (1 token), não quando aparece numa frase.
  const t = body
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[^A-Z\s]/g, '').trim();
  return STOP.has(t);
}

const REJOIN = new Set(['VOLTAR']);

/** "VOLTAR" (a mensagem inteira) — o único jeito de o cliente sair do opt_out. */
export function isRejoinKeyword(body: string | null | undefined): boolean {
  if (!body) return false;
  const t = body
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/[^A-Z\s]/g, '').trim();
  return REJOIN.has(t);
}
