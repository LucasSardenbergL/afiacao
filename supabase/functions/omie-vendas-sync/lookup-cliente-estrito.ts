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
import { lookupDevolveuOMesmoDocumento } from "../_shared/lookup-documento.ts";

export interface ClienteEncontrado {
  codigo_cliente: number;
  razao_social: string | null;
  codigo_vendedor: number | null;
  cnpj_cpf: string;
}

/** Página crua do ListarClientes; `null` = fault "Não existem registros para a página" (fim REAL do Omie). */
export type ListarPagina = (pagina: number, porPagina: number) => Promise<unknown>;

export const LOOKUP_POR_PAGINA = 50;
export const LOOKUP_MAX_PAGINAS = 10;
/** Orçamento do lookup inteiro: cada chamada tem o próprio relógio de 140s, mas a action não cabe em N deles. */
export const LOOKUP_ORCAMENTO_MS = 60_000;

const indeterminado = (account: string, motivo: string) =>
  new Error(`OMIE_LOOKUP_INDETERMINADO (${account}): ${motivo} — não dá pra afirmar que o cliente não existe`);

const ehObjeto = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Inteiro ≥ 0 de um campo de controle do Omie: número inteiro seguro ou string decimal. `undefined` = ausente. */
function inteiroDeControle(v: unknown): number | undefined | "invalido" {
  if (v === undefined) return undefined;
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? v : "invalido";
  if (typeof v === "string" && /^[0-9]{1,15}$/.test(v)) return Number(v);
  return "invalido"; // null, boolean, array, objeto: `Number(true) === 1` não pode virar eco válido (Codex)
}

/** Valida UMA página; devolve os registros (vazio = fim real). Lança INDETERMINADO/DIVERGENTE. */
function registrosDaPagina(resp: unknown, pagina: number, docClean: string, account: string): ClienteEncontrado[] {
  if (resp === null) return [];
  if (!ehObjeto(resp)) throw indeterminado(account, `página ${pagina} não é um objeto`);
  // O eco da página, quando vem, tem de ser a pedida: um Omie que ignora `pagina` repetiria a 1ª até o guard.
  const eco = inteiroDeControle(resp.pagina);
  if (eco !== undefined && eco !== pagina) {
    throw indeterminado(account, `pedi a página ${pagina} e veio a ${JSON.stringify(resp.pagina)}`);
  }
  const arr = resp.clientes_cadastro;
  if (!Array.isArray(arr)) throw indeterminado(account, `página ${pagina} sem clientes_cadastro`);
  // A contagem da própria página, quando vem, não pode contradizer o array: `{registros:1, clientes_cadastro:[]}`
  // não é ausência provada (e um array mais curto que a contagem esconderia um 2º código).
  const contagem = inteiroDeControle(resp.registros);
  if (contagem !== undefined && contagem !== arr.length) {
    throw indeterminado(account, `página ${pagina} diz ${JSON.stringify(resp.registros)} registro(s) e traz ${arr.length}`);
  }
  return arr.map((c, i) => {
    if (!ehObjeto(c)) throw indeterminado(account, `registro ${i} da página ${pagina} não é um objeto`);
    const codigo = c.codigo_cliente_omie;
    if (typeof codigo !== "number" || !Number.isSafeInteger(codigo) || codigo <= 0) {
      throw indeterminado(account, `registro ${i} da página ${pagina} sem codigo_cliente_omie inteiro positivo`);
    }
    if (typeof c.cnpj_cpf !== "string") {
      throw indeterminado(account, `registro ${i} da página ${pagina} sem cnpj_cpf`);
    }
    // O helper aplica a gramática ESTRITA ao documento devolvido (letra fora do CNPJ alfanumérico não casa
    // pelos dígitos — #3359): documento malformado nunca prova identidade.
    if (!lookupDevolveuOMesmoDocumento(docClean, c.cnpj_cpf)) {
      throw new Error(`OMIE_LOOKUP_DIVERGENTE (${account}): o ListarClientes devolveu um cliente com OUTRO documento — não dá pra afirmar identidade`);
    }
    const rec = ehObjeto(c.recomendacoes) ? c.recomendacoes : {};
    const vendedor = rec.codigo_vendedor || c.codigo_vendedor || null;
    return {
      codigo_cliente: codigo,
      razao_social: typeof c.razao_social === "string" ? c.razao_social : null,
      codigo_vendedor: typeof vendedor === "number" ? vendedor : null,
      cnpj_cpf: c.cnpj_cpf,
    };
  });
}

/**
 * `null` = ausência PROVADA. Pagina até a página vazia (não confia em `total_de_paginas`) com guard de
 * `maxPaginas` e de `orcamentoMs`; erro transitório do Omie já vem como throw do `listarPagina`
 * (throwOnTransient). Página vazia é exigida para concluir ausência ou UNICIDADE; a MULTIPLICIDADE já está
 * provada na página que a mostrou — AMBIGUO sai na hora, sem uma página seguinte transitória rebaixá-lo a
 * erro retentável (Codex). Código repetido = o mesmo cliente (vale o 1º registro dele, vendedor incluso).
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
  let fimReal = false;
  for (let pagina = 1; pagina <= maxPaginas; pagina++) {
    if (pagina > 1 && agora() - inicio > orcamentoMs) {
      throw indeterminado(account, `o lookup passou de ${orcamentoMs / 1000}s antes da página ${pagina}`);
    }
    const registros = registrosDaPagina(await listarPagina(pagina, porPagina), pagina, docClean, account);
    if (registros.length === 0) {
      fimReal = true;
      break;
    }
    // O mesmo código repetido entre páginas é o MESMO cliente; ambíguo é código DISTINTO.
    for (const r of registros) if (!porCodigo.has(String(r.codigo_cliente))) porCodigo.set(String(r.codigo_cliente), r);
    if (porCodigo.size > 1) {
      throw new Error(
        `OMIE_LOOKUP_AMBIGUO (${account}): o Omie tem 2+ clientes com este documento (códigos ${[...porCodigo.keys()].join(", ")}) — confira o cadastro no Omie antes de vincular`,
      );
    }
  }
  if (!fimReal) throw indeterminado(account, `a paginação não chegou à página vazia em ${maxPaginas} páginas`);
  return porCodigo.size === 1 ? [...porCodigo.values()][0] : null;
}
