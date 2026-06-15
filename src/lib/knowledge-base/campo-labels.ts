/**
 * Rótulos pt-BR e formatação dos campos técnicos de kb_product_specs / kb_product_spec_versions.
 * Usado pelo diff de versões e pela aba de completude (Fase B1). Apresentacional, read-only.
 */

/** Rótulo amigável por campo técnico. Espelha os campos de KbProductSpec (subset técnico). */
export const CAMPO_LABEL: Record<string, string> = {
  product_name: 'Nome',
  product_line: 'Linha',
  product_category: 'Categoria',
  densidade_g_cm3: 'Densidade (g/cm³)',
  solidos_pct: 'Sólidos (%)',
  viscosidade_aplicacao_s: 'Viscosidade (s)',
  viscosidade_copo: 'Copo de viscosidade',
  brilho_ub: 'Brilho (UB)',
  dureza: 'Dureza',
  rendimento_m2_por_litro: 'Rendimento (m²/L)',
  demaos_recomendadas: 'Demãos recomendadas',
  gramatura_g_m2_min: 'Gramatura mín. (g/m²)',
  gramatura_g_m2_max: 'Gramatura máx. (g/m²)',
  pot_life_horas: 'Pot life (h)',
  temp_aplicacao_c_min: 'Temp. aplicação mín. (°C)',
  temp_aplicacao_c_max: 'Temp. aplicação máx. (°C)',
  umidade_aplicacao_pct_min: 'Umidade aplicação mín. (%)',
  umidade_aplicacao_pct_max: 'Umidade aplicação máx. (%)',
  catalisador_codigo: 'Catalisador',
  catalisador_proporcao_pct: 'Catalisador (%)',
  diluente_codigo: 'Diluente',
  equipamentos_aplicacao: 'Equipamentos de aplicação',
  lixa_recomendada: 'Lixa recomendada',
  substrato: 'Substrato',
  secagem_manuseio_h: 'Secagem ao manuseio (h)',
  secagem_empilhamento_h: 'Secagem p/ empilhamento (h)',
  secagem_total_h: 'Secagem total (h)',
  validade_dias: 'Validade (dias)',
  temp_armazenamento_c_min: 'Temp. armazenamento mín. (°C)',
  temp_armazenamento_c_max: 'Temp. armazenamento máx. (°C)',
  certificacoes_aplicaveis: 'Certificações aplicáveis',
  isento_metais_pesados: 'Isento de metais pesados',
  isento_substancias: 'Isento de substâncias',
  diferenciais_chave: 'Diferenciais-chave',
  uso_recomendado: 'Uso recomendado',
  publico_alvo: 'Público-alvo',
};

/** Rótulo do campo; fallback ao nome cru (nunca quebra a UI). */
export function rotularCampo(campo: string): string {
  return CAMPO_LABEL[campo] ?? campo;
}

/** Formata um valor de campo pra exibição. Array → "a · b"; vazio → "—"; resto → String. */
export function formatarValorCampo(v: unknown): string {
  if (Array.isArray(v)) return v.length === 0 ? '—' : v.map(String).join(' · ');
  if (v == null || v === '') return '—';
  return String(v);
}

const CHANGE_TYPE_LABEL: Record<string, string> = {
  initial: 'Versão inicial',
  bulletin_revision: 'Boletim revisado',
  correction: 'Correção',
  data_completion: 'Dados completados',
};

/** Rótulo do tipo de mudança da versão; fallback ao valor cru. */
export function rotularChangeType(t: string): string {
  return CHANGE_TYPE_LABEL[t] ?? t;
}
