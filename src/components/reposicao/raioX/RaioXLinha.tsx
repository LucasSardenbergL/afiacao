import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ROTULOS } from '@/lib/reposicao/raio-x/classificar';
import type { DecisaoRow, Destino, ItemRaioX } from '@/lib/reposicao/raio-x/tipos';
import { fmtValor, SEM_NF } from './formato';

const dataBR = (d: string | null): string => {
  if (!d) return '—';
  const [y, m, dia] = d.slice(0, 10).split('-');
  return `${dia}/${m}/${y}`;
};

/** Giro de 12m. Colacor (q12 null) não tem venda por NF: nunca vira "0". */
export const textoVenda = (i: ItemRaioX): string =>
  i.fora_do_estoque ? '—' : i.q12 === null ? SEM_NF : `${i.q12} un · ${i.ncli ?? 0} cli · últ. ${dataBR(i.ult_venda)}`;

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

/** "Confirmar: <sugestão>" de um item (UX 2): o que o botão faz e o aviso do motor. Ausente = nada a confirmar. */
export interface Confirmacao {
  destino: Destino;
  tiraDoMotor: boolean;
}

/**
 * Coluna de ação. Item pendente com sugestão confirmável: "Confirmar: <destino>" (1 toque grava a decisão) + "Outro
 * destino" (abre o painel). Senão, "Decidir" abre o painel. Um item por toque — nunca confirmar em lote.
 */
export const colDecidir = (
  onDecidir: (i: ItemRaioX) => void,
  confirmar?: { de: (i: ItemRaioX, d: DecisaoRow | undefined) => Confirmacao | null; onConfirmar: (i: ItemRaioX) => void; pendente: boolean },
): Coluna => ({
  titulo: 'Ação',
  className: 'text-right',
  render: (i, d) => {
    const c = confirmar?.de(i, d) ?? null;
    if (!c || !confirmar) {
      return (
        <Button size="touch" variant="outline" aria-label={`Decidir ${i.codigo}`} onClick={() => onDecidir(i)}>
          Decidir
        </Button>
      );
    }
    return (
      <span className="flex flex-col items-stretch gap-1">
        <Button size="touch" aria-label={`Confirmar ${ROTULOS[c.destino]} em ${i.codigo}`} disabled={confirmar.pendente} onClick={() => confirmar.onConfirmar(i)}>
          Confirmar: {ROTULOS[c.destino]}
        </Button>
        {c.tiraDoMotor && <span className="text-xs text-muted-foreground">tira do motor de compra</span>}
        <Button size="touch" variant="outline" aria-label={`Outro destino para ${i.codigo}`} onClick={() => onDecidir(i)}>
          Outro destino
        </Button>
      </span>
    );
  },
});

export const colValor: Coluna = {
  titulo: 'Valor',
  className: 'text-right',
  render: (i) => {
    // Linha histórica (saiu do estoque): o valor é o da FOTO da coorte, dito como tal — nunca "R$ 0" nem valor de hoje.
    if (i.fora_do_estoque) {
      return <span className="text-status-warning">saiu do estoque · foto {fmtValor(i.valor_coorte ?? null)}</span>;
    }
    return i.valor === null ? <span className="text-status-warning">{fmtValor(null)}</span> : fmtValor(i.valor);
  },
};
