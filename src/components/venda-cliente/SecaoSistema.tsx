import type { SugestaoItem } from '@/lib/venda-cliente/sugestoes';

interface Props {
  /** `venda_config.onda_sistema` no SERVIDOR. Desligada → a seção não existe. */
  ondaLigada: boolean;
  /** Linhas `sistema` do dia: só par confirmado pelo founder (o servidor já tira o rejeitado). */
  itens: SugestaoItem[];
}

/**
 * "Falta completar o sistema" (R2 · Entrega 4): o cliente comprou a tinta/verniz e não levou o catalisador ou o
 * diluente que o founder CONFIRMOU como compatível. Nunca é coocorrência — sem confirmação, a linha nem existe.
 */
export function SecaoSistema({ ondaLigada, itens }: Props) {
  if (!ondaLigada || itens.length === 0) return null;
  return (
    <section aria-labelledby="ficha-sistema" data-testid="ficha-sistema">
      <div className="flex items-baseline justify-between">
        <h3 id="ficha-sistema" className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">
          Falta completar o sistema
        </h3>
        <span className="text-2xs text-muted-foreground">par confirmado</span>
      </div>
      <ul className="mt-1.5 space-y-1.5">
        {itens.map((s) => (
          <li key={s.id} className="rounded-md border px-3 py-2">
            <p className="text-sm leading-snug">{s.descricao ?? `SKU ${s.omieCodigoProduto}`}</p>
            <p className="text-2xs text-muted-foreground">
              {s.sistema?.papel === 'catalisador' ? 'Catalisador' : 'Diluente'} do{' '}
              {s.sistema?.baseDescricao ?? `SKU ${s.sistema?.baseOmieCodigoProduto ?? '—'}`}, que o cliente comprou sem ele
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
