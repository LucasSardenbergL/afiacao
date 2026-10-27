// Lookup ESTRITO do cliente por documento antes do `IncluirCliente` (action `criar_cliente`). Achado 4 do Codex no
// PR #3293: o lookup antigo pegava o 1º registro do ListarClientes e lia resposta MALFORMADA como "não existe" →
// IncluirCliente; com dois códigos Omie para o mesmo documento, o erro passava calado (a chave determinística
// `codigo_cliente_integracao` só barra repetir a MESMA chave). Aqui:
//   - "não existe" só com ausência PROVADA (1ª página vazia e válida);
//   - resposta inválida, ou paginação que não chega à página vazia dentro do guard → OMIE_LOOKUP_INDETERMINADO;
//   - registro com OUTRO documento → OMIE_LOOKUP_DIVERGENTE (o contrato de antes, agora em TODOS os registros);
//   - 2+ códigos distintos para o documento → OMIE_LOOKUP_AMBIGUO (terminal: só um humano no Omie resolve).
// PURO: o fetch da página é INJETADO (index.ts passa o callOmieVendasApi com throwOnTransient) → testável com
// `--no-remote` (lookup-cliente-estrito_test.ts). Diário docs/historico/omie-lookup-cliente-estrito.md.
import { documentoParaCadastro } from "../_shared/cnpj-alfanumerico.ts";
import { lookupDevolveuOMesmoDocumento } from "../_shared/lookup-documento.ts";

export interface ClienteEncontrado {
  codigo_cliente: number;
  razao_social: string | null;
  codigo_vendedor: number | null;
  cnpj_cpf: string;
}

/**
 * Página crua do ListarClientes; `null` = fault "Não existem registros para a página" (fim REAL do Omie). `prazo` é o
 * fim ABSOLUTO do lookup inteiro (ms, mesmo relógio de `agora`): o transporte não pode passar dele (Codex P2).
 */
export type ListarPagina = (pagina: number, porPagina: number, prazo: number) => Promise<unknown>;

const LOOKUP_POR_PAGINA = 50;
const LOOKUP_MAX_PAGINAS = 10;
/**
 * Orçamento do lookup INTEIRO. Vai ao transporte como prazo absoluto (cada ListarClientes para nele, em vez do teto
 * próprio de 140s) e é conferido de novo depois de cada resposta. 40s deixam ~110s dos 150s da edge para o
 * IncluirCliente/IncluirPedido que vem depois (Codex P2, v1.28). Estourou = INDETERMINADO/TRANSIENT, retentável.
 */
const LOOKUP_ORCAMENTO_MS = 40_000;

const lookupIndeterminado = (account: string, motivo: string) =>
  new Error(`OMIE_LOOKUP_INDETERMINADO (${account}): ${motivo} — não dá pra afirmar que o cliente não existe`);

const ehObjeto = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Inteiro ≥ 0 de um campo de controle do Omie: número inteiro seguro ou string decimal. `undefined` = ausente. */
function inteiroDeControle(v: unknown): number | undefined | "invalido" {
  if (v === undefined) return undefined;
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? v : "invalido";
  if (typeof v === "string" && /^[0-9]{1,15}$/.test(v)) return Number(v);
  return "invalido"; // null, boolean, array, objeto: `Number(true) === 1` não pode virar eco válido (Codex)
}

interface PaginaLida {
  /** Registros VÁLIDOS da página (com o documento pedido). */
  registros: ClienteEncontrado[];
  /** Fim real: `null` do Omie ou `clientes_cadastro: []` sem contradição. */
  vazia: boolean;
  /** 1º defeito da página (INDETERMINADO/DIVERGENTE) — lançado só DEPOIS de conferir a multiplicidade (Codex). */
  erro: Error | null;
}

/**
 * Lê UMA página sem lançar no 1º defeito de registro: dois códigos válidos distintos com o documento pedido já
 * provam a ambiguidade (terminal), e um registro malformado ao lado deles não pode rebaixá-la a INDETERMINADO
 * (retentável). Só o que impede ler os registros (não-objeto, sem array) lança aqui.
 */
function lerPagina(resp: unknown, pagina: number, docClean: string, account: string): PaginaLida {
  if (resp === null) return { registros: [], vazia: true, erro: null };
  if (!ehObjeto(resp)) throw lookupIndeterminado(account, `página ${pagina} não é um objeto`);
  const arr = resp.clientes_cadastro;
  if (!Array.isArray(arr)) throw lookupIndeterminado(account, `página ${pagina} sem clientes_cadastro`);
  let erro: Error | null = null;
  const anotar = (e: Error) => {
    erro ??= e;
  };
  // O eco da página, quando vem, tem de ser a pedida: um Omie que ignora `pagina` repetiria a 1ª até o guard.
  const eco = inteiroDeControle(resp.pagina);
  if (eco !== undefined && eco !== pagina) {
    anotar(lookupIndeterminado(account, `pedi a página ${pagina} e veio a ${JSON.stringify(resp.pagina)}`));
  }
  // A contagem da própria página, quando vem, não pode contradizer o array: `{registros:1, clientes_cadastro:[]}`
  // não é ausência provada (e um array mais curto que a contagem esconderia um 2º código).
  const contagem = inteiroDeControle(resp.registros);
  if (contagem !== undefined && contagem !== arr.length) {
    anotar(lookupIndeterminado(account, `página ${pagina} diz ${JSON.stringify(resp.registros)} registro(s) e traz ${arr.length}`));
  }
  const registros: ClienteEncontrado[] = [];
  arr.forEach((c, i) => {
    if (!ehObjeto(c)) return anotar(lookupIndeterminado(account, `registro ${i} da página ${pagina} não é um objeto`));
    const codigo = c.codigo_cliente_omie;
    if (typeof codigo !== "number" || !Number.isSafeInteger(codigo) || codigo <= 0) {
      return anotar(lookupIndeterminado(account, `registro ${i} da página ${pagina} sem codigo_cliente_omie inteiro positivo`));
    }
    if (typeof c.cnpj_cpf !== "string") {
      return anotar(lookupIndeterminado(account, `registro ${i} da página ${pagina} sem cnpj_cpf`));
    }
    // O helper aplica a gramática ESTRITA ao documento devolvido (letra fora do CNPJ alfanumérico não casa
    // pelos dígitos — #3359): documento malformado nunca prova identidade.
    if (!lookupDevolveuOMesmoDocumento(docClean, c.cnpj_cpf)) {
      return anotar(new Error(`OMIE_LOOKUP_DIVERGENTE (${account}): o ListarClientes devolveu um cliente com OUTRO documento — não dá pra afirmar identidade`));
    }
    const rec = ehObjeto(c.recomendacoes) ? c.recomendacoes : {};
    const vendedor = rec.codigo_vendedor || c.codigo_vendedor || null;
    registros.push({
      codigo_cliente: codigo,
      razao_social: typeof c.razao_social === "string" ? c.razao_social : null,
      codigo_vendedor: typeof vendedor === "number" ? vendedor : null,
      cnpj_cpf: c.cnpj_cpf,
    });
  });
  return { registros, vazia: arr.length === 0, erro };
}

/**
 * `null` = ausência PROVADA. Pagina até a página vazia (não confia em `total_de_paginas`) com guard de
 * `maxPaginas` e de `orcamentoMs`; erro transitório do Omie já vem como throw do `listarPagina`
 * (throwOnTransient). Ordem da decisão em cada página:
 *   1. MULTIPLICIDADE: 2+ códigos válidos distintos → AMBIGUO na hora — nem uma página seguinte transitória,
 *      nem um registro malformado, nem o relógio o rebaixam a erro retentável (Codex);
 *   2. ORÇAMENTO: conferido DEPOIS de cada resposta, inclusive a 1ª página vazia — página que chegou tarde
 *      nunca prova ausência nem unicidade (o relógio de 140s de cada chamada não limita o lookup inteiro);
 *   3. defeito da página → INDETERMINADO/DIVERGENTE;
 *   4. página vazia → fim real (ausência ou unicidade); senão, próxima página.
 * Código repetido = o mesmo cliente (vale o 1º registro dele, vendedor incluso).
 */
export async function buscarClienteEstrito(
  docClean: string,
  account: string,
  listarPagina: ListarPagina,
  opts: { porPagina?: number; maxPaginas?: number; orcamentoMs?: number; agora?: () => number } = {},
): Promise<ClienteEncontrado | null> {
  const porPagina = opts.porPagina ?? LOOKUP_POR_PAGINA;
  const maxPaginas = opts.maxPaginas ?? LOOKUP_MAX_PAGINAS;
  const orcamentoMs = opts.orcamentoMs ?? LOOKUP_ORCAMENTO_MS;
  const agora = opts.agora ?? Date.now;
  const inicio = agora();
  const porCodigo = new Map<string, ClienteEncontrado>();
  for (let pagina = 1; pagina <= maxPaginas; pagina++) {
    const lida = lerPagina(await listarPagina(pagina, porPagina, inicio + orcamentoMs), pagina, docClean, account);
    // O mesmo código repetido entre páginas é o MESMO cliente; ambíguo é código DISTINTO.
    for (const r of lida.registros) if (!porCodigo.has(String(r.codigo_cliente))) porCodigo.set(String(r.codigo_cliente), r);
    if (porCodigo.size > 1) {
      throw new Error(
        `OMIE_LOOKUP_AMBIGUO (${account}): o Omie tem 2+ clientes com este documento (códigos ${[...porCodigo.keys()].join(", ")}) — confira o cadastro no Omie antes de vincular`,
      );
    }
    if (agora() - inicio > orcamentoMs) {
      throw lookupIndeterminado(account, `o lookup passou de ${orcamentoMs / 1000}s (página ${pagina})`);
    }
    if (lida.erro) throw lida.erro;
    if (lida.vazia) return porCodigo.size === 1 ? [...porCodigo.values()][0] : null;
  }
  throw lookupIndeterminado(account, `a paginação não chegou à página vazia em ${maxPaginas} páginas`);
}

/**
 * Identidade do `criar_pedido` (`decideAccountIdentity`): o MESMO lookup estrito, no formato de 0 ou 1 match. O
 * lookup antigo (`registros_por_pagina:2`, `?? []`, `filter` sem código, sem conferir documento) lia malformado como
 * ausência, descartava calado um 2º registro sem código e roteava o pedido para um cliente de OUTRO documento.
 * Aqui ambíguo/divergente/indeterminado LANÇAM (com a marca) e o chamador rejeita o envio.
 */
export async function matchesDoPedido(
  docClean: string,
  account: string,
  listarPagina: ListarPagina,
  opts?: Parameters<typeof buscarClienteEstrito>[3],
): Promise<Array<{ codigo_cliente: number; codigo_vendedor: number | null }>> {
  const c = await buscarClienteEstrito(docClean, account, listarPagina, opts);
  return c ? [{ codigo_cliente: c.codigo_cliente, codigo_vendedor: c.codigo_vendedor }] : [];
}

/** Marca do lookup estrito no erro (`OMIE_LOOKUP_AMBIGUO`/`_DIVERGENTE`/`_INDETERMINADO`), ou null — transitório não é. */
function marcaDoLookup(e: unknown): string | null {
  const m = e instanceof Error ? /^(OMIE_LOOKUP_(?:AMBIGUO|DIVERGENTE|INDETERMINADO)) \(/.exec(e.message) : null;
  return m ? m[1] : null;
}

/**
 * O que o `criar_pedido` lança quando o lookup da identidade falha: marca do lookup estrito → `Pedido rejeitado: …
 * (marca)` (o prefixo que os chamadores já tratam como recusa); o resto — `OMIE_TRANSIENT` incluso — passa INTACTO.
 */
export function erroDeIdentidadeDoPedido(e: unknown, account: string): unknown {
  const marca = marcaDoLookup(e);
  if (!marca) return e;
  return new Error(
    `Pedido rejeitado: identidade Omie do cliente na conta ${account} não pôde ser provada (${marca}) — envio bloqueado para não registrar no cliente errado. ${(e as Error).message}`,
  );
}

/**
 * Documento do pedido (sales_orders.customer_document ou o fallback profiles.document) pela gramática ESTRITA.
 * Vazio → "" (o chamador cai no fallback/recusa como antes); fora da gramática → `Pedido rejeitado`, nunca o
 * documento reduzido aos dígitos (`123ABC45678909` era o CPF 12345678909 de OUTRA pessoa — Codex ALTO, v1.28).
 */
export function docDoPedido(bruto: unknown): string {
  if (String(bruto ?? "").trim() === "") return "";
  try {
    return documentoParaCadastro(bruto);
  } catch (e) {
    throw new Error(
      `Pedido rejeitado: documento do cliente fora da gramática CPF/CNPJ (${(e as Error).message}) — envio bloqueado para não derivar a identidade de OUTRO documento`,
    );
  }
}
