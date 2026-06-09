const MAX_LEN = 60;
const RESERVADOS = new Set(['__OUTROS__']);

/**
 * Normaliza uma medida digitada no "Outros" de um dropdown de especificação de
 * ferramenta. Espelha a normalização da RPC `adicionar_opcao_tool_spec`:
 * NFC + remove caracteres de controle + colapsa espaços + trim.
 * Retorna `null` se inválida (vazia, > 60 chars, ou valor reservado).
 *
 * Uso: validação otimista no front (feedback rápido). O valor canônico final
 * (após dedupe case-insensitive) é decidido pelo servidor, não aqui.
 */
export function normalizarOpcaoSpec(valor: string): string | null {
  if (valor == null) return null;
  // eslint-disable-next-line no-control-regex
  const semControle = valor.normalize('NFC').replace(/[\u0000-\u001F\u007F]/g, '');
  const norm = semControle.replace(/\s+/g, ' ').trim();
  if (norm === '') return null;
  if (norm.length > MAX_LEN) return null;
  if (RESERVADOS.has(norm.toUpperCase())) return null;
  return norm;
}
