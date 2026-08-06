// Competência (mês) do Prime — SEMPRE derivada em America/Sao_Paulo.
// A migration/view/triggers usam a MESMA timezone; virada de mês UTC≠SP é
// armadilha conhecida do repo (um registro às 22h de 31/jul em SP já é agosto
// em UTC — a competência default errada levaria P0001 de vigência).

const MES_CURTO = [
  'jan', 'fev', 'mar', 'abr', 'mai', 'jun',
  'jul', 'ago', 'set', 'out', 'nov', 'dez',
] as const;

/** Data de hoje (YYYY-MM-DD) no fuso America/Sao_Paulo. */
export function hojeSP(): string {
  // en-CA formata como YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** Primeiro dia do mês corrente (YYYY-MM-01) no fuso America/Sao_Paulo. */
export function mesAtualSP(): string {
  return `${hojeSP().slice(0, 7)}-01`;
}

/** Trunca uma data (YYYY-MM-DD) para o dia 1 do mês (YYYY-MM-01). */
export function mesDe(data: string): string {
  return `${data.slice(0, 7)}-01`;
}

/**
 * Meses de vigência de uma assinatura para registrar uso: do mês de
 * `dataInicio` até `mesFinal` (default: mês corrente SP), em ordem
 * DECRESCENTE (mais recente primeiro — é o caso comum do registro).
 * Espelha a janela do trigger prime_uso_vigencia (nunca competência futura,
 * nunca antes do início). `cap` é defensivo contra dado sujo — o piloto tem
 * meses, não anos; acima do cap ficam só os mais recentes.
 */
export function gerarMesesVigencia(
  dataInicio: string,
  mesFinal: string = mesAtualSP(),
  cap = 24,
): string[] {
  const inicio = mesDe(dataInicio);
  const fim = mesDe(mesFinal);
  const idx = (m: string) => Number(m.slice(0, 4)) * 12 + (Number(m.slice(5, 7)) - 1);
  const de = idx(inicio);
  const ate = idx(fim);
  if (!Number.isFinite(de) || !Number.isFinite(ate) || ate < de) return [];
  const meses: string[] = [];
  for (let i = ate; i >= de && meses.length < cap; i--) {
    const ano = Math.floor(i / 12);
    const mes = String((i % 12) + 1).padStart(2, '0');
    meses.push(`${ano}-${mes}-01`);
  }
  return meses;
}

/** "2026-07-01" → "jul/2026" (sem Date/TZ — parse posicional determinístico). */
export function formatMes(competencia: string): string {
  const mes = Number(competencia.slice(5, 7));
  const ano = competencia.slice(0, 4);
  const nome = MES_CURTO[mes - 1];
  return nome ? `${nome}/${ano}` : competencia;
}

/**
 * Valor de tabela da afiação = quantidade × preço/dente, EXATO em centavos —
 * espelha o CHECK do banco `valor_tabela = round(quantidade × snapshot, 2)`.
 * Multiplica em centavos inteiros para não divergir do numeric do Postgres
 * por erro binário de float (96 × 1.2 em float é 115.19999…).
 * Pré-condições (validadas no form): quantidade inteira, preço com ≤2 casas.
 */
export function valorAfiacao(quantidade: number, precoUnitario: number): number {
  return (quantidade * Math.round(precoUnitario * 100)) / 100;
}
