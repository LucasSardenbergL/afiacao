// Normalização canônica de CEP no front — espelha o SQL public.normalizar_cep
// (tira tudo que não é dígito) E acrescenta a validade de 8 dígitos da PK cep_geo:
// um CEP não-8 não é geocodificável (o upsert no banco faria no-op), então aqui já
// vira null pra ficar fora da fila/dedup. Chave estável p/ agrupar empresas do CEP.
export function normalizarCep(raw: string | null | undefined): string | null {
  const digitos = (raw ?? '').replace(/\D/g, '');
  return /^[0-9]{8}$/.test(digitos) ? digitos : null;
}
