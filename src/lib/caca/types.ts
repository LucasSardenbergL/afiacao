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
