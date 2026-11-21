// Parser OFX (1.x SGML e 2.x XML) do extrato Itaú. Puro e síncrono: bytes -> ResultadoParse.
// A cópia em supabase/functions/_shared/extrato-parser-ofx.ts difere SÓ na linha de import do núcleo
// (a edge roda sob `deno test --no-remote`); paridade provada em __tests__/nucleo.parity.test.ts.
//
// Money-path: precisão > recall. Qualquer dúvida (fuso ausente, valor ambíguo, data fora do período,
// mais de uma conta) vira RECUSA com motivo; nunca se fabrica número (ausente != 0).
//
// v2 (layout REAL do Itaú Bankline, medido na T0 da F1 — só agregados no plano, apêndice "Task 0"):
//  - R22 sem BRANCHID: BANKID 341/0341 + ACCTID de 10 dígitos = agência(4) + conta c/ DV(6).
//  - R23 linhas `SALDO ANTERIOR` / `SALDO TOTAL DISPONÍVEL DIA` vêm como STMTTRN: NÃO viram lançamento;
//    viram saldo inicial / final, com encadeamento diário obrigatório. Outro rótulo `SALDO*` -> recusa.
//  - R24 LEDGERBAL só é saldo final se DTASOF = último dia do período (o Bankline manda o saldo de HOJE).
//  - R25 bytes UTF-8 válidos ganham do CHARSET 1252 declarado.
//  - R26 CHECKNUM == FITID (posicional) -> documento null, para não contaminar a chave `tupla`.
// Isso derruba a regra antiga "saldoInicial sempre null no OFX": agora ele vem do SALDO ANTERIOR do
// próprio arquivo, quando existe; sem ele, continua null (nunca 0).
import { decimalTextoParaCentavos, normalizarDescricao, soDigitos } from './extrato-nucleo.ts';
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
  // R25: o Bankline declara USASCII/1252 mas grava UTF-8 (T0: acento só nos rótulos de SALDO). Bytes
  // UTF-8 válidos -> UTF-8 (ASCII puro dá o mesmo texto nos dois); senão, o 1252 declarado (default 1.x).
  // Um 1252 real com acento quase nunca é UTF-8 válido (0xC7 seguido de ASCII é sequência quebrada).
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
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

function analisarOfx(bytes: Uint8Array): ResultadoParse {
  const texto = decodificar(bytes);
  const ini = texto.search(/<OFX[\s>]/i);
  if (ini < 0) throw new Recusa('formato_desconhecido', 'sem <OFX>');
  const tokens = tokenizar(texto.slice(ini));

  const topo = new Map<string, string>();
  let nStmt = 0;
  let saldo: string | undefined;
  let saldoEm: string | undefined;
  let emLedger = false;
  let nLedger = 0;
  const fechados = new Set<string>(); // agregados com tag de fechamento vista (truncamento -> recusa)
  let txn: Map<string, string> | null = null;
  const txns: Map<string, string>[] = [];
  const fechaTxn = () => {
    if (txn) txns.push(txn);
    txn = null;
  };

  for (const t of tokens) {
    if (t.fecha) fechados.add(t.tag);
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
      if (!t.fecha) nLedger++;
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
      if (t.tag === 'DTASOF' && saldoEm === undefined) saldoEm = t.valor;
    } else if (!topo.has(t.tag)) {
      topo.set(t.tag, t.valor);
    }
  }
  fechaTxn();

  if (nStmt > 1) throw new Recusa('formato_desconhecido', 'arquivo com mais de uma conta (STMTRS)');
  if (nLedger > 1) throw new Recusa('formato_desconhecido', 'mais de um LEDGERBAL (valor e data ambiguos)');
  // Arquivo truncado não pode passar: com SALDO DIA o LEDGERBAL (que vem DEPOIS da lista) deixou de ser
  // exigido, então um corte logo após um SALDO DIA fecharia "certinho" com período cheio e saldo velho.
  for (const ag of ['BANKTRANLIST', 'STMTRS', 'OFX']) {
    if (!fechados.has(ag)) throw new Recusa('formato_desconhecido', `arquivo truncado: sem </${ag}>`);
  }
  const exige = (campo: string, v: string | undefined): string => {
    if (v === undefined || v === '') throw new Recusa('campo_ausente', `${campo} ausente`);
    return v;
  };

  const geradoEm = lerGeradoEm(exige('DTSERVER', topo.get('DTSERVER')));
  const bankidCru = topo.get('BANKID') ?? '';
  const bancoDig = soDigitos(bankidCru);
  const banco = bancoDig === '' ? null : bancoDig;
  const { agencia, conta } = identidadeDaConta(bankidCru, topo.get('BRANCHID'), exige('ACCTID', topo.get('ACCTID')));
  const periodoInicio = dataSimples(exige('DTSTART', topo.get('DTSTART')), 'DTSTART');
  const dtendCru = exige('DTEND', topo.get('DTEND'));
  const periodoFim = dataFim(dtendCru);
  if (periodoFim < periodoInicio) {
    throw new Recusa('data_invalida', `DTEND ${periodoFim} anterior a DTSTART ${periodoInicio}`);
  }

  const linhas: LinhaExtrato[] = [];
  const saldosDia = new Map<string, number>(); // data -> SALDO DIA (centavos com sinal)
  const posSaldoDia = new Map<string, number>(); // data -> posição da linha SALDO DIA no arquivo
  const ultimoMovDia = new Map<string, number>(); // data -> posição do último movimento do dia
  let saldoAnterior: number | null = null;
  const vespera = diaAnteriorIso(periodoInicio);
  for (const [pos, x] of txns.entries()) {
    const memo = x.get('MEMO');
    const name = x.get('NAME');
    const descricao = memo ? memo : (name ?? '');
    const v = valorComSinal(exige('TRNAMT', x.get('TRNAMT')), 'TRNAMT');
    const data = dataSimples(exige('DTPOSTED', x.get('DTPOSTED')), 'DTPOSTED');
    const rotulo = rotuloDeSaldo(memo, name);
    if (rotulo !== null) {
      // R23: linha de SALDO do Bankline não é lançamento. Allowlist EXATA; rótulo desconhecido -> recusa
      // (se o Itaú mudar o texto, o arquivo para aqui em vez de virar lançamento fabricado).
      const valor = v.negativo && v.centavos !== 0 ? -v.centavos : v.centavos;
      const tipo = x.get('TRNTYPE');
      if ((tipo === 'DEBIT' && valor > 0) || (tipo === 'CREDIT' && valor < 0)) {
        throw new Recusa('valor_invalido', `linha de SALDO com TRNTYPE ${tipo} incoerente com o sinal`);
      }
      if (rotulo === ROTULO_SALDO_ANTERIOR) {
        if (saldoAnterior !== null) throw new Recusa('formato_desconhecido', 'mais de um SALDO ANTERIOR');
        if (data !== vespera) {
          throw new Recusa('data_invalida', `SALDO ANTERIOR fora da vespera do DTSTART (${data}, esperado ${vespera})`);
        }
        saldoAnterior = valor;
      } else if (rotulo === ROTULO_SALDO_DIA) {
        if (data < periodoInicio || data > periodoFim) {
          throw new Recusa('data_invalida', `SALDO DIA fora do periodo (${data} em ${periodoInicio}..${periodoFim})`);
        }
        if (saldosDia.has(data)) throw new Recusa('formato_desconhecido', `mais de um SALDO DIA em ${data}`);
        saldosDia.set(data, valor);
        posSaldoDia.set(data, pos);
      } else {
        throw new Recusa('formato_desconhecido', `rotulo SALDO desconhecido: ${rotulo.slice(0, 40)}`);
      }
      continue;
    }
    if (v.centavos === 0) throw new Recusa('valor_invalido', 'TRNAMT zero');
    if (data < periodoInicio || data > periodoFim) {
      throw new Recusa('data_invalida', `DTPOSTED ${data} fora do período ${periodoInicio}..${periodoFim}`);
    }
    ultimoMovDia.set(data, pos);
    const fitid = x.get('FITID') || null;
    // R26: CHECKNUM/REFNUM igual ao FITID é posicional (data + nº da linha no dia, T0) — como documento
    // contaminaria a chave `tupla` com a posição. Só vale documento que não seja cópia do FITID.
    const naoFitid = (d: string | undefined) => (d && d !== fitid ? d : null);
    const documento = naoFitid(x.get('CHECKNUM')) ?? naoFitid(x.get('REFNUM'));
    linhas.push({ data, sentido: v.negativo ? 'D' : 'C', valorCentavos: v.centavos, descricao, documento, idBancario: fitid });
  }

  let saldoInicialCentavos: number | null = null;
  let saldoFinalCentavos: number;
  if (saldosDia.size > 0) {
    // R23: com SALDO DIA, o arquivo se ancora sozinho — e só se o encadeamento diário fechar.
    if (saldoAnterior === null) throw new Recusa('campo_ausente', 'SALDO ANTERIOR ausente com SALDO DIA presente');
    // A linha SALDO DIA fecha o dia (T0: última do dia em 100%): movimento depois dela -> recusa.
    for (const [d, p] of posSaldoDia) {
      if ((ultimoMovDia.get(d) ?? -1) > p) throw new Recusa('formato_desconhecido', `movimento depois do SALDO DIA em ${d}`);
    }
    saldoFinalCentavos = encadear(saldoAnterior, linhas, saldosDia);
    saldoInicialCentavos = saldoAnterior;
    // Se o LEDGERBAL for do MESMO corte (fim do período), as duas fontes têm de concordar.
    if (saldo !== undefined && ledgerElegivel(saldoEm, dtendCru, periodoFim)) {
      const lb = valorComSinal(saldo, 'BALAMT');
      const lbc = lb.negativo && lb.centavos !== 0 ? -lb.centavos : lb.centavos;
      if (lbc !== saldoFinalCentavos) {
        throw new Recusa('valor_invalido', `LEDGERBAL do fim do periodo diverge do SALDO DIA (diferenca ${lbc - saldoFinalCentavos})`);
      }
    }
  } else {
    // R24: o LEDGERBAL do Bankline é o saldo de HOJE (DTASOF = DTSERVER), não o do fim do período.
    // Só vale como saldo final quando o DTASOF é o fechamento do último dia; fora disso, ausente.
    const sf = valorComSinal(exige('LEDGERBAL/BALAMT', saldo), 'BALAMT');
    if (saldoEm === undefined || saldoEm === '') throw new Recusa('campo_ausente', 'LEDGERBAL sem data: DTASOF ausente');
    if (!ledgerElegivel(saldoEm, dtendCru, periodoFim)) {
      throw new Recusa('campo_ausente', `saldo final: LEDGERBAL fora do fim do periodo (fim ${periodoFim}) e sem SALDO DIA`);
    }
    saldoFinalCentavos = sf.negativo && sf.centavos !== 0 ? -sf.centavos : sf.centavos;
    saldoInicialCentavos = saldoAnterior; // SALDO ANTERIOR sozinho ainda é saldo inicial real; sem ele, null
  }

  return {
    ok: true,
    extrato: {
      formato: 'ofx',
      banco,
      agencia,
      conta,
      periodoInicio,
      periodoFim,
      saldoInicialCentavos, // só do SALDO ANTERIOR do arquivo; ausente fica null, nunca 0
      saldoFinalCentavos,
      linhas,
      geradoEm,
    },
  };
}

// Rótulos medidos no Bankline (T0), já normalizados (maiúsculas, sem acento, espaço único).
const ROTULO_SALDO_ANTERIOR = 'SALDO ANTERIOR';
const ROTULO_SALDO_DIA = 'SALDO TOTAL DISPONIVEL DIA';

const ehRotuloSaldo = (r: string) => /(^|[^A-Z0-9])SALDO([^A-Z0-9]|$)/.test(r);

/**
 * Rótulo de SALDO da linha (normalizado) ou null se for movimento. Olha MEMO E NAME: um rótulo de saldo
 * em qualquer dos dois marca a linha; se os dois falam e divergem, ou o rótulo não é EXATO, recusa.
 */
function rotuloDeSaldo(memo: string | undefined, name: string | undefined): string | null {
  const rs = [memo, name].map((t) => normalizarDescricao(t ?? '')).filter((r) => r !== '');
  if (!rs.some(ehRotuloSaldo)) return null;
  const rotulo = rs.find(ehRotuloSaldo) ?? '';
  if (rs.some((r) => r !== rotulo)) throw new Recusa('formato_desconhecido', 'linha de SALDO com MEMO e NAME divergentes');
  if (rotulo !== ROTULO_SALDO_ANTERIOR && rotulo !== ROTULO_SALDO_DIA) {
    throw new Recusa('formato_desconhecido', `rotulo SALDO desconhecido: ${rotulo.slice(0, 40)}`);
  }
  return rotulo;
}

/**
 * R24: o DTASOF é o fechamento do último dia? Meia-noite (00:00:00) é ambígua — só vale se for o MESMO
 * instante do DTEND exclusivo (o fim do período). Com outra hora (ou só data), o dia tem de ser o fim.
 */
function ledgerElegivel(dtasof: string | undefined, dtendCru: string, periodoFim: string): boolean {
  if (dtasof === undefined || dtasof === '') return false;
  const { a, m, d, resto } = lerData(dtasof, 'DTASOF');
  if (/^000000(\.\d+)?($|\[)/.test(resto)) {
    const fim = lerData(dtendCru, 'DTEND');
    return /^000000(\.\d+)?($|\[)/.test(fim.resto) && iso(a, m, d) === iso(fim.a, fim.m, fim.d);
  }
  return iso(a, m, d) === periodoFim;
}

function diaAnteriorIso(isoData: string): string {
  const [a, m, d] = isoData.split('-').map(Number);
  return diaAnterior(a, m, d);
}

/**
 * R23: saldo anterior + movimentos de cada dia = SALDO DIA daquele dia, em TODO dia com movimento;
 * SALDO DIA só existe em dia com movimento (T0: 1 por dia com movimento). Devolve o último SALDO DIA.
 */
function encadear(saldoAnterior: number, linhas: LinhaExtrato[], saldosDia: Map<string, number>): number {
  const movDia = new Map<string, number>();
  for (const l of linhas) movDia.set(l.data, (movDia.get(l.data) ?? 0) + (l.sentido === 'C' ? l.valorCentavos : -l.valorCentavos));
  for (const d of saldosDia.keys()) {
    if (!movDia.has(d)) throw new Recusa('formato_desconhecido', `SALDO DIA em dia sem movimento (${d})`);
  }
  let corrente = saldoAnterior;
  for (const d of [...movDia.keys()].sort()) {
    const sd = saldosDia.get(d);
    if (sd === undefined) throw new Recusa('formato_desconhecido', `dia com movimento sem SALDO DIA (${d})`);
    corrente += movDia.get(d) ?? 0;
    if (corrente !== sd) {
      throw new Recusa('valor_invalido', `SALDO DIA nao fecha em ${d}: encadeado ${corrente}, arquivo ${sd} (diferenca ${sd - corrente})`);
    }
  }
  return corrente;
}

/**
 * Agência e conta (só dígitos). Com BRANCHID: como sempre. R22 — Itaú Bankline sem BRANCHID: BANKID
 * 341/0341 e ACCTID de EXATAMENTE 10 dígitos = agência(4) + conta com DV(6). Qualquer outra forma ->
 * campo_ausente. Corte errado não passa calado: a RPC confere banco/agência/conta contra o cadastro
 * (`conta_divergente`).
 */
function identidadeDaConta(bankidCru: string, branchid: string | undefined, acctid: string): { agencia: string; conta: string } {
  if (branchid !== undefined && branchid !== '') {
    const agencia = soDigitos(branchid);
    if (agencia === '') throw new Recusa('campo_ausente', 'BRANCHID sem dígitos');
    const conta = soDigitos(acctid);
    if (conta === '') throw new Recusa('campo_ausente', 'ACCTID sem dígitos');
    return { agencia, conta };
  }
  if (/^0?341$/.test(bankidCru) && /^\d{10}$/.test(acctid)) {
    return { agencia: acctid.slice(0, 4), conta: acctid.slice(4) };
  }
  throw new Recusa('campo_ausente', 'BRANCHID ausente (e ACCTID fora do layout Itau agencia4+conta6)');
}

export function parseOfx(bytes: Uint8Array): ResultadoParse {
  try {
    return analisarOfx(bytes);
  } catch (e) {
    if (e instanceof Recusa) return { ok: false, motivo: e.motivo, detalhe: e.detalhe };
    throw e;
  }
}
