// src/lib/financeiro/dre-helpers.ts
// Onda 3a — DRE v2 estrutural (regime-aware). Módulo puro, espelhado verbatim no
// engine Deno supabase/functions/omie-financeiro/index.ts (calcularDRE).

export type RegimeTributario = 'simples' | 'presumido';
export type RegimeApuracao = 'caixa' | 'competencia';

export const REGIME_POR_EMPRESA: Record<string, RegimeTributario> = {
  colacor: 'presumido',
  oben: 'presumido',
  colacor_sc: 'simples',
};

// Linhas de imposto regime-aware + linhas estruturais. Deduções (sobre receita) ficam
// acima da receita líquida; das é linha própria (Simples); irpj/csll abaixo (presumido).
export type DreLinha =
  | 'receita_bruta' | 'deducoes' | 'receitas_financeiras' | 'outras_receitas'
  | 'cmv' | 'despesas_operacionais' | 'despesas_administrativas' | 'despesas_comerciais'
  | 'despesas_financeiras' | 'outras_despesas'
  | 'ded_icms' | 'ded_iss' | 'ded_pis' | 'ded_cofins' | 'ded_ipi'
  | 'das' | 'irpj' | 'csll';

const DRE_LINHAS_VALIDAS = new Set<string>([
  'receita_bruta', 'deducoes', 'receitas_financeiras', 'outras_receitas',
  'cmv', 'despesas_operacionais', 'despesas_administrativas', 'despesas_comerciais',
  'despesas_financeiras', 'outras_despesas',
  'ded_icms', 'ded_iss', 'ded_pis', 'ded_cofins', 'ded_ipi', 'das', 'irpj', 'csll',
  // baldes legados aceitos do mapping antigo:
  'impostos',
]);

export type ResultadoClassificacao = {
  linha: DreLinha;
  mapeado: boolean;        // veio do mapping explícito (exato ou prefixo)
  viaFallback: boolean;    // caiu na heurística de keyword
  impostoNaoMapeado: boolean; // imposto detectado só por keyword (sinal de confiança)
};

// Detecta o tipo de imposto pela keyword e devolve a linha regime-aware.
function impostoPorKeyword(upper: string, regime: RegimeTributario): DreLinha | null {
  const tem = (s: string) => upper.includes(s);
  // Simples: tudo é DAS (recolhimento unificado, LC 123) — nunca quebra.
  if (regime === 'simples') {
    if (tem('DAS') || tem('SIMPLES') || tem('IRPJ') || tem('CSLL') || tem('PIS') ||
        tem('COFINS') || tem('ISS') || tem('ICMS') || tem('IPI') || tem('IMPOST') || tem('TRIBUT')) {
      return 'das';
    }
    return null;
  }
  // Presumido: imposto específico.
  if (tem('IRPJ')) return 'irpj';
  if (tem('CSLL')) return 'csll';
  if (tem('COFINS')) return 'ded_cofins';
  if (tem('PIS')) return 'ded_pis';
  if (tem('ISS')) return 'ded_iss';
  if (tem('ICMS')) return 'ded_icms';
  if (tem('IPI')) return 'ded_ipi';
  if (tem('DAS') || tem('SIMPLES') || tem('IMPOST') || tem('TRIBUT')) return 'ded_icms'; // genérico → trata como dedução
  return null;
}

// Mapeia o balde legado 'impostos' para a linha regime-aware.
function normalizarImpostoLegado(linha: string, regime: RegimeTributario): DreLinha {
  if (linha !== 'impostos') return linha as DreLinha;
  return regime === 'simples' ? 'das' : 'ded_icms';
}

export function classificarLinhaDRE(input: {
  categoria_codigo: string;
  categoria_descricao: string;
  isReceita: boolean;
  regime: RegimeTributario;
  mapping: Map<string, string>;
}): ResultadoClassificacao {
  const { categoria_codigo: cod, categoria_descricao: desc, isReceita, regime, mapping } = input;

  // 1. Match exato
  if (cod && mapping.has(cod)) {
    const raw = mapping.get(cod)!;
    const linha = DRE_LINHAS_VALIDAS.has(raw) ? normalizarImpostoLegado(raw, regime) : (isReceita ? 'receita_bruta' : 'despesas_operacionais');
    return { linha, mapeado: true, viaFallback: false, impostoNaoMapeado: false };
  }
  // 2. Prefix match
  if (cod) {
    const parts = cod.split('.');
    for (let i = parts.length - 1; i >= 2; i--) {
      const prefix = parts.slice(0, i).join('.');
      if (mapping.has(prefix)) {
        const raw = mapping.get(prefix)!;
        const linha = DRE_LINHAS_VALIDAS.has(raw) ? normalizarImpostoLegado(raw, regime) : (isReceita ? 'receita_bruta' : 'despesas_operacionais');
        return { linha, mapeado: true, viaFallback: false, impostoNaoMapeado: false };
      }
    }
  }
  // 3. Heurística por descrição (fallback)
  const upper = (desc + ' ' + cod).toUpperCase();
  if (isReceita) {
    if (upper.includes('DEVOL') || upper.includes('CANCEL')) return { linha: 'deducoes', mapeado: false, viaFallback: true, impostoNaoMapeado: false };
    if (upper.includes('FINANC') || upper.includes('REND') || upper.includes('JUROS REC')) return { linha: 'receitas_financeiras', mapeado: false, viaFallback: true, impostoNaoMapeado: false };
    return { linha: 'receita_bruta', mapeado: false, viaFallback: true, impostoNaoMapeado: false };
  }
  // despesa: imposto primeiro (regime-aware)
  const imp = impostoPorKeyword(upper, regime);
  if (imp) return { linha: imp, mapeado: false, viaFallback: true, impostoNaoMapeado: true };
  if (upper.includes('CMV') || upper.includes('CUSTO MERC') || upper.includes('CUSTO PROD') || upper.includes('MATÉRIA') || upper.includes('MATERIA')) return { linha: 'cmv', mapeado: false, viaFallback: true, impostoNaoMapeado: false };
  if (upper.includes('JUROS') || upper.includes('IOF') || upper.includes('TARIFA BANC') || upper.includes('DESC CONCED')) return { linha: 'despesas_financeiras', mapeado: false, viaFallback: true, impostoNaoMapeado: false };
  if (upper.includes('COMISS') || upper.includes('FRETE VEND') || upper.includes('MARKET') || upper.includes('PUBLICID') || upper.includes('PROPAGANDA') || upper.includes('VIAGEM') || upper.includes('REPRESENT')) return { linha: 'despesas_comerciais', mapeado: false, viaFallback: true, impostoNaoMapeado: false };
  if (upper.includes('ALUGUE') || upper.includes('CONDOM') || upper.includes('SALÁR') || upper.includes('FOLHA') || upper.includes('ENCARGO') || upper.includes('FGTS') || upper.includes('INSS PATR') || upper.includes('CONTAB') || upper.includes('CONSULTORI') || upper.includes('SOFTWARE') || upper.includes('TELEFO') || upper.includes('INTERNET') || upper.includes('ENERGIA') || upper.includes('ÁGUA')) return { linha: 'despesas_administrativas', mapeado: false, viaFallback: true, impostoNaoMapeado: false };
  return { linha: 'despesas_operacionais', mapeado: false, viaFallback: true, impostoNaoMapeado: false };
}
