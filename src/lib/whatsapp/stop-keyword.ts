const STOP = new Set(['PARAR', 'SAIR', 'STOP', 'CANCELAR', 'DESCADASTRAR']);

export function isStopKeyword(body: string | null | undefined): boolean {
  if (!body) return false;
  // só dispara quando a mensagem É a palavra (1 token), não quando aparece numa frase.
  const t = body
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[^A-Z\s]/g, '').trim();
  return STOP.has(t);
}
