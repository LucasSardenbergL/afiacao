import type { KbProductSpec } from './specs-types';

export interface RendimentoCalculation {
  /** Área total a ser pintada (m²) */
  areaM2: number;
  /** Demãos aplicadas (override ou default do spec) */
  demaos: number;
  /** Rendimento usado (m²/L do spec ou recalculado pela gramatura) */
  rendimentoM2PorLitro: number;
  /** Litros necessários */
  litrosNecessarios: number;
  /** Memória de cálculo pra UI */
  calculo: string;
  /** Avisos se faltam dados pro cálculo */
  warnings: string[];
}

export interface CalculateInput {
  spec: Pick<KbProductSpec, 'rendimento_m2_por_litro' | 'densidade_g_cm3' | 'gramatura_g_m2_min' | 'gramatura_g_m2_max' | 'demaos_recomendadas' | 'product_name'>;
  areaM2: number;
  demaosOverride?: number;
}

/**
 * Calcula litros necessários considerando rendimento + demãos.
 * Se spec não tem rendimento explícito mas tem densidade + gramatura, deriva.
 * Retorna warnings quando faltam dados ou cálculo é aproximação.
 */
export function calculateRendimento(input: CalculateInput): RendimentoCalculation {
  const warnings: string[] = [];
  const demaos = input.demaosOverride ?? input.spec.demaos_recomendadas ?? 1;

  if (input.demaosOverride === undefined && !input.spec.demaos_recomendadas) {
    warnings.push('Demãos não informadas no boletim — assumindo 1.');
  }

  let rendimento = input.spec.rendimento_m2_por_litro;
  let calculo = '';

  if (rendimento != null && rendimento > 0) {
    calculo = `Rendimento do boletim: ${rendimento} m²/L`;
  } else if (input.spec.densidade_g_cm3 && (input.spec.gramatura_g_m2_min || input.spec.gramatura_g_m2_max)) {
    const min = input.spec.gramatura_g_m2_min ?? input.spec.gramatura_g_m2_max ?? 0;
    const max = input.spec.gramatura_g_m2_max ?? input.spec.gramatura_g_m2_min ?? 0;
    const gramaturaMedia = (min + max) / 2;
    const densidadeGPorL = input.spec.densidade_g_cm3 * 1000;
    rendimento = gramaturaMedia > 0 ? densidadeGPorL / gramaturaMedia : 0;
    calculo = `Derivado: densidade ${input.spec.densidade_g_cm3} g/cm³ × 1000 ÷ gramatura média ${gramaturaMedia} g/m² = ${rendimento.toFixed(1)} m²/L`;
    warnings.push('Rendimento derivado da densidade + gramatura (boletim não informa explicitamente).');
  } else {
    warnings.push('Spec sem rendimento, densidade ou gramatura — dados insuficientes pro cálculo.');
    return {
      areaM2: input.areaM2,
      demaos,
      rendimentoM2PorLitro: 0,
      litrosNecessarios: 0,
      calculo: 'Dados insuficientes',
      warnings,
    };
  }

  if (rendimento <= 0) {
    warnings.push('Rendimento calculado é zero ou negativo.');
    return {
      areaM2: input.areaM2,
      demaos,
      rendimentoM2PorLitro: 0,
      litrosNecessarios: 0,
      calculo,
      warnings,
    };
  }

  const litros = (input.areaM2 / rendimento) * demaos;

  return {
    areaM2: input.areaM2,
    demaos,
    rendimentoM2PorLitro: rendimento,
    litrosNecessarios: litros,
    calculo,
    warnings,
  };
}
