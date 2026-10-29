// Métricas do replay TSB (spec §5.7, §5.9 "Bootstrap" e §6.1): funções PURAS sobre as somas semanais do simulador.
// Toda razão é Σ numerador ÷ Σ denominador sobre as semanas `idx` (padrão: todas) — nunca média de razões semanais. O
// bootstrap (T8) passa os índices reamostrados (com repetição) e recalcula a razão; as duas políticas recebem o MESMO idx.
import type { Celula, SomasSemanais } from './simulador';

/** Taxa de capital, penalidade de compra emergencial (fração do valor) e custo de atraso (fração do valor por dia corrido). */
export interface GradeCusto {
  taxa: number;
  emergencialPerc: number;
  atrasoPerc: number;
}

const todas = (s: SomasSemanais): number[] => s.semanas.map((_, i) => i);
const somar = (v: readonly number[], idx: readonly number[]): number => idx.reduce((t, i) => t + v[i], 0);

function conferirIdx(s: SomasSemanais, idx: readonly number[]): void {
  for (const i of idx) {
    if (!Number.isInteger(i) || i < 0 || i >= s.semanas.length) throw new Error(`metricas: semana ${i} fora da janela`);
  }
}

/** Atendimento das linhas faturadas observadas: Σ integralmente atendidas no dia ÷ Σ demandadas. Denominador 0 ⇒ null. */
export function fillRate(s: SomasSemanais, c: Celula, idx: readonly number[] = todas(s)): number | null {
  conferirIdx(s, idx);
  const cel = s.porCelula[c];
  const dem = somar(cel.demandadas, idx);
  return dem > 0 ? somar(cel.integrais, idx) / dem : null;
}

/** Estoque físico médio a CMC, ponderado pelos dias corridos: Σ estoqueCmcDias ÷ Σ diasCorridos. Sem dias ⇒ erro. */
export function estoqueMedio(s: SomasSemanais, idx: readonly number[] = todas(s)): number {
  conferirIdx(s, idx);
  const dias = somar(s.diasCorridos, idx);
  if (!(dias > 0)) throw new Error('metricas: estoque médio sem dias corridos');
  return somar(s.estoqueCmcDias, idx) / dias;
}

function conferirPareados(base: SomasSemanais, alt: SomasSemanais): void {
  const n = base.semanas.length;
  const ok =
    alt.semanas.length === n &&
    base.semanas.every((d, i) => d === alt.semanas[i] && base.diasCorridos[i] === alt.diasCorridos[i]);
  if (!ok) throw new Error('metricas: braços não pareados (semanas ou dias corridos diferentes)');
}

const custoTerminal = (s: SomasSemanais, g: GradeCusto): number =>
  s.terminal.backlogValor * g.emergencialPerc + s.terminal.backlogDiasAtraso * g.atrasoPerc;

/** Achado 10: Σ unidades × dias de estoque SEM CMC nas semanas `idx` (> 0 ⇒ o capital do recorte não é mensurável). */
export function estoqueNaoValorado(s: SomasSemanais, idx: readonly number[] = todas(s)): number {
  conferirIdx(s, idx);
  return somar(s.estoqueNaoValoradoDias, idx);
}

/** Fração das unidades × dias de estoque sem CMC nas semanas `idx`; sem unidade nenhuma ⇒ null (ausente ≠ 0). */
export function fracaoNaoValorada(s: SomasSemanais, idx: readonly number[] = todas(s)): number | null {
  conferirIdx(s, idx);
  const u = somar(s.estoqueUnidadesDias, idx);
  return u > 0 ? somar(s.estoqueNaoValoradoDias, idx) / u : null;
}

/** R37: fração do capital (estoque × CMC × dias) nos SKUs de grupo de embalagem; sem capital valorado ⇒ null. */
export function fracaoGrupos(s: SomasSemanais, idx: readonly number[] = todas(s)): number | null {
  conferirIdx(s, idx);
  const c = somar(s.estoqueCmcDias, idx);
  return c > 0 ? somar(s.estoqueCmcDiasGrupos, idx) / c : null;
}

/** Resultado de `custoLiquido`: o custo e, quando null, quanto dado faltou (os dois braços somados). */
export interface ResultadoCusto {
  /**
   * R$; positivo = `alt` vantajosa. null (INCERTO, nunca 0) quando, nas semanas `idx`: falta dia corrido; há cancelada
   * sem cmc em qualquer braço (margem desconhecida, achado 11); ou há estoque sem CMC em qualquer braço (achado 10).
   */
  custo: number | null;
  /** Σ canceladaSemCmc.linhas nas semanas `idx`, base + alt: linhas de margem desconhecida (> 0 ⇒ custo null). */
  linhasMargemDesconhecida: number;
  /** Σ canceladaSemCmc.valor nas semanas `idx`, base + alt. */
  valorMargemDesconhecida: number;
  /** Σ estoqueNaoValoradoDias nas semanas `idx`, base + alt (unidades × dias; > 0 ⇒ custo null). */
  estoqueNaoValoradoDias: number;
}

/**
 * Economia líquida (R$) de trocar `base` (F0) por `alt`; positivo = `alt` vantajosa:
 *   (estoqueMedio_base − estoqueMedio_alt) × taxa × diasJanela/365
 *   − Δ(emergencial × emergencialPerc) − Δ(valorDiasAtraso × atrasoPerc) − Δ(margem cancelada) − Δ(custo terminal) × k,
 * Δ = alt − base; diasJanela = Σ diasCorridos[idx]; custo terminal = backlogValor × emergencialPerc + backlogDiasAtraso ×
 * atrasoPerc (spec §5.9: backlog do fim custeado como compra emergencial no último dia + atraso até lá).
 *
 * Achado 12 (§5.9 "Bootstrap": custos transportados por SOMAS SEMANAIS): o custo terminal é uma soma da ÚLTIMA semana.
 * Entra k vezes, k = quantas vezes a última semana aparece em `idx` — 0 se o sorteio não a contém. Assim o benefício (ou o
 * prejuízo) terminal varia entre as reamostragens como qualquer outra soma semanal, em vez de entrar em todas.
 *
 * Achado 11: a margem de uma cancelada SEM cmc é desconhecida e não tem limite inferior comprovado (a venda pode ter
 * margem negativa: cancelá-la evita prejuízo). Sem limite, não há pior caso: qualquer cancelada sem cmc, em qualquer
 * braço, nas semanas `idx` ⇒ custo null (INCERTO). A R24 (piso 0) foi revogada pelo Lucas em 28/10.
 *
 * Achado 10: estoque sem CMC em qualquer braço nas semanas `idx` ⇒ custo null: a redução de capital nunca sai do subtotal
 * valorado.
 */
export function custoLiquido(
  base: SomasSemanais,
  alt: SomasSemanais,
  g: GradeCusto,
  idx: readonly number[] = todas(base),
): ResultadoCusto {
  conferirPareados(base, alt);
  conferirIdx(base, idx);
  const faltas = {
    linhasMargemDesconhecida: somar(base.canceladaSemCmc.linhas, idx) + somar(alt.canceladaSemCmc.linhas, idx),
    valorMargemDesconhecida: somar(base.canceladaSemCmc.valor, idx) + somar(alt.canceladaSemCmc.valor, idx),
    estoqueNaoValoradoDias: estoqueNaoValorado(base, idx) + estoqueNaoValorado(alt, idx),
  };
  const diasJanela = somar(base.diasCorridos, idx);
  if (!(diasJanela > 0) || faltas.linhasMargemDesconhecida > 0 || faltas.estoqueNaoValoradoDias > 0) return { custo: null, ...faltas };
  const capital = (estoqueMedio(base, idx) - estoqueMedio(alt, idx)) * g.taxa * (diasJanela / 365);
  const delta = (f: (s: SomasSemanais) => number): number => f(alt) - f(base);
  const margem = (s: SomasSemanais): number =>
    idx.reduce((t, i) => {
      const m = s.cancelada.margem[i];
      // margem null só existe com cancelada sem cmc, que já devolveu null acima; se o invariante quebrar, nunca vira 0
      if (m === null) throw new Error(`metricas: margem null na semana ${i} sem cancelada sem cmc (invariante do simulador)`);
      return t + m;
    }, 0);
  const ultima = base.semanas.length - 1;
  const k = idx.reduce((t, i) => t + (i === ultima ? 1 : 0), 0);
  const custo =
    capital -
    delta((s) => somar(s.entregue.emergencial, idx)) * g.emergencialPerc -
    delta((s) => somar(s.valorDiasAtraso, idx)) * g.atrasoPerc -
    delta(margem) -
    delta((s) => custoTerminal(s, g)) * k;
  return { custo, ...faltas };
}

/**
 * Custo de falta de equilíbrio (R$ por linha): o custo máximo por linha com falta ADICIONAL (célula `total`, linhas não
 * integralmente atendidas no dia) que ainda mantém a troca vantajosa = capital evitado ÷ faltas adicionais. Sem falta
 * adicional (alt falha ≤ base) ⇒ null: não há equilíbrio a medir. Estoque sem CMC ⇒ null (achado 10). Negativo = a troca não
 * libera capital.
 */
export function custoFaltaEquilibrio(
  base: SomasSemanais,
  alt: SomasSemanais,
  taxa: number,
  idx: readonly number[] = todas(base),
): number | null {
  conferirPareados(base, alt);
  conferirIdx(base, idx);
  const faltas = (s: SomasSemanais): number =>
    somar(s.porCelula.total.demandadas, idx) - somar(s.porCelula.total.integrais, idx);
  const adicionais = faltas(alt) - faltas(base);
  if (!(adicionais > 0)) return null;
  if (estoqueNaoValorado(base, idx) + estoqueNaoValorado(alt, idx) > 0) return null; // achado 10: capital não mensurável
  const capital = (estoqueMedio(base, idx) - estoqueMedio(alt, idx)) * taxa * (somar(base.diasCorridos, idx) / 365);
  return capital / adicionais;
}

/** DIO Sayerlack (dias): estoque médio a CMC ÷ CMV Sayerlack diário. CMV ausente ou ≤ 0 ⇒ erro (nunca DIO fabricado). */
export function dioSayerlack(s: SomasSemanais, cmvSayerlackDiario: number, idx: readonly number[] = todas(s)): number {
  if (!(Number.isFinite(cmvSayerlackDiario) && cmvSayerlackDiario > 0)) {
    throw new Error('metricas: CMV Sayerlack diário ausente ou não positivo');
  }
  return estoqueMedio(s, idx) / cmvSayerlackDiario;
}
