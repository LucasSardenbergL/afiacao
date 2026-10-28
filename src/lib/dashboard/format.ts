/**
 * Formatadores compactos pra KPIs do cockpit.
 * Ficam aqui (e não em `delta-aggregators`) pra ser reusados em qualquer zona
 * sem acoplar com a lógica de "desde a última visita".
 */

/**
 * Formata contagens inteiras com pt-BR thousand separator + sufixo compacto.
 *
 * - `< 1_000`        → "847"
 * - `< 10_000`       → "5.273"   (mantém precisão pra 4 dígitos)
 * - `< 1_000_000`    → "481k"
 * - `>= 1_000_000`   → "1,2M"
 *
 * Mantém legibilidade em KPI cell estreita (~120px @ text-xl).
 */
export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs < 1_000) return String(Math.round(n));
  if (abs < 10_000) return n.toLocaleString('pt-BR');
  if (abs < 1_000_000) return `${Math.round(n / 1_000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace('.', ',')}M`;
}

/**
 * Labels curtas pros status de `tint_importacoes.status` que aparecem no KPI
 * "Última import." — o texto cru ("processado", "processando") estoura o cell
 * e vira "processa..." truncado feio.
 */
export function formatImportStatus(status: string | null | undefined): string {
  if (!status) return '—';
  switch (status) {
    case 'concluido':
    case 'processado':
      return 'ok';
    case 'processando':
      return 'em curso';
    case 'erro':
      return 'erro';
    case 'parcial':
      return 'parcial';
    default:
      return status.length > 10 ? `${status.slice(0, 9)}…` : status;
  }
}

/**
 * Como uma linha de `tint_importacoes` com erro aparece no cockpit. O sync automático do balcão
 * grava `arquivo_nome = 'sync:<uuid do run>'` — o uuid não diz nada a quem lê. E o "erro" desse run
 * é fórmula que o guard BARROU (a receita anterior segue valendo), não falha do sync: por isso
 * `barrada`, e não `erro`. Contagem ausente não vira "0" (ausente ≠ zero).
 */
export function descreverImportacaoTint(linha: {
  arquivo_nome?: string | null;
  registros_erro?: number | null;
  created_at?: string | null;
}): { titulo: string; detalhe: string; ehSync: boolean } {
  const n = linha.registros_erro;
  if (linha.arquivo_nome?.startsWith('sync:')) {
    const quando = linha.created_at
      ? new Date(linha.created_at).toLocaleString('pt-BR', {
          day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
        })
      : null;
    return {
      titulo: quando ? `Sync de fórmulas · ${quando}` : 'Sync de fórmulas',
      detalhe: n == null ? 'fórmulas barradas (sem contagem)' : `${n} ${n === 1 ? 'fórmula barrada' : 'fórmulas barradas'} pela fonte`,
      ehSync: true,
    };
  }
  return {
    titulo: linha.arquivo_nome ?? 'Importação',
    detalhe: n == null ? 'erros (sem contagem)' : `${n} erro(s)`,
    ehSync: false,
  };
}
