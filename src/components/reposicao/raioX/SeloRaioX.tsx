import { ROTULOS } from '@/lib/reposicao/raio-x/classificar';
import type { DecisaoSelo } from './useDecisoesRaioX';

function dataBR(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

/** Aviso (nunca bloqueio): este SKU foi decidido no Raio-X para sair do estoque. */
export function SeloRaioX({ decisao }: { decisao: DecisaoSelo }) {
  const partes = [`Raio-X: ${ROTULOS[decisao.destino]?.toLowerCase() ?? decisao.destino}`, dataBR(decisao.decidido_em), decisao.decidido_por_nome].filter(
    (p): p is string => !!p,
  );
  return (
    <span data-testid="selo-raio-x" className="text-[11px] font-medium text-status-warning whitespace-nowrap">
      {partes.join(' · ')}
    </span>
  );
}
