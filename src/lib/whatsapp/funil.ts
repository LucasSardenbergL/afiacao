// Funil do Canal WhatsApp (PR-3): parse da row de get_whatsapp_funil.
// Atribuição conservadora decidida no SQL (elo explícito); aqui só o shape.

export interface WaFunil {
  enviados: number;
  entregues: number;
  lidos: number;
  falhas: number;
  respondidos: number;
  propostas: number;
  pedidosOmie: number;
  /** null = sem pedidos com total conhecido — NUNCA exibir como R$ 0 (ausente ≠ zero) */
  receitaOmie: number | null;
}

const COUNTS = ['enviados', 'entregues', 'lidos', 'falhas', 'respondidos', 'propostas', 'pedidos_omie'] as const;

/** Row da RPC → WaFunil. Counts inválidos invalidam a row inteira (null, não números fabricados). */
export function mapFunilRow(raw: unknown): WaFunil | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const counts: number[] = [];
  for (const key of COUNTS) {
    const n = typeof r[key] === 'number' ? (r[key] as number) : Number(r[key]);
    if (!Number.isFinite(n)) return null;
    counts.push(n);
  }

  // numeric do PostgREST vem como string; null preservado (sum() sem linhas)
  const receitaRaw = r['receita_omie'];
  const receitaOmie =
    receitaRaw === null || receitaRaw === undefined ? null : Number(receitaRaw);
  if (receitaOmie !== null && !Number.isFinite(receitaOmie)) return null;

  const [enviados, entregues, lidos, falhas, respondidos, propostas, pedidosOmie] = counts;
  return { enviados, entregues, lidos, falhas, respondidos, propostas, pedidosOmie, receitaOmie };
}
