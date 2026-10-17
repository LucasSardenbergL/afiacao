import { diffContagem } from '@/lib/reposicao/raio-x/saidas';
import type { Categoria, DecisaoRow, ItemRaioX } from '@/lib/reposicao/raio-x/tipos';
import { RaioXLista } from './RaioXLista';
import { colValor, type Coluna } from './RaioXLinha';
import { fmtValorFino, SEM_CUSTO } from './formato';

const sinal = (n: number) => (n > 0 ? `+${n}` : String(n));

const colunas: Coluna[] = [
  colValor,
  { titulo: 'Saldo Omie', className: 'text-right', render: (i) => i.saldo },
  { titulo: 'Motivo da regra', render: (i) => i.motivo_categoria || '—' },
  { titulo: 'Qtd contada', className: 'text-right', render: (_i, d) => d?.qtd_contada ?? '—' },
  {
    titulo: 'Dif. (un)',
    className: 'text-right',
    render: (i, d) => {
      const df = diffContagem(i, d?.qtd_contada ?? null);
      return <span data-testid={`dif-un-${i.sku_codigo_omie}`}>{df ? sinal(df.dif_un) : '—'}</span>;
    },
  },
  {
    titulo: 'Dif. (R$)',
    className: 'text-right',
    render: (i, d) => {
      const df = diffContagem(i, d?.qtd_contada ?? null);
      if (!df) return '—';
      return df.dif_valor === null ? <span className="text-status-warning">{SEM_CUSTO}</span> : fmtValorFino(df.dif_valor);
    },
  },
];

/** Segmentos 2 (uso e consumo) e 3 (não-mercadoria). Mostra contagem já gravada; edição é o PR 3. */
export function RaioXContagem({ categoria, itens, decisoes }: { categoria: Exclude<Categoria, 'mercadoria'>; itens: ItemRaioX[]; decisoes: Map<number, DecisaoRow> }) {
  return (
    <div className="space-y-2">
      {categoria === 'nao_mercadoria' && (
        <p className="text-xs"><span className="rounded border border-status-warning/40 px-1.5 py-0.5 text-status-warning">reclassificar com contador</span></p>
      )}
      <RaioXLista itens={itens} decisoes={decisoes} colunas={colunas} />
    </div>
  );
}
