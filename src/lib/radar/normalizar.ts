// Helpers puros de normalização do dump RFB. Sem I/O — testáveis e reusáveis
// pelo script local (carga.ts) e, futuramente, pela GitHub Action (fatia 4).

/** Monta o CNPJ de 14 dígitos a partir dos 3 componentes do dump RFB
 *  (básico 8, ordem 4, dv 2), aplicando zero-padding.
 *  Retorna null se qualquer componente contiver caractere não-numérico. */
export function montarCnpj(basico: string, ordem: string, dv: string): string | null {
  const b = basico.trim(), o = ordem.trim(), d = dv.trim();
  if (!/^\d{1,8}$/.test(b) || !/^\d{1,4}$/.test(o) || !/^\d{1,2}$/.test(d)) return null;
  return b.padStart(8, '0') + o.padStart(4, '0') + d.padStart(2, '0');
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
