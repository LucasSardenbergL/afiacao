// CNPJ alfanumérico (RFB, desde jul/2026): 12 posições [0-9A-Z] + 2 dígitos verificadores.
// Espelho Deno de `src/lib/radar/normalizar.ts` / `radar-ingest/cnpj.ts` para os ESCRITORES das
// fontes de cliente do Radar (`omie_clientes_nao_vinculados.cnpj_cpf`, lookups por documento).
// Mantenha os espelhos iguais — `cnpj-alfanumerico_test.ts` fixa o exemplo OFICIAL da RFB
// (12.ABC.345/01DE-35) como oráculo.
//
// DV: módulo 11 sobre o valor (código ASCII − 48) de cada caractere — dígito vale o próprio valor,
// 'A'..'Z' valem 17..42 — pesos 5,4,3,2,9,8,7,6,5,4,3,2 (DV1) e 6,5,4,3,2,9,8,7,6,5,4,3,2 (DV2);
// resto < 2 → 0, senão 11 − resto. Para CNPJ só-numérico coincide com a regra clássica.

export const CNPJ_RE = /^[0-9A-Z]{12}[0-9]{2}$/;
/** Máscara RFB nas posições exatas (`12.ABC.345/01DE-35`) — o MESMO regex das migrations 20261019140000/150000. */
const CNPJ_MASCARA_RE = /^[0-9A-Z]{2}[.][0-9A-Z]{3}[.][0-9A-Z]{3}\/[0-9A-Z]{4}-[0-9]{2}$/;
const BASE_RE = /^[0-9A-Z]{12}$/;
const PESOS_1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const PESOS_2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

function digito(valores: number[], pesos: number[]): number {
  const resto = valores.reduce((acc, v, i) => acc + v * pesos[i], 0) % 11;
  return resto < 2 ? 0 : 11 - resto;
}

/** Os 2 DVs da base de 12 posições, ou null se a base não for [0-9A-Z]{12}. */
export function dvCnpj(base12: string): string | null {
  if (!BASE_RE.test(base12)) return null;
  const valores = Array.from(base12, (c) => c.charCodeAt(0) - 48);
  const d1 = digito(valores, PESOS_1);
  const d2 = digito([...valores, d1], PESOS_2);
  return `${d1}${d2}`;
}

/** Formato novo E DV correto. Minúscula não é normalizada aqui — é inválida (fail-closed). */
export function cnpjValido(cnpj: string): boolean {
  return CNPJ_RE.test(cnpj) && dvCnpj(cnpj.slice(0, 12)) === cnpj.slice(12);
}

/** True só para um CNPJ alfanumérico VÁLIDO que tem ao menos uma letra (o numérico não conta). */
export function ehCnpjAlfanumerico(doc: string): boolean {
  return /[A-Z]/.test(doc) && cnpjValido(doc);
}

/**
 * Normaliza um documento de cliente (CPF/CNPJ) para gravar/comparar.
 *
 *   · CPF/CNPJ NUMÉRICO (com ou sem máscara) → só-dígitos, BYTE-IDÊNTICO ao `.replace(/\D/g, "")`
 *     que os escritores sempre fizeram — nada muda para o acervo de hoje.
 *   · CNPJ ALFANUMÉRICO VÁLIDO (formato RFB jul/2026 + DV mod-11) → btrim + upper e, SÓ se o todo
 *     for o documento CRU (14 posições) ou a máscara nas POSIÇÕES EXATAS (`12.ABC.345/01DE-35`),
 *     remove os separadores (. - /) preservando as letras. É exatamente a chave `alnum` de
 *     `radar_recruzar_ja_cliente()` (migration 20261019150000) e de `normalizar_documento()`
 *     (20261019140000). Separador FORA da posição da máscara não é tirado, de propósito: remover
 *     `[-./]` de qualquer posição transformava "aeg-123.456.789-09" (CPF com anotação) em
 *     AEG12345678909, cujo DV confere por coincidência (Codex retroativo do #3175, PR #3192) — e
 *     espaço interno tampouco é separador ("aeg 123.456.789-09" não vira chave).
 *   · Qualquer outra coisa com letra (DV errado, formato errado, máscara fora de posição) →
 *     só-dígitos como hoje. Não se fabrica documento; o que já era lixo continua lixo do mesmo
 *     jeito (precisão > recall).
 */
export function normalizarDocumento(bruto: unknown): string {
  const s = String(bruto ?? "");
  const d = s.trim().toUpperCase();
  if (CNPJ_RE.test(d) || CNPJ_MASCARA_RE.test(d)) {
    const alnum = d.replace(/[-./]/g, "");
    if (ehCnpjAlfanumerico(alnum)) return alnum;
  }
  return s.replace(/\D/g, "");
}

/**
 * Rótulo aceito antes do documento: SÓ `CPF` ou `CNPJ` (sem diferenciar caixa) seguido de `:` ou de
 * espaço — "CPF: 123…", "cnpj 12.345…". Gramática fechada: "AEG-", "Doc:", "C.P.F.", "CPF-" e
 * "CPF123…" (sem separador) NÃO são rótulo.
 */
const ROTULO_RE = /^(CPF|CNPJ)(?:\s*:\s*|\s+)/i;
const TAMANHO_DO_ROTULO: Record<string, number> = { CPF: 11, CNPJ: 14 };

/**
 * Documento para CADASTRAR cliente no Omie (IncluirCliente). O ramo `pessoa_fisica = len <= 11`
 * dos chamadores tratava `12ABC34501DE36` (letra, DV errado) como "CPF" de 9 dígitos e cadastrava
 * ERRADO no ERP — e `123ABC45678909` como o CPF 12345678909 de OUTRA pessoa (Codex, 2026-10-19).
 * A 1ª correção (#3180) tolerava QUALQUER letra antes do 1º dígito como rótulo, e
 * `ABC12345678909` virava o mesmo CPF alheio (Codex ALTO, 2026-10-20). Regra agora:
 *   1. tira no máximo UM rótulo da gramática `ROTULO_RE` (nenhum CNPJ válido casa com ela: o cru
 *      não tem `:`/espaço e a máscara tem `.` na 3ª posição);
 *   2. sobrou letra (qualquer `\p{L}`, inclusive acentuada) → só passa se o resto for CNPJ
 *      alfanumérico válido (cru ou máscara exata, qualquer caixa); senão LANÇA — nunca devolve o
 *      documento reduzido aos dígitos;
 *   3. sem nenhum dígito → LANÇA (ausente ≠ documento vazio);
 *   4. rótulo que contradiz o tamanho (CPF com ≠11 dígitos, CNPJ com ≠14 posições) → LANÇA.
 * Numérico puro/com máscara, sem rótulo, segue byte-idêntico ao `.replace(/\D/g, "")` de sempre.
 * Precisão > recall: um cadastro errado no ERP custa mais que um recusado. As mensagens levam a
 * marca do ramo (`DOC_LETRA_FORA_DO_ROTULO`/`DOC_ROTULO_DIVERGENTE`/`DOC_SEM_DIGITO`) e "cadastro
 * recusado".
 */
export function documentoParaCadastro(bruto: unknown): string {
  const s = String(bruto ?? "").trim();
  const rotulo = ROTULO_RE.exec(s);
  const corpo = rotulo ? s.slice(rotulo[0].length) : s;
  const doc = normalizarDocumento(corpo);
  if (/\p{L}/u.test(corpo) && !ehCnpjAlfanumerico(doc)) {
    throw new Error(
      "DOC_LETRA_FORA_DO_ROTULO: documento com letra fora do rótulo CPF/CNPJ não é um CNPJ alfanumérico válido (RFB jul/2026) — cadastro recusado",
    );
  }
  if (!/\d/.test(doc)) {
    throw new Error("DOC_SEM_DIGITO: documento sem nenhum dígito — cadastro recusado");
  }
  if (rotulo && doc.length !== TAMANHO_DO_ROTULO[rotulo[1].toUpperCase()]) {
    throw new Error(
      `DOC_ROTULO_DIVERGENTE: rótulo ${rotulo[1].toUpperCase()} com ${doc.length} posições — cadastro recusado`,
    );
  }
  return doc;
}
