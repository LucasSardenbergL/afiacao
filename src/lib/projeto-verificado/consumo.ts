// Classificação de consumo em BANDAS AMPLAS (spec v2 §4): rendimento em madeira
// varia demais (substrato, demãos, método, perdas) → serve para ALERTA e seleção
// de auditoria, NUNCA como critério isolado de aprovação. Doutrina "ausente ≠ zero":
// sem rendimento/área válidos → 'indeterminado', não fabrica classe.
// Os limiares são calibráveis (default conservador); valores finais via discovery.

export type ClassificacaoConsumo = 'compativel' | 'baixo' | 'suspeito' | 'indeterminado';

export interface ParametrosConsumo {
  areaM2: number;
  /** Rendimento do sistema (m² por litro), do boletim técnico (discovery D3). */
  rendimentoM2PorLitro: number;
  litrosDosados: number;
  /** Razão abaixo da qual vira 'suspeito' (default 0,4). */
  limiarSuspeito?: number;
  /** Razão abaixo da qual vira 'baixo' (default 0,7). */
  limiarBaixo?: number;
}

export interface ResultadoConsumo {
  esperadoL: number | null;
  razao: number | null;
  classe: ClassificacaoConsumo;
}

export function classificarConsumo(p: ParametrosConsumo): ResultadoConsumo {
  const limiarSuspeito = p.limiarSuspeito ?? 0.4;
  const limiarBaixo = p.limiarBaixo ?? 0.7;

  // Ausente ≠ zero: entradas inválidas não viram classe fabricada.
  if (!(p.areaM2 > 0) || !(p.rendimentoM2PorLitro > 0)) {
    return { esperadoL: null, razao: null, classe: 'indeterminado' };
  }

  const esperadoL = p.areaM2 / p.rendimentoM2PorLitro;
  const razao = p.litrosDosados / esperadoL;

  let classe: ClassificacaoConsumo;
  if (razao < limiarSuspeito) classe = 'suspeito';
  else if (razao < limiarBaixo) classe = 'baixo';
  else classe = 'compativel';

  return { esperadoL, razao, classe };
}
