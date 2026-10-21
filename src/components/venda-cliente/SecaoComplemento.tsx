import { Skeleton } from '@/components/ui/skeleton';
import type { SugestaoItem } from '@/lib/venda-cliente/sugestoes';
import type { FamiliaComplemento } from '@/lib/venda-cliente/complemento';

const EMPRESA: Record<string, string> = { oben: 'Oben', colacor: 'Colacor', colacor_sc: 'Colacor SC' };

interface Props {
  /** Onda 2 ligada no SERVIDOR (`venda_config.onda_complemento`). Desligada → a seção não existe. */
  ondaLigada: boolean;
  /** Linhas `complemento` do dia (uma por família) — o gerador decide, a ficha só mostra. */
  itens: SugestaoItem[];
  /** SKUs de referência por família (`venda_complemento_comprador`); null = ainda/sem leitura. */
  familias: FamiliaComplemento[] | null;
  loading: boolean;
  erro: boolean;
}

/**
 * Oferecer também: famílias que o cliente ainda não compra e que clientes parecidos compram.
 * Seção própria, sem score comum com Recomprar. Nunca mostra estoque/disponibilidade: não há
 * fonte confiável, e "disponível" fabricado é pior que nada.
 */
export function SecaoComplemento({ ondaLigada, itens, familias, loading, erro }: Props) {
  if (!ondaLigada || itens.length === 0) return null;
  // Família E empresa: o desfecho casa a compra na empresa GRAVADA na linha (Codex P2).
  const porFamilia = new Map((familias ?? []).map((f) => [`${f.familia}|${f.empresa}`, f]));
  return (
    <section aria-labelledby="ficha-complemento">
      <div className="flex items-baseline justify-between">
        <h3 id="ficha-complemento" className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">
          Oferecer também
        </h3>
        <span className="text-2xs text-muted-foreground">clientes parecidos compram</span>
      </div>
      {erro && (
        <p className="mt-1 text-2xs text-status-warning">Não consegui ler os produtos de referência agora.</p>
      )}
      <ul className="mt-2 divide-y divide-border rounded-md border">
        {itens.map((s) => {
          const f = s.familia != null ? porFamilia.get(`${s.familia}|${s.empresa}`) : undefined;
          return (
            <li key={s.id} className="px-3 py-2.5">
              <p className="text-sm font-medium leading-snug">{s.familia}</p>
              <p className="text-2xs text-muted-foreground mt-0.5">{EMPRESA[s.empresa] ?? s.empresa}</p>
              {loading ? (
                <Skeleton className="mt-1.5 h-4 w-2/3" />
              ) : f && f.skus.length > 0 ? (
                <ul className="mt-1 space-y-0.5">
                  {f.skus.map((k) => (
                    <li key={k.omieCodigoProduto} className="text-2xs leading-snug">
                      {k.descricao ?? `Cód. ${k.omieCodigoProduto}`}
                      <span className="text-muted-foreground tabular-nums"> · cód. {k.omieCodigoProduto}</span>
                    </li>
                  ))}
                </ul>
              ) : !erro ? (
                <p className="mt-1 text-2xs text-muted-foreground">Sem produto de referência nesta família.</p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
