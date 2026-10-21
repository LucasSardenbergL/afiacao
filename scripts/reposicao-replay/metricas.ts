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

/**
 * true se a margem cancelada das semanas `idx` está completa: nenhuma semana com margem null (todas as canceladas sem cmc)
 * nem PARCIAL (alguma cancelada sem cmc — somar a parte conhecida trataria a ausente como 0).
 */
function margemCompleta(s: SomasSemanais, idx: readonly number[]): boolean {
  return idx.every((i) => s.cancelada.margem[i] !== null && s.canceladaSemCmc.linhas[i] === 0);
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

/**
 * Economia líquida (R$) de trocar `base` (F0) por `alt`; positivo = `alt` vantajosa:
 *   (estoqueMedio_base − estoqueMedio_alt) × taxa × diasJanela/365
 *   − Δ(emergencial × emergencialPerc) − Δ(valorDiasAtraso × atrasoPerc) − Δ(margem cancelada) − Δ(custo terminal),
 * Δ = alt − base; diasJanela = Σ diasCorridos[idx]; custo terminal = backlogValor × emergencialPerc + backlogDiasAtraso ×
 * atrasoPerc (spec §5.9: backlog do fim custeado como compra emergencial no último dia + atraso até lá).
 *
 * Ausente ≠ zero: se QUALQUER semana de `idx`, em QUALQUER braço, tem a margem cancelada ausente (null) ou parcial
 * (`canceladaSemCmc.linhas > 0`), devolve null — a semana não é excluída nem tratada como 0. No §6.1 isso vira INCERTO.
 *
 * O terminal é um valor da janela inteira (não semanal): entra uma vez, qualquer que seja `idx` (na reamostragem do
 * bootstrap ele é a parte não reamostrada, comum às réplicas).
 */
export function custoLiquido(
  base: SomasSemanais,
  alt: SomasSemanais,
  g: GradeCusto,
  idx: readonly number[] = todas(base),
): number | null {
  conferirPareados(base, alt);
  conferirIdx(base, idx);
  if (!margemCompleta(base, idx) || !margemCompleta(alt, idx)) return null;
  const diasJanela = somar(base.diasCorridos, idx);
  const capital = (estoqueMedio(base, idx) - estoqueMedio(alt, idx)) * g.taxa * (diasJanela / 365);
  const delta = (f: (s: SomasSemanais) => number): number => f(alt) - f(base);
  const margem = (s: SomasSemanais): number => idx.reduce((t, i) => t + (s.cancelada.margem[i] as number), 0);
  return (
    capital -
    delta((s) => somar(s.entregue.emergencial, idx)) * g.emergencialPerc -
    delta((s) => somar(s.valorDiasAtraso, idx)) * g.atrasoPerc -
    delta(margem) -
    delta((s) => custoTerminal(s, g))
  );
}

/**
 * Custo de falta de equilíbrio (R$ por linha): o custo máximo por linha com falta ADICIONAL (célula `total`, linhas não
 * integralmente atendidas no dia) que ainda mantém a troca vantajosa = capital evitado ÷ faltas adicionais. Sem falta
 * adicional (alt falha ≤ base) ⇒ null: não há equilíbrio a medir. Negativo = a troca não libera capital.
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
