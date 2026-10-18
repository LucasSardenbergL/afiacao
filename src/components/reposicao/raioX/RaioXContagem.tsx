import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { lerNumero, MSG_NUMERO_INVALIDO } from '@/lib/reposicao/raio-x/decisao';
import { diffContagem } from '@/lib/reposicao/raio-x/saidas';
import type { Categoria, DecisaoRow, Empresa, ItemRaioX } from '@/lib/reposicao/raio-x/tipos';
import { RaioXLista } from './RaioXLista';
import { colDecidir, colValor, type Coluna } from './RaioXLinha';
import { fmtValorFino, SEM_CUSTO } from './formato';
import { useRaioXMutacoes } from './useRaioXMutacoes';

const sinal = (n: number) => (n > 0 ? `+${n}` : String(n));
const paraTexto = (n: number | null | undefined) => (n == null ? '' : String(n).replace('.', ','));

/** Qtd contada editável. Vazio limpa a contagem; inválido mostra erro e não envia (vírgula pt-BR). */
function CampoContagem({ item, gravada, contar, pendente }: {
  item: ItemRaioX;
  gravada: number | null;
  contar: (sku: number, qtd: number | null) => Promise<boolean>;
  pendente: boolean;
}) {
  const [texto, setTexto] = useState(paraTexto(gravada));
  const [erro, setErro] = useState(false);
  const salvar = () => {
    const r = lerNumero(texto);
    if (r.erro) {
      setErro(true);
      return;
    }
    setErro(false);
    void contar(item.sku_codigo_omie, r.valor);
  };
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-1">
        <Input
          aria-label={`Qtd contada ${item.codigo}`}
          aria-invalid={erro}
          inputMode="decimal"
          className="h-11 w-24 text-right"
          value={texto}
          onChange={(e) => {
            setErro(false);
            setTexto(e.target.value);
          }}
          onKeyDown={(e) => e.key === 'Enter' && salvar()}
        />
        <Button size="touch" variant="outline" aria-label={`Salvar contagem ${item.codigo}`} disabled={pendente} onClick={salvar}>
          OK
        </Button>
      </div>
      {erro && <p className="text-xs text-status-error">{MSG_NUMERO_INVALIDO}</p>}
    </div>
  );
}

const colunasDif: Coluna[] = [
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

/** Segmentos 2 (uso e consumo) e 3 (não-mercadoria): contagem física editável e "Decidir" por linha. */
export function RaioXContagem({ empresa, categoria, itens, decisoes, onDecidir }: {
  empresa: Empresa;
  categoria: Exclude<Categoria, 'mercadoria'>;
  itens: ItemRaioX[];
  decisoes: Map<number, DecisaoRow>;
  onDecidir: (i: ItemRaioX) => void;
}) {
  const { contar, pendente } = useRaioXMutacoes(empresa);
  const colunas = useMemo<Coluna[]>(
    () => [
      colValor,
      { titulo: 'Saldo Omie', className: 'text-right', render: (i) => i.saldo },
      { titulo: 'Motivo da regra', render: (i) => i.motivo_categoria || '—' },
      {
        titulo: 'Qtd contada',
        className: 'text-right',
        render: (i, d) => (
          // key = valor gravado: após salvar e reler, o campo reflete o banco
          <CampoContagem key={`${empresa}-${i.sku_codigo_omie}-${d?.qtd_contada ?? ''}`} item={i} gravada={d?.qtd_contada ?? null} contar={contar} pendente={pendente} />
        ),
      },
      ...colunasDif,
      colDecidir(onDecidir),
    ],
    [empresa, contar, pendente, onDecidir],
  );
  return (
    <div className="space-y-2">
      {categoria === 'nao_mercadoria' && (
        <p className="text-xs"><span className="rounded border border-status-warning/40 px-1.5 py-0.5 text-status-warning">reclassificar com contador</span></p>
      )}
      <RaioXLista itens={itens} decisoes={decisoes} colunas={colunas} />
    </div>
  );
}
