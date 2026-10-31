import { useMemo } from 'react';
import type { DecisaoRow, ItemRaioX } from '@/lib/reposicao/raio-x/tipos';
import { fornecedorEfetivo } from '@/lib/reposicao/raio-x/decisao';
import { custoEsperarMensal, pisoVigente, situacaoPlano, type SituacaoPlano } from '@/lib/reposicao/raio-x/execucao';
import { fmtReais } from './formato';
import { RaioXLista } from './RaioXLista';
import { colDecidir, colValor, rotuloDestino, textoVenda, type Coluna } from './RaioXLinha';

const colunasBase: Coluna[] = [
  colValor,
  { titulo: 'Saldo', className: 'text-right', render: (i) => `${i.saldo} ${i.unidade_estoque ?? ''}`.trim() },
  { titulo: 'Venda 12m', render: (i) => textoVenda(i) },
  { titulo: 'Fornecedor', render: (i, d) => fornecedorEfetivo(i, d) ?? '—' },
  {
    titulo: 'Destino',
    render: (i, d) => {
      const r = rotuloDestino(i, d);
      return (
        <span className="flex flex-col gap-0.5">
          <span className={r.decidido ? 'text-status-success' : 'text-muted-foreground'} title={i.motivo_destino}>{r.texto}</span>
          {i.alerta_recompra && <span className="text-xs text-status-warning">{i.alerta_recompra}</span>}
          {i.entrou_no_top && <span className="text-xs text-muted-foreground">entrou no Top depois do congelamento</span>}
        </span>
      );
    },
  },
];

function TextoSituacao({ s, responsavel }: { s: SituacaoPlano; responsavel: string | null }) {
  switch (s.tipo) {
    case 'concluido': return <span className="text-status-success">executado</span>;
    case 'vencido': return <span className="text-status-error">vencido há {s.dias} dia{s.dias === 1 ? '' : 's'}</span>;
    case 'sem_responsavel': return <span className="text-status-warning">sem responsável</span>;
    case 'sem_prazo': return <span className="text-muted-foreground">{responsavel} · sem prazo</span>;
    case 'no_prazo': return <span className="text-muted-foreground">{responsavel} · {s.dias === 0 ? 'vence hoje' : `${s.dias} dia${s.dias === 1 ? '' : 's'}`}</span>;
  }
}

/** Custo de esperar (sem custo/taxa: "—", nunca R$ 0) + situação do plano + selo "sem piso" no liquidar. */
const colExecucao = (taxa: number | null, hoje: string, nomes: Map<string, string>): Coluna => ({
  titulo: 'Execução',
  render: (i, d) => {
    const custo = custoEsperarMensal(i.valor, taxa);
    const s = situacaoPlano(d, hoje);
    const responsavel = d?.responsavel ? (nomes.get(d.responsavel) ?? 'responsável') : null;
    return (
      <span className="flex flex-col gap-0.5 text-xs">
        <span className="text-muted-foreground">{custo === null ? '—' : `~${fmtReais(custo)}/mês parado`}</span>
        {s && <TextoSituacao s={s} responsavel={responsavel} />}
        {d?.destino === 'liquidar' && pisoVigente(d) === null && <span className="text-status-warning">sem piso</span>}
      </span>
    );
  },
});

/** Segmento 1: mercadoria parada, por R$. "Decidir" abre o Sheet de decisão. */
export function RaioXMercadoria({ itens, decisoes, onDecidir, taxa, hoje, nomes }: {
  itens: ItemRaioX[];
  decisoes: Map<number, DecisaoRow>;
  onDecidir: (i: ItemRaioX) => void;
  /** taxa anual de custo de capital; null = sem taxa (custo não exibido). */
  taxa: number | null;
  /** 'YYYY-MM-DD' (SP) */
  hoje: string;
  nomes: Map<string, string>;
}) {
  const colunas = useMemo(
    () => [...colunasBase, colExecucao(taxa, hoje, nomes), colDecidir(onDecidir)],
    [onDecidir, taxa, hoje, nomes],
  );
  return <RaioXLista itens={itens} decisoes={decisoes} colunas={colunas} />;
}
