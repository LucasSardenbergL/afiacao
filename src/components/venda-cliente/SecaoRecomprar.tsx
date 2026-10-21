import { formatPrecoOuAusente } from '@/lib/format';
import type { SugestaoItem } from '@/lib/venda-cliente/sugestoes';
import type { TopProduto } from '@/lib/venda-cliente/historico';

const EMPRESA: Record<string, string> = { oben: 'Oben', colacor: 'Colacor' };

function diasDesde(iso: string, agora: Date): number | null {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((agora.getTime() - t) / 86_400_000));
}

interface Props {
  itens: SugestaoItem[];
  /** Todos os SKUs do histórico lido (`useHistoricoCompras().produtos`); null = ainda/sem leitura. */
  produtos: TopProduto[] | null;
  historicoErro: boolean;
  agora?: Date;
}

/**
 * Recomprar: o que o cliente costuma comprar e está atrasado (decidido no servidor).
 * Último preço e "última compra há N dias" vêm do histórico de pedidos — ausente vira "—",
 * nunca R$ 0,00. Sem custo, sem margem: a farmer nunca vê custo.
 */
export function SecaoRecomprar({ itens, produtos, historicoErro, agora = new Date() }: Props) {
  const porCodigo = new Map((produtos ?? []).map((p) => [p.codigo, p]));
  return (
    <section aria-labelledby="ficha-recomprar">
      <div className="flex items-baseline justify-between">
        <h3 id="ficha-recomprar" className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">
          Recomprar
        </h3>
        <span className="text-2xs text-muted-foreground tabular-nums">{itens.length} {itens.length === 1 ? 'item' : 'itens'}</span>
      </div>
      {historicoErro && (
        <p className="mt-1 text-2xs text-status-warning">Não consegui ler o histórico — último preço indisponível agora.</p>
      )}
      <ul className="mt-2 divide-y divide-border rounded-md border">
        {itens.map((s) => {
          const h = s.omieCodigoProduto != null ? porCodigo.get(s.omieCodigoProduto) : undefined;
          const dias = h ? diasDesde(h.ultimaData, agora) : null;
          return (
            <li key={s.id} className="px-3 py-2.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium leading-snug truncate">
                    {s.descricao ?? h?.nome ?? `Cód. ${s.omieCodigoProduto ?? '?'}`}
                  </p>
                  <p className="text-2xs text-muted-foreground mt-0.5">
                    {EMPRESA[s.empresa] ?? s.empresa}
                    {s.omieCodigoProduto != null && <span className="tabular-nums"> · cód. {s.omieCodigoProduto}</span>}
                    {dias != null && <span className="tabular-nums"> · última compra há {dias} {dias === 1 ? 'dia' : 'dias'}</span>}
                    {s.cadenciaDias != null && s.cadenciaDias > 0 && (
                      <span className="tabular-nums"> · compra a cada ~{s.cadenciaDias} {s.cadenciaDias === 1 ? 'dia' : 'dias'}</span>
                    )}
                  </p>
                </div>
                <dl className="shrink-0 text-right">
                  <dt className="sr-only">Quantidade sugerida</dt>
                  <dd className="text-sm font-medium tabular-nums">{s.qtdRef != null ? `${s.qtdRef.toLocaleString('pt-BR')} un` : '—'}</dd>
                  <dt className="sr-only">Último preço</dt>
                  <dd className="text-2xs text-muted-foreground tabular-nums" title="Último preço praticado para este cliente">
                    {formatPrecoOuAusente(h?.ultimoPreco ?? null)}
                  </dd>
                </dl>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
