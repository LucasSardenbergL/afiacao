/** Só dígitos (e o + internacional) — o que o discador do aparelho aceita no `tel:`. Curto demais → null. */
export function hrefTelefone(telefone: string | null | undefined): string | null {
  if (!telefone) return null;
  const digitos = telefone.replace(/[^\d+]/g, '');
  return digitos.replace(/\D/g, '').length >= 8 ? `tel:${digitos}` : null;
}
