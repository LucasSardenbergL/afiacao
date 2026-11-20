export const ZONES = ['vendas', 'estoque', 'reposicao', 'financeiro', 'tintometrico', 'sistema'] as const;
export type ZoneId = typeof ZONES[number];

export const PERSONAS = [
  'vendedor',
  'gestor',
  'comprador',
  'estoque',
  'financeiro',
  'tintometrico',
  'master',
  'geral',
] as const;
export type Persona = typeof PERSONAS[number];

export interface PersonaConfig {
  /** Ordem dos cards no CockpitGrid pra essa persona. */
  zoneOrder: ZoneId[];
  /** Zonas que contribuem candidatos pro PriorityCard. */
  priorityZones: ZoneId[];
  /** Label humano. */
  label: string;
  /** Caption mostrada no chip ("Recomendado pra ..."). */
  description: string;
}

export const PERSONA_CONFIG: Record<Persona, PersonaConfig> = {
  vendedor: {
    zoneOrder:     ['vendas', 'sistema', 'reposicao', 'estoque', 'financeiro', 'tintometrico'],
    priorityZones: ['vendas', 'sistema'],
    label: 'Vendedor',
    description: 'Pipeline de vendas, carteira de clientes e agenda do dia.',
  },
  gestor: {
    zoneOrder:     ['vendas', 'financeiro', 'sistema', 'reposicao', 'estoque', 'tintometrico'],
    priorityZones: ['vendas', 'financeiro', 'sistema'],
    label: 'Gestor comercial',
    description: 'Meta, performance da equipe, saúde financeira.',
  },
  comprador: {
    zoneOrder:     ['reposicao', 'estoque', 'sistema', 'vendas', 'financeiro', 'tintometrico'],
    priorityZones: ['reposicao', 'estoque'],
    label: 'Comprador',
    description: 'Sugestões de compra, alertas de mercado, recebimento.',
  },
  estoque: {
    zoneOrder:     ['estoque', 'reposicao', 'vendas', 'sistema', 'financeiro', 'tintometrico'],
    priorityZones: ['estoque', 'reposicao'],
    label: 'Estoque',
    description: 'Picking FEFO, NF a conferir, recebimentos do dia.',
  },
  financeiro: {
    zoneOrder:     ['financeiro', 'vendas', 'sistema', 'reposicao', 'estoque', 'tintometrico'],
    priorityZones: ['financeiro'],
    label: 'Financeiro',
    description: 'Aging, conciliação, fluxo projetado, fechamento.',
  },
  tintometrico: {
    zoneOrder:     ['tintometrico', 'estoque', 'vendas', 'sistema', 'reposicao', 'financeiro'],
    priorityZones: ['tintometrico', 'estoque'],
    label: 'Tintométrico',
    description: 'Fórmulas, SKUs Oben, importações e erros.',
  },
  // Master = CEO: o alerta do topo só disputa entre zonas com decisão de dinheiro (aging, orçamento
  // parado, compra aguardando aprovação). Erro de importação tintométrica (score 95) e NF parada
  // continuam nas zonas, mas não tomam o lugar de uma decisão (parecer Codex 2026-11-20).
  master: {
    zoneOrder:     ['vendas', 'financeiro', 'reposicao', 'estoque', 'tintometrico', 'sistema'],
    priorityZones: ['financeiro', 'vendas', 'reposicao'],
    label: 'Master',
    description: 'Visão do CEO: resultado do grupo primeiro, operação depois.',
  },
  geral: {
    zoneOrder:     ['vendas', 'estoque', 'reposicao', 'financeiro', 'tintometrico', 'sistema'],
    priorityZones: ['vendas', 'estoque', 'reposicao', 'financeiro', 'tintometrico', 'sistema'],
    label: 'Geral',
    description: 'Sem persona definida — todos os módulos com peso igual.',
  },
};
