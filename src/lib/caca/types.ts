/**
 * Tipos do motor de look-alike "Caça" (Frente B).
 *
 * Grão = (documento × empresa-alvo).
 * Degradação honesta: dado ausente ≠ zero.
 * null = dado indisponível; [] = frio (nunca comprou o grupo de famílias).
 */

export type EmpresaAlvo = 'oben' | 'colacor' | 'colacor_sc';
export type SaborCaca = 'cross_empresa' | 'dormente' | 'frio';
export type DimensaoCaca = 'regiao' | 'ramo' | 'ticket' | 'familias';

/** Features de um candidato a ser "caçado". */
export interface CandidatoFeatures {
  /** CNPJ/CPF normalizado (só dígitos). */
  documento: string;
  /** Empresa para a qual queremos trazer o cliente. */
  empresaAlvo: EmpresaAlvo;
  /** "DIVINOPOLIS-MG" ou null quando desconhecida. */
  cidadeUf: string | null;
  /** Ramo derivado do mix ou CNAE; null = "sem ramo conhecido". */
  ramo: string | null;
  /** Ticket médio histórico (R$); null = candidato frio (nunca comprou nada no grupo). */
  ticketFaixa: number | null;
  /** Famílias de produtos compradas; [] = frio. */
  familias: string[];
  /** Já compra em alguma outra empresa do grupo (cross-venda). */
  compraEmOutraEmpresa: boolean;
  /** Já compra na empresa-alvo específica → NÃO é candidato. */
  compraNaEmpresaAlvo: boolean;
  /**
   * Dias desde a última compra em QUALQUER empresa do grupo.
   * null = nunca comprou (frio absoluto).
   */
  ultimaCompraGrupoDias: number | null;
  /**
   * Atraso relativo vs ciclo próprio de compra (boost quando positivo).
   * null = sem histórico suficiente para calcular.
   */
  atrasoRelativo: number | null;
}

/**
 * Linha crua da view SQL `v_caca_compradores` (fatos de quem JÁ compra).
 * Grão = (documento × empresa). O caller filtra por empresa antes de selecionar.
 */
export interface CompradorRow {
  documento: string;
  empresa: EmpresaAlvo; // 'oben' | 'colacor'
  cidade_uf: string | null;
  ramo: string | null;
  ticket_faixa: number | null;
  familias: string[];
  volume: number;
  n_pedidos: number;
  recencia_dias: number;
  lucro_proxy: number | null;
  lucro_cobertura: number;
}

/**
 * Linha crua da view SQL `v_caca_candidatos` (alvos a serem "caçados").
 * Grão = (documento × empresa-alvo).
 */
export interface CandidatoRow {
  documento: string;
  empresa_alvo: EmpresaAlvo;
  cidade_uf: string | null;
  ramo: string | null;
  ticket_faixa: number | null;
  familias: string[];
  compra_em_outra_empresa: boolean;
  ultima_compra_grupo_dias: number | null;
  nome: string | null;
  telefone: string | null;
  cliente_user_id: string;
}

/** Snapshot de um "melhor cliente" para construção do perfil. */
export interface MelhorCliente {
  documento: string;
  cidadeUf: string | null;
  ramo: string | null;
  ticketFaixa: number | null;
  familias: string[];
}

/**
 * Perfil estatístico dos melhores clientes, expressado como lifts
 * (freq nos melhores / freq na base) para cada valor de dimensão.
 */
export interface PerfilMelhores {
  /** lift por cidadeUf (ex: { "DIVINOPOLIS-MG": 2.1 }). */
  regiaoLift: Record<string, number>;
  /** lift por ramo (ignora null). */
  ramoLift: Record<string, number>;
  /** lift por família de produto. */
  familiaLift: Record<string, number>;
  /** Mediana do ticketFaixa dos melhores (ignora null). */
  ticketMediano: number | null;
  /** Número de melhores clientes usados no cálculo. */
  nMelhores: number;
}

/** Resultado final de rankeamento para um candidato. */
export interface CacaResultado {
  features: CandidatoFeatures;
  sabor: SaborCaca;
  score: number;
  confianca: number;
  dimensoesUsadas: DimensaoCaca[];
  /** Razões interpretáveis em pt-BR para o vendedor. */
  porque: string[];
  /** Posição final (1 = melhor). */
  rankFinal: number;
}

/**
 * Versão enriquecida do resultado para exibição na UI.
 * Adiciona os dados de apresentação que vêm da camada de dados (hook/query).
 */
export interface CacaCandidatoDisplay extends CacaResultado {
  /** Razão social ou nome fantasia; null = sem nome disponível. */
  nome: string | null;
  /** Telefone em qualquer formato (dígitos ou E.164); null = sem telefone. */
  telefone: string | null;
  /** User ID no app (vinculado); null = cliente não possui conta no app. */
  clienteUserId: string | null;
}
