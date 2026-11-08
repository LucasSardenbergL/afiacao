/**
 * Rascunho da nota da ficha do Radar, por CNPJ (pacote G4).
 *
 * O texto do vendedor nunca se perde ao trocar de lead: a ficha guarda o que estava no campo antes de mudar de
 * CNPJ e restaura ao voltar. Só se apaga quando o servidor CONFIRMA que gravou a nota (registro novo ou nota
 * anexada a um registro repetido). Vive no sessionStorage (sobrevive a recarregar a aba); sem ele (aba privada,
 * storage bloqueado), num Map em memória — o mesmo contrato, só sem sobreviver ao recarregar.
 */
const PREFIXO = 'radar.rascunho_nota:';
const memoria = new Map<string, string>();

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' && window.sessionStorage ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

export function lerRascunhoNota(cnpj: string): string {
  const s = storage();
  if (s) {
    try {
      const v = s.getItem(PREFIXO + cnpj);
      if (v != null) return v;
    } catch { /* cai na memória */ }
  }
  return memoria.get(cnpj) ?? '';
}

/** Texto vazio (ou só espaços) apaga o rascunho: não há o que guardar. */
export function gravarRascunhoNota(cnpj: string, texto: string): void {
  if (!texto.trim()) { limparRascunhoNota(cnpj); return; }
  memoria.set(cnpj, texto);
  const s = storage();
  if (!s) return;
  try { s.setItem(PREFIXO + cnpj, texto); } catch { /* a memória já guardou */ }
}

export function limparRascunhoNota(cnpj: string): void {
  memoria.delete(cnpj);
  const s = storage();
  if (!s) return;
  try { s.removeItem(PREFIXO + cnpj); } catch { /* nada a limpar */ }
}
