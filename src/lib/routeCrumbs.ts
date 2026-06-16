/**
 * Registry de metadados de navegação por rota. Fonte única dos breadcrumbs
 * globais e do "voltar" contextual. Padrões usam sintaxe react-router 6
 * (ex.: "/admin/customers/:id"). A ordem não importa — o matcher casa por
 * prefixo de segmento.
 *
 * Ao criar uma rota nova em App.tsx, adicione a entrada correspondente aqui.
 * Sem entrada, a rota simplesmente não aparece na trilha (degrada limpo).
 */
export type RouteCrumb = {
  /** padrão de rota (react-router) */
  path: string;
  /** rótulo exibido no breadcrumb (pt-BR) */
  crumb: string;
  /** se setado, página de detalhe/criação ganha botão "voltar" para cá */
  backTo?: string;
  /** rótulo do botão voltar (default: o crumb do pai) */
  backLabel?: string;
};

export const ROUTE_CRUMBS: RouteCrumb[] = [
  { path: "/", crumb: "Dashboard" },

  // Principal
  { path: "/admin/customers", crumb: "Clientes" },
  { path: "/admin/customers/:id", crumb: "Detalhe do cliente", backTo: "/admin/customers", backLabel: "Clientes" },

  // Vendas
  { path: "/sales", crumb: "Pedidos" },
  { path: "/sales/new", crumb: "Novo pedido", backTo: "/sales", backLabel: "Pedidos" },

  // Reposição (sessão)
  { path: "/admin/reposicao/sessao", crumb: "Reposição" },
  { path: "/admin/reposicao/sessao/mercado", crumb: "Mercado" },
  { path: "/admin/reposicao/sessao/parametros", crumb: "Parâmetros" },
  { path: "/admin/reposicao/sessao/pedidos", crumb: "Pedidos" },
  { path: "/admin/reposicao/sessao/aplicacao", crumb: "Aplicação Omie" },
  { path: "/admin/reposicao/sessao/confirmacao", crumb: "Confirmação" },

  // Financeiro
  { path: "/financeiro/cockpit", crumb: "Financeiro" },

  // Estoque
  { path: "/admin/estoque/recebimento", crumb: "Recebimento" },
  { path: "/admin/estoque/picking", crumb: "Picking & Estoque" },
];
