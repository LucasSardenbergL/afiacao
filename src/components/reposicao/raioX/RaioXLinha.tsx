import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { ROTULOS } from '@/lib/reposicao/raio-x/classificar';
import type { DecisaoRow, ItemRaioX } from '@/lib/reposicao/raio-x/tipos';
import { fmtValor, SEM_NF } from './formato';

const dataBR = (d: string | null): string => {
  if (!d) return '—';
  const [y, m, dia] = d.slice(0, 10).split('-');
  return `${dia}/${m}/${y}`;
};

/** Giro de 12m. Colacor (q12 null) não tem venda por NF: nunca vira "0". */
export const textoVenda = (i: ItemRaioX): string =>
  i.q12 === null ? SEM_NF : `${i.q12} un · ${i.ncli ?? 0} cli · últ. ${dataBR(i.ult_venda)}`;

export function rotuloDestino(i: ItemRaioX, d: DecisaoRow | undefined): { texto: string; decidido: boolean } {
  if (d?.destino) return { texto: ROTULOS[d.destino] ?? d.destino, decidido: true };
  return { texto: i.destino_sugerido ? `${ROTULOS[i.destino_sugerido] ?? i.destino_sugerido} (sugerido)` : '—', decidido: false };
}

/** Top 5 clientes por quantidade. Sem lista (Colacor) → aviso de ausência, não "nenhum cliente". */
function TopClientes({ item }: { item: ItemRaioX }) {
  if (item.clientes === null) return <p className="text-xs text-muted-foreground">{SEM_NF}</p>;
  const top = [...item.clientes].sort((a, b) => b.qtd - a.qtd).slice(0, 5);
  if (top.length === 0) return <p className="text-xs text-muted-foreground">Nenhum cliente comprou nos últimos 12 meses.</p>;
  return (
    <ul className="space-y-0.5 text-xs">
      {top.map((c) => (
        <li key={c.nome} className="flex justify-between gap-3">
          <span>{c.nome}</span>
          <span className="text-muted-foreground">{c.qtd} un · últ. {dataBR(c.ult)}</span>
        </li>
      ))}
    </ul>
  );
}

export interface Coluna {
  titulo: string;
  render: (i: ItemRaioX, d: DecisaoRow | undefined) => ReactNode;
  className?: string;
}

function useAberto() {
  const [aberto, setAberto] = useState(false);
  return { aberto, alternar: () => setAberto((a) => !a) };
}

const nome = (i: ItemRaioX) => i.descricao ?? i.codigo;

export function LinhaTabela({ item, decisao, colunas }: { item: ItemRaioX; decisao: DecisaoRow | undefined; colunas: Coluna[] }) {
  const { aberto, alternar } = useAberto();
  return (
    <>
      <tr className="border-t">
        <td className="p-2">
          <button type="button" className="flex items-center gap-1 text-left" aria-expanded={aberto} onClick={alternar}>
            {aberto ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
            <span><span className="font-mono text-xs text-muted-foreground">{item.codigo}</span> {nome(item)}</span>
          </button>
        </td>
        {colunas.map((c) => (
          <td key={c.titulo} className={`p-2 ${c.className ?? ''}`}>{c.render(item, decisao)}</td>
        ))}
      </tr>
      {aberto && (
        <tr className="bg-muted/30">
          <td colSpan={colunas.length + 1} className="p-3"><TopClientes item={item} /></td>
        </tr>
      )}
    </>
  );
}

export function CartaoItem({ item, decisao, colunas }: { item: ItemRaioX; decisao: DecisaoRow | undefined; colunas: Coluna[] }) {
  const { aberto, alternar } = useAberto();
  return (
    <li className="rounded-md border p-3 space-y-2">
      <button type="button" className="flex w-full items-center gap-1 text-left min-h-11" aria-expanded={aberto} onClick={alternar}>
        {aberto ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
        <span className="font-medium">{nome(item)}</span>
      </button>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        {colunas.map((c) => (
          <div key={c.titulo}>
            <dt className="text-muted-foreground">{c.titulo}</dt>
            <dd>{c.render(item, decisao)}</dd>
          </div>
        ))}
      </dl>
      {aberto && <TopClientes item={item} />}
    </li>
  );
}

export const colValor: Coluna = {
  titulo: 'Valor',
  className: 'text-right',
  render: (i) => (i.valor === null ? <span className="text-status-warning">{fmtValor(null)}</span> : fmtValor(i.valor)),
};
