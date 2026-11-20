/**
 * "Como a meta foi feita" — decomposição da meta por potencial (previsão × incremento, alavancas em clientes e R$,
 * índice sazonal, vendedoras pela carteira congelada). Recolhido por padrão. Spec:
 * docs/superpowers/specs/2026-11-20-meta-potencial-vendedora-design.md
 */
import { formatBRL, formatarFracaoPct } from '@/components/customer360/format';
import type { MetaAgregada } from '@/lib/dashboard/meta-potencial';

const brl = (v: number | null) => (v == null ? '—' : formatBRL(v));

export function MetaPotencialDetalhe({ m, escopo }: { m: MetaAgregada; escopo: string }) {
  const { alavancas: a, segmentos: s } = m;
  return (
    <details className="rounded-md border border-border/60 px-3 py-2 text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none text-foreground/80">
        Como a meta do mês foi feita{m.status === 'provisoria' ? ' · provisória (congela no dia 3)' : ''}
      </summary>
      <div className="mt-2 space-y-2">
        {m.contasSemMeta.length > 0 && (
          <p className="text-status-warning">
            Sem meta para {m.contasSemMeta.join(', ')}: falta histórico para calibrar (sazonalidade ou retorno).
          </p>
        )}
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 tabular-nums">
          <dt>Previsão (ritmo atual + quem volta sozinho + novos)</dt>
          <dd className="text-right text-foreground">{brl(m.previsao)}</dd>
          <dt>Incremento pela ação da vendedora</dt>
          <dd className="text-right text-foreground">{brl(m.incremento)}</dd>
          <dt className="pl-3">Recuperar {s.n_c} esfriando (61–180d) · +10 p.p.</dt>
          <dd className="text-right">{brl(a.inc_c)}</dd>
          <dt className="pl-3">Reativar {s.n_d} perdidos (181–365d) · +5 p.p.</dt>
          <dd className="text-right">{brl(a.inc_d)}</dd>
          <dt className="pl-3">10% dos {s.n_b} ocasionais comprando 1 mês a mais</dt>
          <dd className="text-right">{brl(a.inc_b)}</dd>
          <dt className="pl-3">+10 estreias de família/mês (cross-sell)</dt>
          <dd className="text-right">{brl(a.inc_cross)}</dd>
          <dt>Índice sazonal (mesmo mês do ano passado)</dt>
          <dd className="text-right">{m.indice == null ? '—' : m.indice.toFixed(2).replace('.', ',')}</dd>
        </dl>
        {m.vendedoras.length > 0 && (
          <table className="w-full tabular-nums">
            <thead>
              <tr className="text-left">
                <th className="font-normal">Carteira</th>
                <th className="font-normal text-right">Meta</th>
                <th className="font-normal text-right">Realizado</th>
                <th className="font-normal text-right">%</th>
              </tr>
            </thead>
            <tbody>
              {m.vendedoras.map((v) => (
                <tr key={v.id ?? 'sem-dono'}>
                  <td>
                    {v.nome}
                    {v.id != null && !v.ativo && <span className="text-status-warning"> · sem vendedora ativa</span>}
                  </td>
                  <td className="text-right">{brl(v.meta)}</td>
                  <td className="text-right">{formatBRL(v.realizado)}</td>
                  <td className="text-right">{v.meta ? formatarFracaoPct(v.realizado / v.meta) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p>
          Base: pedidos válidos do Omie por data do pedido · {escopo} · {s.n_a} recorrentes · carteira pelo dono
          congelado no início do mês · dias úteis pelo calendário de operação.
        </p>
      </div>
    </details>
  );
}
