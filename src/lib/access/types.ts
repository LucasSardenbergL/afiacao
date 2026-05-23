// src/lib/access/types.ts
export type AccessPersona =
  | 'vendedor' | 'gestor_comercial' | 'operacao' | 'financeiro' | 'gestao' | 'cliente';

export type GroupTag = 'hunter' | 'farmer' | 'closer';

export type SectionId =
  | 'principal'      // Dashboard + Meu dia
  | 'clientes'       // Customer 360
  | 'vendas'         // Pedidos / Novo / Ferramentas de venda / Telefonia / Chamadas
  | 'operacao'       // Recebimento / Picking / Tintométrico balcão / Produção
  | 'reposicao'
  | 'performance'
  | 'inteligencia'
  | 'financeiro'             // módulo /financeiro
  | 'tintometrico_cockpit'   // cockpit analítico de tintométrico
  | 'gestao_admin'           // Liberar Acessos / Departamentos / Governança / etc.
  | 'docs';                  // Ajuda / Design System / UX Rules
