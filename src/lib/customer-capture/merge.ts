import type { CustomerCapture } from '@/lib/spin/types';

const EMPTY_CAPTURE: CustomerCapture = {
  razao_social: null,
  nome_contato: null,
  cnpj: null,
  email: null,
  telefone_alternativo: null,
  cidade: null,
  estado: null,
  endereco: null,
  segmento: null,
  porte_estimado: null,
  volume_mensal_litros: null,
  produtos_interesse: [],
  tags_detectadas: [],
  observacoes: null,
};

export function emptyCapture(): CustomerCapture {
  return { ...EMPTY_CAPTURE, produtos_interesse: [], tags_detectadas: [] };
}

/**
 * Faz merge incremental de capture do Claude com o buffer acumulado.
 * Para cada campo:
 * - Scalar (string/number): se incoming.field != null, sobrescreve (versão mais nova ganha)
 * - Array: faz union deduplicado (case-insensitive)
 *
 * Pattern: análises subsequentes refinam dados sem perder o que já foi capturado.
 */
export function mergeCustomerCapture(
  buffer: CustomerCapture,
  incoming: CustomerCapture | null | undefined
): CustomerCapture {
  if (!incoming) return buffer;

  const merged: CustomerCapture = { ...buffer };

  // Scalar fields: incoming sobrescreve se != null
  const scalarFields: (keyof CustomerCapture)[] = [
    'razao_social',
    'nome_contato',
    'cnpj',
    'email',
    'telefone_alternativo',
    'cidade',
    'estado',
    'endereco',
    'segmento',
    'porte_estimado',
    'volume_mensal_litros',
    'observacoes',
  ];
  for (const f of scalarFields) {
    const v = incoming[f];
    if (v !== null && v !== undefined && v !== '') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (merged[f] as any) = v;
    }
  }

  // Arrays: union deduplicado case-insensitive
  merged.produtos_interesse = unionDedupe(buffer.produtos_interesse, incoming.produtos_interesse);
  merged.tags_detectadas = unionDedupe(buffer.tags_detectadas, incoming.tags_detectadas);

  return merged;
}

function unionDedupe(a: string[], b: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of [...a, ...b]) {
    const key = v.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(v.trim());
  }
  return out;
}

/**
 * Conta quantos campos significativos estão preenchidos.
 * Usado pra decidir se vale a pena abrir wizard pós-call.
 */
export function captureFilledCount(c: CustomerCapture): number {
  let count = 0;
  if (c.razao_social) count++;
  if (c.nome_contato) count++;
  if (c.cnpj) count++;
  if (c.email) count++;
  if (c.cidade) count++;
  if (c.segmento) count++;
  if (c.volume_mensal_litros) count++;
  if (c.produtos_interesse.length > 0) count++;
  return count;
}
