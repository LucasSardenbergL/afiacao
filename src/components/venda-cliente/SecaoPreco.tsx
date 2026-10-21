import { Skeleton } from '@/components/ui/skeleton';
import { formatPrecoOuAusente } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { SugestaoItem } from '@/lib/venda-cliente/sugestoes';
import { alvoDaSugestao, type FaixaMargem, type PrecoAlvo } from '@/lib/venda-cliente/preco';
import type { TopProduto } from '@/lib/venda-cliente/historico';

// Faixa QUALITATIVA: nenhum número do qual o custo se deduza (spec §7 Fase 4).
const FAIXA: Record<FaixaMargem, { rotulo: string; classe: string }> = {
  verde:    { rotulo: 'Margem saudável',   classe: 'text-status-success' },
  amarelo:  { rotulo: 'Margem apertada',   classe: 'text-status-warning' },
  vermelho: { rotulo: 'Margem crítica',    classe: 'text-status-error' },
  neutro:   { rotulo: 'Margem sem leitura', classe: 'text-muted-foreground' },
};

function dataCurta(iso: string): string {
  const [a, m, d] = iso.slice(0, 10).split('-');
  return a && m && d ? `${d}/${m}/${a}` : iso;
}

interface Props {
  /** Onda 3 ligada no SERVIDOR (`venda_config.onda_preco`). Desligada → a seção não existe. */
  ondaLigada: boolean;
  /** Linhas `preco` do dia: SKU com repasse aprovado e vigente quando a lista foi gerada. */
  itens: SugestaoItem[];
  /** Repasses vigentes AO VIVO (`venda_preco_alvo_comprador`); null = ainda/sem leitura. */
  alvos: PrecoAlvo[] | null;
  loading: boolean;
  erro: boolean;
  /** Histórico lido na ficha (fallback do último preço); null = ainda/sem leitura. */
  produtos: TopProduto[] | null;
}

/**
 * Preço: último preço praticado e, SÓ quando o repasse aprovado pelo founder segue vigente com o
 * MESMO alvo da linha, o preço alvo e a faixa de margem. Sem repasse confirmado agora (revogado,
 * vencido, já alcançado, substituído, leitura falhou) → só o último preço. Nunca custo, markup ou piso.
 */
export function SecaoPreco({ ondaLigada, itens, alvos, loading, erro, produtos }: Props) {
  if (!ondaLigada || itens.length === 0) return null;
  const historicoPorCodigo = new Map((produtos ?? []).map((p) => [p.codigo, p]));
  return (
    <section aria-labelledby="ficha-preco">
      <div className="flex items-baseline justify-between">
        <h3 id="ficha-preco" className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">
          Preço
        </h3>
        <span className="text-2xs text-muted-foreground">repasse aprovado</span>
      </div>
      {erro && (
        <p className="mt-1 text-2xs text-status-warning">Não consegui confirmar o preço aprovado agora — use o último preço.</p>
      )}
      <ul className="mt-2 divide-y divide-border rounded-md border">
        {itens.map((s) => {
          const cod = s.omieCodigoProduto as number;
          const a = alvoDaSugestao(s, alvos);
          const ultimo = a?.ultimoPreco ?? historicoPorCodigo.get(cod)?.ultimoPreco ?? null;
          return (
            <li key={s.id} className="px-3 py-2.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium leading-snug truncate">{s.descricao ?? `Cód. ${cod}`}</p>
                  <p className="text-2xs text-muted-foreground mt-0.5 tabular-nums">
                    cód. {cod}
                    {a && <> · válido até {dataCurta(a.validoAte)}</>}
                  </p>
                </div>
                <dl className="shrink-0 text-right">
                  <dt className="sr-only">Último preço</dt>
                  <dd className="text-2xs text-muted-foreground tabular-nums" title="Último preço praticado para este cliente">
                    último {formatPrecoOuAusente(ultimo)}
                  </dd>
                  {loading ? (
                    <dd><Skeleton className="mt-1 h-4 w-20 ml-auto" /></dd>
                  ) : a ? (
                    <>
                      <dt className="sr-only">Preço alvo</dt>
                      <dd className="text-sm font-medium tabular-nums">alvo {formatPrecoOuAusente(a.precoAlvo)}</dd>
                      <dt className="sr-only">Faixa de margem</dt>
                      <dd className={cn('text-2xs', FAIXA[a.faixaMargem].classe)}>{FAIXA[a.faixaMargem].rotulo}</dd>
                    </>
                  ) : null}
                </dl>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
