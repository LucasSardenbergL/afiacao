/**
 * Normaliza um telefone brasileiro para o formato esperado pela Nvoip:
 * 10 dígitos (DDD + fixo) ou 11 dígitos (DDD + celular com 9).
 *
 * Regras:
 * - Remove tudo que não for dígito.
 * - Remove o código de país 55 inicial (com ou sem zero antes do DDD).
 * - Se vier só com 8 ou 9 dígitos (sem DDD), aplica o DDD padrão (37 - Divinópolis/MG).
 */
const DEFAULT_DDD = '37';

export function normalizeBrPhone(input: string | null | undefined, defaultDdd = DEFAULT_DDD): string {
  if (!input) return '';
  let digits = String(input).replace(/\D/g, '');

  // Remove +55 / 55 prefixo (e zero opcional após)
  if (digits.length > 11 && digits.startsWith('55')) {
    digits = digits.slice(2);
  }
  if (digits.length > 11 && digits.startsWith('0')) {
    digits = digits.replace(/^0+/, '');
  }

  // Sem DDD → aplica padrão
  if (digits.length === 8 || digits.length === 9) {
    digits = defaultDdd + digits;
  }

  return digits;
}

/**
 * Formata para exibição: (DD) 9XXXX-XXXX ou (DD) XXXX-XXXX.
 * Se o número não bater com o padrão, retorna o input original.
 */
export function formatBrPhone(input: string | null | undefined): string {
  const d = normalizeBrPhone(input);
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return input ?? '';
}

/**
 * Retorna true se o telefone é celular (11 dígitos normalizados com 9 na 3ª posição).
 * Fixo = 10 dígitos. Usado p/ decidir mostrar o botão WhatsApp (celular) vs só ligar.
 */
export function isCellphone(phone: string | null | undefined): boolean {
  const d = normalizeBrPhone(phone);
  return d.length === 11 && d[2] === '9';
}

/**
 * Monta um link wa.me confiável a partir de um telefone brasileiro.
 * Normaliza (aplica o DDD padrão se faltar) e prefixa o código do país 55.
 * Retorna null quando o número não tem DDD + número válido (≥ 10 dígitos):
 * o call-site deve ESCONDER o botão em vez de renderizar um link quebrado.
 */
export function whatsappLink(
  phone: string | null | undefined,
  mensagem?: string,
): string | null {
  const numero = normalizeBrPhone(phone);
  if (numero.length < 10) return null;
  const base = `https://wa.me/55${numero}`;
  return mensagem ? `${base}?text=${encodeURIComponent(mensagem)}` : base;
}
