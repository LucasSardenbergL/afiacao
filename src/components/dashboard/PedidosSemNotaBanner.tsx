import { Link } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { COMPANIES, type Company } from '@/contexts/CompanyContext';
import { formatBRL } from '@/components/customer360/format';
import { usePedidosSemNota, type PedidosSemNotaDados } from '@/hooks/dashboard/usePedidosSemNota';
import type { FaixaSemNota } from '@/lib/dashboard/pedidos-sem-nota';

const ROTULO_FAIXA: Record<FaixaSemNota, string> = {
  '30-90': '30–90 dias',
  '90-180': '90–180 dias',
  '180+': 'mais de 180 dias',
};

/** dd/mm a partir de YYYY-MM-DD (sem Date: evita o deslocamento de fuso). */
function ddmm(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

/**
 * O "quem" do aviso: clientes com pedido sem nota de 30–90 dias — a faixa que ainda pode faturar. É aqui
 * que o CEO decide, pedido a pedido, se fatura ou cancela no Omie. As faixas mais velhas ficam só no total.
 */
function ClientesRecentes({ data, nome }: { data: PedidosSemNotaDados; nome: (a: string) => string }) {
  if (data.clientesRecentes.length === 0) return null;
  const nomeDe = (id: string | null, semNome: string): string => {
    if (!id) return semNome;
    if (data.nomes === null) return 'nome indisponível';
    return data.nomes.get(id) ?? semNome;
  };
  const resto = data.clientesRecentesTotal - data.clientesRecentes.length;
  return (
    <details className="mt-2 group">
      <summary className="cursor-pointer text-2xs font-medium text-foreground hover:underline">
        Ver os {data.clientesRecentesTotal} clientes com pedido de 30–90 dias (os que ainda podem faturar)
      </summary>
      <ul className="mt-2 space-y-1.5">
        {data.clientesRecentes.map((c) => {
          const vendedores = [...new Set(c.pedidos.map((p) => nomeDe(p.vendedorUserId, 'sem vendedor')))];
          return (
            <li key={`${c.account}:${c.customerUserId}`} className="text-2xs leading-snug">
              <Link
                to={`/admin/customers/${c.customerUserId}/360`}
                className="font-medium text-foreground hover:underline"
              >
                {nomeDe(c.customerUserId, 'cliente sem nome no cadastro')}
              </Link>{' '}
              · {nome(c.account)} · <span className="tabular-nums">{formatBRL(c.receita)}</span> ·{' '}
              {c.pedidos.length} {c.pedidos.length === 1 ? 'pedido' : 'pedidos'} · vendedor: {vendedores.join(', ')}
              <div className="text-muted-foreground/80 tabular-nums">
                {c.pedidos
                  .map((p) => `${p.numero ? `nº ${p.numero}` : 'sem nº'} de ${ddmm(p.data)}${p.total != null ? ` (${formatBRL(p.total)})` : ''}`)
                  .join(' · ')}
              </div>
            </li>
          );
        })}
      </ul>
      {resto > 0 && <div className="mt-1 text-2xs text-muted-foreground">+ {resto} clientes menores nesta faixa.</div>}
    </details>
  );
}

/**
 * Aviso MEDIDO dos pedidos de venda que seguem sem nota no Omie há mais de 30 dias (último ano).
 *
 * Substituiu o "Dados de venda parciais" (2026-10-12), que afirmava cobertura parcial e números
 * SUBESTIMADOS — a medição contra o DRE mostrou o contrário: os pedidos cobrem a receita, e ~27% da
 * venda do último ano, nas duas empresas, é pedido aberto no Omie que nunca virou nota. Eles contam
 * como venda (positivação, ranking, crescimento). Decisão do founder: mostrar, não mudar a régua.
 * Diário: docs/historico/status-pedidos-colacor-congelado.md.
 *
 * Estados: carregando → nada; erro → diz que não mediu (nunca some calado); zero medido → nada.
 */
export function PedidosSemNotaBanner() {
  const { data, isLoading, isError } = usePedidosSemNota();

  if (isLoading) return null;
  if (isError || !data) {
    return (
      <Card className="p-3 border-status-warning/40 bg-status-warning-bg/40">
        <div className="flex items-start gap-2.5">
          <AlertTriangle className="w-4 h-4 text-status-warning shrink-0 mt-0.5" />
          <div className="text-2xs text-muted-foreground leading-relaxed">
            <span className="font-medium text-status-warning">Não consegui medir os pedidos sem nota no Omie.</span>{' '}
            Os números abaixo incluem pedidos ainda não faturados. Use como visão operacional,{' '}
            <span className="font-medium">não como base de comissão</span>.
          </div>
        </div>
      </Card>
    );
  }
  if (data.pedidos === 0) return null;

  const nome = (a: string) => COMPANIES[a as Company]?.shortName ?? a;
  return (
    <Card className="p-3 border-status-warning/40 bg-status-warning-bg/40">
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="w-4 h-4 text-status-warning shrink-0 mt-0.5" />
        <div className="text-2xs text-muted-foreground leading-relaxed">
          <span className="font-medium text-status-warning">
            {formatBRL(data.receita)} em {data.pedidos} pedidos sem nota no Omie há mais de 30 dias.
          </span>{' '}
          São pedidos de venda do último ano que não foram faturados nem cancelados — e contam como venda
          nos números do app (positivação, ranking, crescimento).
          {data.porEmpresa.length > 1 && (
            <> {data.porEmpresa.map((e) => `${nome(e.account)}: ${formatBRL(e.receita)} (${e.pedidos})`).join(' · ')}.</>
          )}{' '}
          Use como visão operacional, <span className="font-medium">não como base de comissão</span>.
          <div className="mt-1.5 tabular-nums">
            Por idade:{' '}
            {data.faixas
              .map((f) => `${ROTULO_FAIXA[f.faixa]}: ${formatBRL(f.receita)} (${f.pedidos})`)
              .join(' · ')}
            .
          </div>
          <ClientesRecentes data={data} nome={nome} />
        </div>
      </div>
    </Card>
  );
}
