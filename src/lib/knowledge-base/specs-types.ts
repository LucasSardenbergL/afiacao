/**
 * Domain types pra specs estruturados de produtos + concorrentes.
 *
 * KbProductSpec — 1 row por SKU Sayerlack/Colacor, extraído de boletim técnico
 *   via Claude (edge function kb-extract-specs). Approved by master.
 *
 * KbCompetitor + KbCompetitorProduct — vazios no schema; populados via UI no PR8
 *   (battle cards) ou auto-detect de transcripts (entitiesExtracted do copilot).
 *   Sem hardcode — vendedor expande livremente.
 */

export interface KbProductSpec {
  id: string;
  document_id: string | null;
  product_code: string;
  product_name: string;
  supplier: string;
  product_line: string | null;
  product_category: string | null;

  // Físico-químico
  densidade_g_cm3: number | null;
  solidos_pct: number | null;
  viscosidade_aplicacao_s: number | null;
  viscosidade_copo: string | null;
  brilho_ub: number | null;
  dureza: string | null;

  // Aplicação
  rendimento_m2_por_litro: number | null;
  demaos_recomendadas: number | null;
  gramatura_g_m2_min: number | null;
  gramatura_g_m2_max: number | null;
  pot_life_horas: number | null;
  temp_aplicacao_c_min: number | null;
  temp_aplicacao_c_max: number | null;
  umidade_aplicacao_pct_min: number | null;
  umidade_aplicacao_pct_max: number | null;

  // Compatibilidade
  catalisador_codigo: string | null;
  catalisador_proporcao_pct: number | null;
  diluente_codigo: string | null;
  equipamentos_aplicacao: string[];
  lixa_recomendada: string | null;
  substrato: string[];

  // Secagem
  secagem_manuseio_h: number | null;
  secagem_empilhamento_h: number | null;
  secagem_total_h: number | null;

  // Armazenamento
  validade_dias: number | null;
  temp_armazenamento_c_min: number | null;
  temp_armazenamento_c_max: number | null;

  // Compliance
  certificacoes_aplicaveis: string[];
  isento_metais_pesados: string[];
  isento_substancias: string[];

  // Notas qualitativas
  diferenciais_chave: string[];
  uso_recomendado: string | null;
  publico_alvo: string | null;

  // Metadata da extração
  extraction_confidence: number | null;
  extraction_gaps: string[];
  extracted_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Shape retornado pela edge function kb-extract-specs.
 * Sem ids/timestamps/metadata de auditoria — só os campos extraídos.
 */
export type KbExtractedSpec = Omit<
  KbProductSpec,
  | 'id'
  | 'document_id'
  | 'extracted_by'
  | 'approved_by'
  | 'approved_at'
  | 'created_at'
  | 'updated_at'
>;

export interface KbCompetitor {
  id: string;
  name: string;
  tipo: 'regional' | 'nacional' | 'importado' | null;
  regiao_principal: string | null;
  segmento_atuacao: string[];
  notas_estrategicas: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface KbCompetitorProduct {
  id: string;
  competitor_id: string;
  product_name: string;
  category: string | null;
  rendimento_m2_por_litro: number | null;
  solidos_pct: number | null;
  pot_life_horas: number | null;
  validade_dias: number | null;
  preco_referencia_l: number | null;
  preco_atualizado_em: string | null;
  fonte_preco: 'vendedor' | 'cotacao' | 'site' | 'estimado' | 'detectado_ia' | null;
  pontos_fortes: string[];
  pontos_fracos: string[];
  nosso_equivalente_product_code: string | null;
  argumentos_comparativos: unknown;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}
