import { useMemo } from 'react';
import { ROTULOS } from '@/lib/reposicao/raio-x/classificar';
import { medir } from '@/lib/reposicao/raio-x/medir';
import type { Empresa, LinhaMedicao } from '@/lib/reposicao/raio-x/tipos';
import { fmtReais } from './formato';

const META_CAIXA = 60000;
const META_TEXTO = 'R$ 60.000';
const SEM_DADO = '—';

interface Props {
  linhas: LinhaMedicao[] | undefined;
  isLoading: boolean;
  erro: Error | null;
  empresa: Empresa;
  /** sku_codigo_omie → código legível (só para exibir a contradição). */
  codigos: Map<number, string>;
  onFiltrarSku: (sku: number) => void;
}

// Ausente ≠ zero: null vira "—", nunca "R$ 0".
const fmt = (v: number | null): string => (v === null ? SEM_DADO : fmtReais(v));

function Linha({ rotulo, valor, nota }: { rotulo: string; valor: number | null; nota?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span>
        {rotulo}
        {nota && <span className="block text-xs text-muted-foreground">{nota}</span>}
      </span>
      <span className="font-medium tabular-nums">{fmt(valor)}</span>
    </div>
  );
}

/** Caixa liberado pelas decisões do Raio-X. NUNCA soma com "R$ que distorce o DIO" (outro bloco, no placar). */
export function RaioXCaixaLiberado({ linhas, isLoading, erro, empresa, codigos, onFiltrarSku }: Props) {
  const m = useMemo(() => (linhas ? medir(linhas, empresa) : null), [linhas, empresa]);

  if (erro) {
    const semPermissao = (erro as { code?: string }).code === '42501';
    return (
      <div role="alert" className="rounded-md border border-status-error/30 bg-status-error/5 p-4 text-sm">
        {semPermissao
          ? 'Caixa liberado indisponível: sem permissão para ver custo.'
          : 'Não foi possível medir o caixa liberado. Recarregue a página; se persistir, avise o time.'}
      </div>
    );
  }
  if (isLoading || !m) {
    return <div role="status" className="rounded-md border p-4 text-sm text-muted-foreground">Medindo o caixa liberado…</div>;
  }

  const oben = empresa === 'oben';
  const pct = Math.min(100, Math.round((m.caixa_liberado / META_CAIXA) * 100));

  return (
    <section aria-label="Caixa liberado" className="space-y-3 rounded-md border p-4">
      <div className="space-y-2">
        <div className="text-sm text-muted-foreground">Caixa liberado</div>
        <div className="font-display text-xl">
          {fmtReais(m.caixa_liberado)} <span className="text-sm text-muted-foreground">de {META_TEXTO}</span>
        </div>
        <div
          role="progressbar"
          aria-label="Caixa liberado contra a meta"
          aria-valuemin={0}
          aria-valuemax={META_CAIXA}
          aria-valuenow={Math.min(m.caixa_liberado, META_CAIXA)}
          className="h-2 w-full overflow-hidden rounded bg-muted"
        >
          <div className="h-full bg-status-success" style={{ width: `${pct}%` }} />
        </div>
        {!oben && (
          <p className="text-xs text-muted-foreground">
            Colacor: sem NF para atribuir a saída; só o crédito de troca conta como caixa.
          </p>
        )}
      </div>

      <div className="space-y-1">
        {oben && <Linha rotulo="Vendido" valor={m.vendido} />}
        {oben && <Linha rotulo="Liquidado (preço < 90% do médio 12m)" valor={m.liquidado} />}
        <Linha rotulo="Trocado (crédito informado)" valor={m.trocado} />
        {!oben && <Linha rotulo="Saiu do estoque (sem NF para atribuir: venda, consumo ou baixa?)" valor={m.saiu_sem_nf} nota="Não entra no caixa liberado." />}
        <Linha rotulo="Ainda parado" valor={m.parado} />
        {oben && <Linha rotulo="Recomprado" valor={m.recomprado} nota={m.compras_visiveis ? undefined : 'sem permissão para ver compras'} />}
      </div>

      {m.sem_medicao.length > 0 && (
        <p role="status" className="text-xs text-status-warning">
          {m.sem_medicao.length} SKU(s) sem medição ({fmtReais(m.sem_medicao_valor)} na foto
          {m.sem_medicao_sem_custo_n > 0 ? `, mais ${m.sem_medicao_sem_custo_n} sem custo` : ''}) — os números acima são piso.
        </p>
      )}

      {m.contradicoes.length > 0 && (
        <div className="space-y-1">
          <div className="text-sm font-medium text-status-warning">Decidiu tirar do estoque e houve pedido de compra depois</div>
          <ul className="space-y-1">
            {m.contradicoes.map((c, idx) => (
              <li key={`${c.sku_codigo_omie}-${c.pedido_em}-${idx}`}>
                <button
                  type="button"
                  className="text-left text-sm underline-offset-2 hover:underline"
                  onClick={() => onFiltrarSku(c.sku_codigo_omie)}
                >
                  {codigos.get(c.sku_codigo_omie) ?? `SKU ${c.sku_codigo_omie}`} · {ROTULOS[c.destino] ?? c.destino} · pedido em {c.pedido_em.slice(0, 10)}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
