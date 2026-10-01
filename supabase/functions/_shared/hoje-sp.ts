// O dia de NEGÓCIO (America/Sao_Paulo) dentro das edges — o servidor do Deno roda em UTC.
//
// Lógica PURA (o instante é injetável) para caber no `--no-remote` do `test:edges`.
// Testes em hoje-sp_test.ts.
//
// POR QUE EXISTE — a classe (ii) do fuso, fase 3 (docs/historico/hoje-sp-typescript-e-data-ciclo.md).
// `new Date().toISOString().slice(0, 10)` é o dia UTC: das 21:00 às 23:59 BRT ele já é o dia
// SEGUINTE ao de São Paulo. O botão do Cockpit chamava gerar-pedidos-diario sem data e, das 21h em
// diante, o ciclo nascia com data_ciclo = amanhã — e a RPC expira os pendentes com
// `data_ciclo < p_data_ciclo`: os de HOJE. O gate `src/__tests__/hoje-utc-gate.test.ts` reprova a
// forma UTC fora da baseline; aqui é onde a forma CERTA mora.
//
// Por que `formatToParts` e não `toLocaleDateString('en-CA')`: o FORMATO de um locale é dado do
// ICU e muda entre versões; as PARTES (year/month/day) não. E o fuso é o NOMEADO, não um offset
// fixo: se o horário de verão voltar, este arquivo continua certo (o `dia-operacional.ts`, com
// UTC−3 fixo, não).

const PARTES_SP = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Sao_Paulo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const DIA_ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A data de negócio (`YYYY-MM-DD`) de um instante, no fuso de São Paulo. Instante inválido LANÇA. */
export function diaSP(instante: Date): string {
  if (Number.isNaN(instante.getTime())) {
    throw new RangeError("diaSP: instante inválido — sem instante não há dia (ausente ≠ hoje)");
  }
  const p: Record<string, string> = {};
  for (const { type, value } of PARTES_SP.formatToParts(instante)) p[type] = value;
  return `${p.year}-${p.month}-${p.day}`;
}

/** Hoje em São Paulo (`YYYY-MM-DD`). `agora` é injetável para o teste não depender do relógio. */
export function hojeSP(agora: Date = new Date()): string {
  return diaSP(agora);
}

/**
 * Soma `n` dias (pode ser negativo) a uma data `YYYY-MM-DD` — aritmética de CALENDÁRIO, sem fuso
 * nenhum no meio (o dia é contado em UTC puro, onde não há DST). Data malformada LANÇA.
 */
export function somarDias(dia: string, n: number): string {
  const m = DIA_ISO.exec(dia);
  if (!m || !Number.isInteger(n)) throw new RangeError(`somarDias: data ou deslocamento inválido (${dia}, ${n})`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n));
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${d.getUTCFullYear()}-${mm}-${dd}`;
}
