import { useQuery } from '@tanstack/react-query';
import { useCompany } from '@/contexts/CompanyContext';
import { hojeSP, addDias, inicioMes, periodoMesAnterior } from '@/lib/dashboard/sp-date';
import { somarReceita, contarVendedoresComPedido, variacaoPct } from '@/lib/dashboard/team-kpis';
import { fetchPedidosMTD, fetchPedidosMTDComVendedor } from '@/lib/dashboard/fetch-pedidos-mtd';

export interface TeamKpis {
  receitaHoje: number;
  receitaMes: number;
  receitaMesAnterior: number;
  /** Variação (fração) da receita do mês vs. mesmo período do mês anterior; null sem base. */
  variacaoMes: number | null;
  /** Vendedores distintos (vendedor do Omie) com pedido válido hoje / no mês. */
  vendedoresHoje: number;
  vendedoresMes: number;
  /** Pedidos válidos do mês sem vendedor no Omie (exibidos à parte). */
  pedidosSemVendedorMes: number;
}

/**
 * KPIs de time pro dashboard Master. Escopo de `account` segue o CompanySwitcher
 * (single → .eq; 'all' → grupo inteiro). Receita = sales_orders válidos (staff lê todos).
 * A query de receita (money) LANÇA em erro → tile "—" honesto (nunca R$0 falso);
 * vendedores = vendedor do Omie nos MESMOS pedidos (falha junto com a receita → "—"). Read-only.
 * Spec: docs/superpowers/specs/2026-06-04-master-visao-time-design.md
 */
export function useTeamKpis() {
  const { selection } = useCompany();
  return useQuery({
    queryKey: ['team-kpis', selection],
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    queryFn: async (): Promise<TeamKpis> => {
      const hoje = hojeSP();
      const amanha = addDias(hoje, 1);
      const mesInicio = inicioMes(hoje);
      const prior = periodoMesAnterior(hoje); // mesmo período do mês passado, p/ trend MoM

      const [orders, ordersAnterior] = await Promise.all([
        // Receita do mês paginada (deriva hoje + mês) + vendedor do Omie de cada pedido (RPC — a
        // coluna é fechada para authenticated); lança em erro (money honesto, não R$0).
        fetchPedidosMTDComVendedor(selection, mesInicio, amanha),
        // Mesmo período do mês passado (trend MoM); também paginado + lança em erro.
        fetchPedidosMTD(selection, prior.de, prior.ate),
      ]);

      const receitaHoje = somarReceita(orders, hoje, amanha);
      const receitaMes = somarReceita(orders, mesInicio, amanha);
      const receitaMesAnterior = somarReceita(ordersAnterior, prior.de, prior.ate);
      const variacaoMes = variacaoPct(receitaMes, receitaMesAnterior);

      // Quem VENDEU = vendedor registrado no Omie em cada pedido (mesma leitura paginada da receita).
      // Substitui a "atividade no app" (pedido no app + ligação + visita): o time vende no Omie, e
      // aquelas fontes são 0 linha em prod — o tile mostrava "0 vendedores" para sempre.
      const vendHoje = contarVendedoresComPedido(orders, hoje, amanha);
      const vendMes = contarVendedoresComPedido(orders, mesInicio, amanha);

      return {
        receitaHoje,
        receitaMes,
        receitaMesAnterior,
        variacaoMes,
        vendedoresHoje: vendHoje.vendedores,
        vendedoresMes: vendMes.vendedores,
        pedidosSemVendedorMes: vendMes.pedidosSemVendedor,
      };
    },
  });
}
