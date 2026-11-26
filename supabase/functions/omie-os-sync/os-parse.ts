// Parser PURO de uma OS do `servicos/os/ListarOS` (Colacor SC) — testes em os-parse_test.ts.
//
// Regra money-path: AUSENTE ≠ ZERO. Nenhum campo vira número por `Number(x)` cru (`Number(null)` e
// `Number('')` dão 0 e fabricariam valor/prazo). Campo ilegível vira `null`, e quem consome (a sombra da
// fatia 2) trata `null` como estado indeterminado. Só a IDENTIDADE (`nCodOS`) é obrigatória: sem ela a OS
// não é gravada e a varredura deixa de ser íntegra (não serve para sumiço).

export interface OSLinha {
  n_cod_os: number;
  c_num_os: string | null;
  c_cod_int_os: string | null;
  n_cod_cli: number | null;
  etapa: string | null;
  valor_total: number | null;
  valor_bruto: string | null;
  parcelas: unknown[] | null;
  n_parcelas: number | null;
  prazo_max_dias: number | null;
  faturada: boolean | null;
  cancelada: boolean | null;
  data_inclusao: string | null;
  data_alteracao: string | null;
  data_faturamento: string | null;
  payload: Record<string, unknown>;
}

/** `contrato` = a 1ª chave estrutural acordada que faltou (null = forma completa). Campo PRESENTE com valor
 *  ilegível é só NULL; chave AUSENTE é perda estrutural e tira a integridade do run (Codex diff P1-2: uma forma
 *  nova do payload não pode sobrescrever o espelho com NULL e tirar a OS da view). */
export type ResultadoParse = { ok: true; linha: OSLinha; contrato: string | null } | { ok: false; motivo: string };

const CONTRATO_CABECALHO = ["nCodOS", "cNumOS", "nCodCli", "cEtapa", "nValorTotal"] as const;
const CONTRATO_INFO = ["cFaturada", "cCancelada", "dDtInc"] as const;

function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
}

/** Inteiro seguro > 0 vindo de número ou de string só com dígitos. Qualquer outra coisa → null. */
export function inteiroPositivo(v: unknown): number | null {
  if (typeof v === "number") return Number.isSafeInteger(v) && v > 0 ? v : null;
  if (typeof v === "string" && /^\s*\d+\s*$/.test(v)) {
    const n = Number(v.trim());
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  return null;
}

/** Inteiro seguro ≥ 0 (dias de parcela). Vazio, nulo, fração ou negativo → null. */
export function inteiroNaoNegativo(v: unknown): number | null {
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? v : null;
  if (typeof v === "string" && /^\s*\d+\s*$/.test(v)) {
    const n = Number(v.trim());
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

/** Valor monetário ≥ 0 e finito. Aceita número ou string numérica NÃO vazia ("1234.5"); o resto → null. */
export function valorMonetario(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 && v < 1e12 ? v : null;
  if (typeof v === "string" && /^\s*\d+(\.\d+)?\s*$/.test(v)) {
    const n = Number(v.trim());
    return Number.isFinite(n) && n < 1e12 ? n : null;
  }
  return null;
}

function texto(v: unknown): string | null {
  if (typeof v === "string") return v.trim() === "" ? null : v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

/** 'S' → true · 'N' → false · ausente/desconhecido → null (só o reconhecido afirma algo). */
export function simNao(v: unknown): boolean | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toUpperCase();
  return s === "S" ? true : s === "N" ? false : null;
}

/** `dd/mm/aaaa` (+ `HH:MM[:SS]` opcional) no fuso de Brasília → ISO com -03:00. Inválida → null. */
export function dataOmie(data: unknown, hora?: unknown): string | null {
  if (typeof data !== "string") return null;
  const m = /^\s*(\d{2})\/(\d{2})\/(\d{4})\s*$/.exec(data);
  if (!m) return null;
  const [d, mes, ano] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(ano, mes - 1, d));
  if (ano < 2000 || ano > 2100 || dt.getUTCFullYear() !== ano || dt.getUTCMonth() !== mes - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  let hms = "00:00:00";
  if (typeof hora === "string" && hora.trim() !== "") {
    const h = /^\s*(\d{2}):(\d{2})(?::(\d{2}))?\s*$/.exec(hora);
    if (!h || Number(h[1]) > 23 || Number(h[2]) > 59 || Number(h[3] ?? 0) > 59) return null;
    hms = `${h[1]}:${h[2]}:${h[3] ?? "00"}`;
  }
  return `${m[3]}-${m[2]}-${m[1]}T${hms}-03:00`;
}

/** Parcelas: array, ou objeto único (algumas respostas do Omie colapsam lista de 1). Ausente → null. */
function listaParcelas(v: unknown): unknown[] | null {
  if (Array.isArray(v)) return v;
  if (obj(v)) return [v];
  return null;
}

/** Prazo = maior `nDias`, só se TODA parcela tiver `nDias` legível. Sem parcela ou alguma sem `nDias` → null.
 *  Com `nQtdeParc` declarado, a lista tem de ter exatamente essa quantidade e `nParcela` sem repetição — parcelamento
 *  truncado não vira "à vista" (Codex diff P1-5). */
export function prazoMaxDias(parcelas: unknown[] | null, qtdeDeclarada?: unknown): number | null {
  if (!parcelas || parcelas.length === 0) return null;
  if (qtdeDeclarada !== undefined && qtdeDeclarada !== null && qtdeDeclarada !== "") {
    const q = inteiroNaoNegativo(qtdeDeclarada);
    if (q === null || q !== parcelas.length) return null;
  }
  const numeros = new Set<string>();
  let max = -1;
  for (const p of parcelas) {
    const o = obj(p);
    const n = inteiroNaoNegativo(o?.nDias);
    if (n === null) return null;
    if (o?.nParcela !== undefined) {
      const k = String(o.nParcela);
      if (numeros.has(k)) return null;
      numeros.add(k);
    }
    if (n > max) max = n;
  }
  return max;
}

export function parseOS(item: unknown): ResultadoParse {
  const it = obj(item);
  if (!it) return { ok: false, motivo: "item não é objeto" };
  const cab = obj(it.Cabecalho);
  if (!cab) return { ok: false, motivo: "sem Cabecalho" };
  const nCodOS = inteiroPositivo(cab.nCodOS);
  if (nCodOS === null) return { ok: false, motivo: `nCodOS ilegível: ${JSON.stringify(cab.nCodOS ?? null)}` };
  const info = obj(it.InfoCadastro) ?? {};
  const parcelas = listaParcelas(it.Parcelas);
  const brutoValor = cab.nValorTotal;
  const faltaCab = CONTRATO_CABECALHO.find((k) => !(k in cab));
  const infoObj = obj(it.InfoCadastro);
  const faltaInfo = infoObj ? CONTRATO_INFO.find((k) => !(k in infoObj)) : "InfoCadastro";
  const contrato = faltaCab ? `Cabecalho.${faltaCab}` : faltaInfo ? (infoObj ? `InfoCadastro.${faltaInfo}` : faltaInfo) : null;
  return {
    ok: true,
    contrato,
    linha: {
      n_cod_os: nCodOS,
      c_num_os: texto(cab.cNumOS),
      c_cod_int_os: texto(cab.cCodIntOS),
      n_cod_cli: inteiroPositivo(cab.nCodCli),
      etapa: texto(cab.cEtapa),
      valor_total: valorMonetario(brutoValor),
      valor_bruto: brutoValor === undefined ? null : JSON.stringify(brutoValor),
      parcelas,
      n_parcelas: parcelas ? parcelas.length : null,
      prazo_max_dias: prazoMaxDias(parcelas, cab.nQtdeParc),
      faturada: simNao(info.cFaturada),
      cancelada: simNao(info.cCancelada),
      data_inclusao: dataOmie(info.dDtInc, info.cHrInc),
      data_alteracao: dataOmie(info.dDtAlt, info.cHrAlt),
      data_faturamento: dataOmie(info.dDtFat, info.cHrFat),
      payload: it,
    },
  };
}

/** A lista de OS da resposta. Só a chave conhecida (`osCadastro`) — o probe confirma; outra forma = malformada. */
export function extrairLista(resp: Record<string, unknown>): unknown[] | null {
  const v = resp.osCadastro;
  return Array.isArray(v) ? v : null;
}

/** Total declarado (`total_de_paginas`/`total_de_registros`): número ou string de dígitos; o resto → undefined. */
export function totalDeclarado(
  resp: Record<string, unknown>,
  chave: "total_de_paginas" | "total_de_registros" | "pagina" | "registros",
): number | undefined {
  const v = resp[chave];
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? v : undefined;
  if (typeof v === "string" && /^\s*\d+\s*$/.test(v)) return Number(v.trim());
  return undefined;
}
