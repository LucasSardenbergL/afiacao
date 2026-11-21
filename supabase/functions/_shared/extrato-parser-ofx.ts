// Parser OFX (1.x SGML e 2.x XML) do extrato Itaú. Puro e síncrono: bytes -> ResultadoParse.
// A cópia em supabase/functions/_shared/extrato-parser-ofx.ts difere SÓ na linha de import do núcleo
// (a edge roda sob `deno test --no-remote`); paridade provada em __tests__/nucleo.parity.test.ts.
//
// Money-path: precisão > recall. Qualquer dúvida (fuso ausente, valor ambíguo, data fora do período,
// mais de uma conta) vira RECUSA com motivo; nunca se fabrica número (ausente != 0).
import { decimalTextoParaCentavos, soDigitos } from './extrato-nucleo.ts';
import type { LinhaExtrato, ResultadoParse, MotivoRecusaParse } from './extrato-nucleo.ts';

class Recusa extends Error {
  constructor(
    readonly motivo: MotivoRecusaParse,
    readonly detalhe: string,
  ) {
    super(detalhe);
  }
}

function decodificar(bytes: Uint8Array): string {
  // Cabeçalho é ASCII: lê em latin1 só para descobrir CHARSET/ENCODING declarados.
  const cab = new TextDecoder('windows-1252').decode(bytes.subarray(0, 2048));
  const cs = /CHARSET\s*[:=]\s*"?([A-Za-z0-9_-]+)/i.exec(cab)?.[1]?.toUpperCase();
  const enc = /ENCODING\s*[:=]\s*"?([A-Za-z0-9_-]+)/i.exec(cab)?.[1]?.toUpperCase();
  if (cs === 'UTF-8' || enc === 'UTF-8') {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new Recusa('formato_desconhecido', 'bytes inválidos para UTF-8 declarado');
    }
  }
  const csOk = cs === undefined || ['1252', 'NONE', 'WINDOWS-1252', 'CP1252', '8859-1', 'ISO-8859-1', 'LATIN1'].includes(cs);
  const encOk = enc === undefined || enc === 'USASCII';
  if (!csOk || !encOk) throw new Recusa('formato_desconhecido', `CHARSET/ENCODING não suportado: ${cs ?? '-'}/${enc ?? '-'}`);
  return new TextDecoder('windows-1252').decode(bytes); // default do OFX 1.x
}

function decodificarEntidades(v: string): string {
  return v
    .replace(/&#(\d+);/g, (m, n: string) => {
      const c = Number(n);
      return c > 0 && c <= 0x10ffff ? String.fromCodePoint(c) : m;
    })
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
}

interface Token {
  tag: string;
  fecha: boolean;
  valor: string;
}

function tokenizar(corpo: string): Token[] {
  // Serve a SGML (valor vai até o próximo '<', sem tag de fechamento) e a XML (fechamento explícito).
  const re = /<(\/?)([A-Za-z][A-Za-z0-9.]*)>([^<]*)/g;
  const out: Token[] = [];
  for (const m of corpo.matchAll(re)) {
    out.push({ tag: m[2].toUpperCase(), fecha: m[1] === '/', valor: decodificarEntidades(m[3]).trim() });
  }
  return out;
}

function dataValida(a: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(a, m, 0)).getUTCDate();
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** 'YYYYMMDD...' -> dados da data; recusa data inexistente. */
function lerData(v: string, campo: string): { a: number; m: number; d: number; resto: string } {
  const x = /^(\d{4})(\d{2})(\d{2})(\d*)/.exec(v);
  if (!x) throw new Recusa('data_invalida', `${campo} ilegível`);
  const a = Number(x[1]);
  const m = Number(x[2]);
  const d = Number(x[3]);
  if (!dataValida(a, m, d)) throw new Recusa('data_invalida', `${campo} inexistente`);
  return { a, m, d, resto: x[4] };
}

const iso = (a: number, m: number, d: number) => `${pad(a, 4)}-${pad(m)}-${pad(d)}`;

function diaAnterior(a: number, m: number, d: number): string {
  const t = new Date(Date.UTC(a, m - 1, d - 1));
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

function dataSimples(v: string, campo: string): string {
  const { a, m, d } = lerData(v, campo);
  return iso(a, m, d);
}

function dataFim(v: string): string {
  const { a, m, d, resto } = lerData(v, 'DTEND');
  // Fim exclusivo: hora explícita 00:00:00 (com ou sem fração) pertence ao dia anterior.
  return /^000000(\.\d+)?$/.test(resto) ? diaAnterior(a, m, d) : iso(a, m, d);
}

/**
 * DTSERVER -> ISO com offset. Exige hora completa E fuso entre colchetes (não assume GMT).
 * Fuso OFX: [horas(.frac)(:NOME)]; meia hora/45min aceitos ([5.5:IST] -> +05:30); fração que não dá
 * minuto inteiro ou |offset| > 14h -> recusa. O texto após ':' é só o NOME do fuso.
 */
function lerGeradoEm(v: string): string {
  const x = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.\d+)?\[([+-]?\d{1,2}(?:\.\d+)?)(?::[A-Za-z0-9 ]*)?\]$/.exec(v);
  if (!x) throw new Recusa('data_invalida', 'DTSERVER sem hora completa e fuso explícito');
  const [a, m, d, h, mi, s] = x.slice(1, 7).map(Number);
  if (!dataValida(a, m, d) || h > 23 || mi > 59 || s > 59) throw new Recusa('data_invalida', 'DTSERVER inexistente');
  const horas = Number(x[7]);
  const minTotal = Math.abs(horas) * 60;
  if (!Number.isInteger(minTotal) || minTotal > 14 * 60) throw new Recusa('data_invalida', 'fuso do DTSERVER inválido');
  const sinal = horas < 0 || x[7].startsWith('-') ? '-' : '+';
  return `${iso(a, m, d)}T${pad(h)}:${pad(mi)}:${pad(s)}${sinal}${pad(Math.floor(minTotal / 60))}:${pad(minTotal % 60)}`;
}

/** Valor com sinal em centavos; ausente/ilegível -> recusa (nunca 0). */
function valorComSinal(v: string, campo: string): { negativo: boolean; centavos: number } {
  const c = decimalTextoParaCentavos(v);
  if (c === null) throw new Recusa('valor_invalido', `${campo} ilegível ou ambíguo`);
  return { negativo: v.trim().startsWith('-'), centavos: c };
}

function parse(bytes: Uint8Array): ResultadoParse {
  const texto = decodificar(bytes);
  const ini = texto.search(/<OFX[\s>]/i);
  if (ini < 0) throw new Recusa('formato_desconhecido', 'sem <OFX>');
  const tokens = tokenizar(texto.slice(ini));

  const topo = new Map<string, string>();
  let nStmt = 0;
  let saldo: string | undefined;
  let emLedger = false;
  let txn: Map<string, string> | null = null;
  const txns: Map<string, string>[] = [];
  const fechaTxn = () => {
    if (txn) txns.push(txn);
    txn = null;
  };

  for (const t of tokens) {
    if (t.tag === 'STMTRS' && !t.fecha) nStmt++;
    if (t.tag === 'STMTTRN') {
      fechaTxn();
      if (!t.fecha) txn = new Map();
      continue;
    }
    if (t.tag === 'BANKTRANLIST' && t.fecha) fechaTxn();
    if (t.tag === 'LEDGERBAL') {
      fechaTxn();
      emLedger = !t.fecha;
      continue;
    }
    if (t.tag === 'AVAILBAL') {
      fechaTxn();
      emLedger = false;
      continue;
    }
    if (t.fecha || (t.valor === '' && !txn)) continue;
    if (txn) {
      if (!txn.has(t.tag)) txn.set(t.tag, t.valor);
    } else if (emLedger) {
      if (t.tag === 'BALAMT' && saldo === undefined) saldo = t.valor;
    } else if (!topo.has(t.tag)) {
      topo.set(t.tag, t.valor);
    }
  }
  fechaTxn();

  if (nStmt > 1) throw new Recusa('formato_desconhecido', 'arquivo com mais de uma conta (STMTRS)');
  const exige = (campo: string, v: string | undefined): string => {
    if (v === undefined || v === '') throw new Recusa('campo_ausente', `${campo} ausente`);
    return v;
  };

  const geradoEm = lerGeradoEm(exige('DTSERVER', topo.get('DTSERVER')));
  const agencia = soDigitos(exige('BRANCHID', topo.get('BRANCHID')));
  if (agencia === '') throw new Recusa('campo_ausente', 'BRANCHID sem dígitos');
  const conta = soDigitos(exige('ACCTID', topo.get('ACCTID')));
  if (conta === '') throw new Recusa('campo_ausente', 'ACCTID sem dígitos');
  const bancoDig = soDigitos(topo.get('BANKID') ?? '');
  const banco = bancoDig === '' ? null : bancoDig;
  const periodoInicio = dataSimples(exige('DTSTART', topo.get('DTSTART')), 'DTSTART');
  const periodoFim = dataFim(exige('DTEND', topo.get('DTEND')));
  if (periodoFim < periodoInicio) {
    throw new Recusa('data_invalida', `DTEND ${periodoFim} anterior a DTSTART ${periodoInicio}`);
  }

  const sf = valorComSinal(exige('LEDGERBAL/BALAMT', saldo), 'BALAMT');
  const saldoFinalCentavos = sf.negativo && sf.centavos !== 0 ? -sf.centavos : sf.centavos;

  const linhas: LinhaExtrato[] = txns.map((x) => {
    const v = valorComSinal(exige('TRNAMT', x.get('TRNAMT')), 'TRNAMT');
    if (v.centavos === 0) throw new Recusa('valor_invalido', 'TRNAMT zero');
    const data = dataSimples(exige('DTPOSTED', x.get('DTPOSTED')), 'DTPOSTED');
    if (data < periodoInicio || data > periodoFim) {
      throw new Recusa('data_invalida', `DTPOSTED ${data} fora do período ${periodoInicio}..${periodoFim}`);
    }
    const memo = x.get('MEMO');
    const name = x.get('NAME');
    return {
      data,
      sentido: v.negativo ? 'D' : 'C',
      valorCentavos: v.centavos,
      descricao: memo ? memo : (name ?? ''),
      documento: x.get('CHECKNUM') || x.get('REFNUM') || null,
      idBancario: x.get('FITID') || null,
    };
  });

  return {
    ok: true,
    extrato: {
      formato: 'ofx',
      banco,
      agencia,
      conta,
      periodoInicio,
      periodoFim,
      saldoInicialCentavos: null, // OFX não traz saldo inicial: ausente != 0
      saldoFinalCentavos,
      linhas,
      geradoEm,
    },
  };
}

export function parseOfx(bytes: Uint8Array): ResultadoParse {
  try {
    return parse(bytes);
  } catch (e) {
    if (e instanceof Recusa) return { ok: false, motivo: e.motivo, detalhe: e.detalhe };
    throw e;
  }
}
