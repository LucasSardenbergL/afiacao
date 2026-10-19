// Helpers puros de normalização do dump RFB. Sem I/O — testáveis e reusáveis
// pelo script local (carga.ts) e, futuramente, pela GitHub Action (fatia 4).

// ── CNPJ alfanumérico (RFB, desde jul/2026) ──────────────────────────────────────────────────
// 12 posições [0-9A-Z] + 2 dígitos verificadores. DV: módulo 11 sobre o valor (código ASCII − 48)
// de cada caractere — dígito vale o próprio valor, 'A'..'Z' valem 17..42 — pesos 5,4,3,2,9,8,7,6,5,4,3,2
// (DV1) e 6,5,4,3,2,9,8,7,6,5,4,3,2 (DV2); resto < 2 → 0, senão 11 − resto. Para CNPJ só-numérico
// coincide com a regra clássica. Espelho Deno em `supabase/functions/radar-ingest/cnpj.ts` (a edge não
// importa `src/`) — mantenha os dois iguais; o oráculo externo dos testes é o exemplo OFICIAL da RFB
// 12.ABC.345/01DE-35. Mesmo formato do CHECK em `radar_empresas.cnpj` (migration 20261019110000).

export const CNPJ_RE = /^[0-9A-Z]{12}[0-9]{2}$/;
const BASE_RE = /^[0-9A-Z]{12}$/;
const PESOS_1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const PESOS_2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

function digitoMod11(valores: number[], pesos: number[]): number {
  const resto = valores.reduce((acc, v, i) => acc + v * pesos[i], 0) % 11;
  return resto < 2 ? 0 : 11 - resto;
}

/** Os 2 DVs da base de 12 posições, ou null se a base não for [0-9A-Z]{12}. */
export function dvCnpj(base12: string): string | null {
  if (!BASE_RE.test(base12)) return null;
  const valores = Array.from(base12, (c) => c.charCodeAt(0) - 48);
  const d1 = digitoMod11(valores, PESOS_1);
  const d2 = digitoMod11([...valores, d1], PESOS_2);
  return `${d1}${d2}`;
}

/** Formato novo E DV correto. Minúscula não é normalizada — é inválida (fail-closed). */
export function cnpjValido(cnpj: string): boolean {
  return CNPJ_RE.test(cnpj) && dvCnpj(cnpj.slice(0, 12)) === cnpj.slice(12);
}

/** Monta o CNPJ de 14 posições a partir dos 3 componentes do dump RFB
 *  (básico 8, ordem 4, dv 2), aplicando zero-padding, e VALIDA o DV (módulo 11, regra alfanumérica —
 *  para numérico é a regra clássica; medido em prod 2026-10-19: 0 de 526.176 CNPJs do radar falham).
 *  Retorna null se algum componente tiver caractere fora de [0-9A-Z] (minúscula inclusive),
 *  se o DV não for numérico ou se o DV não bater — fail-closed: linha descartada, nunca gravada errada. */
export function montarCnpj(basico: string, ordem: string, dv: string): string | null {
  const b = basico.trim(), o = ordem.trim(), d = dv.trim();
  if (!/^[0-9A-Z]{1,8}$/.test(b) || !/^[0-9A-Z]{1,4}$/.test(o) || !/^\d{1,2}$/.test(d)) return null;
  const cnpj = b.padStart(8, '0') + o.padStart(4, '0') + d.padStart(2, '0');
  return cnpjValido(cnpj) ? cnpj : null;
}

/** Converte data no formato RFB (AAAAMMDD) para ISO (YYYY-MM-DD).
 *  Retorna null para vazio, placeholder '0'/'00000000' ou data inválida (incl.
 *  dia-no-mês inexistente, ex.: 20240231 — evita rejeição de chunk no Postgres). */
export function normalizarData(v: string): string | null {
  const s = v.trim();
  if (!/^\d{8}$/.test(s) || s === '00000000') return null;
  const ano = +s.slice(0, 4), mes = +s.slice(4, 6), dia = +s.slice(6, 8);
  if (ano < 1900 || mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
  // Round-trip UTC: detecta dias inválidos no mês (ex.: 31/fev, 29/fev em ano comum)
  const dt = new Date(Date.UTC(ano, mes - 1, dia));
  if (dt.getUTCFullYear() !== ano || dt.getUTCMonth() !== mes - 1 || dt.getUTCDate() !== dia) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/** Monta telefone a partir das colunas separadas ddd e numero do dump RFB.
 *  Placeholder '0' é tratado como ausente. Retorna null se não houver número. */
export function normalizarTelefone(ddd: string, numero: string): string | null {
  const d = ddd.replace(/\D/g, '').replace(/^0+$/, '');
  const n = numero.replace(/\D/g, '').replace(/^0+$/, '');
  if (!n) return null;
  return d ? `(${d}) ${n}` : n;
}

/** Converte capital social do formato RFB (vírgula decimal, ponto de milhar opcional)
 *  para number. Retorna null para vazio ou valor não-numérico. */
export function normalizarCapital(v: string): number | null {
  const s = v.trim().replace(/\./g, '').replace(',', '.');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Divide a string de CNAEs secundários do dump RFB (separados por vírgula)
 *  e retorna somente os códigos com exatamente 7 dígitos numéricos. */
export function splitCnaesSecundarios(v: string): string[] {
  return v.split(',').map((c) => c.trim()).filter((c) => /^\d{7}$/.test(c));
}

/** Trim + colapsa espaços múltiplos. Retorna null para string vazia ou só espaços.
 *  Strip de caracteres de controle (U+0000–U+001F, ex.: NUL) antes do colapso —
 *  evita rejeição de chunk no Postgres ao inserir em colunas text. */
export function normalizarTexto(v: string | null | undefined): string | null {
  // eslint-disable-next-line no-control-regex -- strip intencional de controles C0 (NUL quebra insert no Postgres)
  const s = (v ?? '').replace(/[\x00-\x1F]/g, ' ').replace(/\s+/g, ' ').trim();
  return s || null;
}

/** Gera chave de casamento município RFB ↔ IBGE:
 *  remove acentos (NFD), UPPER, remove TUDO que não é A-Z0-9 (sem espaços).
 *  Resolve divergências de grafia RFB vs IBGE: D'ÁGUA colado == DAGUA separado,
 *  hífen removido, espaços removidos.
 *  Exemplo: "SANTA BÁRBARA D'OESTE" (SP) == "Santa Barbara d Oeste" (sp)
 *           → "SANTABARBARADOESTE|SP" */
export function normalizarChaveMunicipio(nome: string, uf: string): string {
  const semAcento = nome.normalize('NFD').replace(/[\u0300-\u036F]/g, '');
  return `${semAcento.toUpperCase().replace(/[^A-Z0-9]/g, '')}|${uf.trim().toUpperCase()}`;
}
