export function buildWhatsappTaskMessage(t: { descricao: string; target_texto?: string | null }): string {
  const corpo = (t.descricao ?? '').trim();
  const alvo = (t.target_texto ?? '').trim();
  return alvo ? `${corpo}\n\n${alvo}` : corpo;
}

/** Monta o deeplink wa.me. phone em formato BR livre; assume +55 quando há dígitos. */
export function buildWaMeUrl(phone: string | null | undefined, message: string): string {
  const digits = (phone ?? '').replace(/\D/g, '');
  const num = digits ? (digits.startsWith('55') ? digits : `55${digits}`) : '';
  return `https://wa.me/${num}?text=${encodeURIComponent(message)}`;
}
