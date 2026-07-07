export type FinanceiroError =
  | { kind: 'period_locked'; empresa: string; periodo: string; lastClosed: string; raw: unknown }
  | { kind: 'mapping_incomplete'; count: number; pendentes: Array<{ id: string; nome: string }>; raw: unknown }
  | { kind: 'unknown'; raw: unknown };

export function parsePostgresFinanceiroError(err: unknown): FinanceiroError {
  if (!err || typeof err !== 'object') return { kind: 'unknown', raw: err };
  const e = err as { code?: string; message?: string };

  if (e.code === 'P0001' && e.message?.startsWith('PERIOD_LOCKED:')) {
    const m = e.message.match(
      /PERIOD_LOCKED: Período (\d{2}\/\d{4}) da empresa (\S+) está fechado em (\d{4}-\d{2}-\d{2})/,
    );
    if (m) {
      return { kind: 'period_locked', periodo: m[1], empresa: m[2], lastClosed: m[3], raw: err };
    }
  }

  if (e.code === 'P0002' && e.message?.startsWith('MAPPING_INCOMPLETE:')) {
    const countMatch = e.message.match(/(\d+) categorias sem mapeamento/);
    const jsonMatch = e.message.match(/\[.*\]/);
    let pendentes: Array<{ id: string; nome: string }> = [];
    if (jsonMatch) {
      try {
        pendentes = JSON.parse(jsonMatch[0]);
      } catch {
        // mantém vazio se parse falhar
      }
    }
    return {
      kind: 'mapping_incomplete',
      count: countMatch ? Number(countMatch[1]) : pendentes.length,
      pendentes,
      raw: err,
    };
  }

  return { kind: 'unknown', raw: err };
}
