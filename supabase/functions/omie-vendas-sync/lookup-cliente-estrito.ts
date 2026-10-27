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

const indeterminado = (account: string, motivo: string) =>
  new Error(`OMIE_LOOKUP_INDETERMINADO (${account}): ${motivo} — não dá pra afirmar que o cliente não existe`);

const ehObjeto = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Valida UMA página; devolve os registros (vazio = fim real). Lança INDETERMINADO/DIVERGENTE. */
function registrosDaPagina(resp: unknown, pagina: number, docClean: string, account: string): ClienteEncontrado[] {
  if (resp === null) return [];
  if (!ehObjeto(resp)) throw indeterminado(account, `página ${pagina} não é um objeto`);
  // O eco da página, quando vem, tem de ser a pedida: um Omie que ignora `pagina` repetiria a 1ª até o guard.
  if (resp.pagina !== undefined && Number(resp.pagina) !== pagina) {
    throw indeterminado(account, `pedi a página ${pagina} e veio a ${String(resp.pagina)}`);
  }
  const arr = resp.clientes_cadastro;
  if (!Array.isArray(arr)) throw indeterminado(account, `página ${pagina} sem clientes_cadastro`);
  return arr.map((c, i) => {
    if (!ehObjeto(c)) throw indeterminado(account, `registro ${i} da página ${pagina} não é um objeto`);
    const codigo = c.codigo_cliente_omie;
    if (typeof codigo !== "number" || !Number.isSafeInteger(codigo) || codigo <= 0) {
      throw indeterminado(account, `registro ${i} da página ${pagina} sem codigo_cliente_omie inteiro positivo`);
    }
    if (typeof c.cnpj_cpf !== "string") {
      throw indeterminado(account, `registro ${i} da página ${pagina} sem cnpj_cpf`);
    }
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
 * `maxPaginas`; erro transitório do Omie já vem como throw do `listarPagina` (throwOnTransient).
 */
export async function buscarClienteEstrito(
  docClean: string,
  account: string,
  listarPagina: ListarPagina,
  opts: { porPagina?: number; maxPaginas?: number } = {},
): Promise<ClienteEncontrado | null> {
  const porPagina = opts.porPagina ?? LOOKUP_POR_PAGINA;
  const maxPaginas = opts.maxPaginas ?? LOOKUP_MAX_PAGINAS;
  const porCodigo = new Map<string, ClienteEncontrado>();
  let fimReal = false;
  for (let pagina = 1; pagina <= maxPaginas; pagina++) {
    const registros = registrosDaPagina(await listarPagina(pagina, porPagina), pagina, docClean, account);
    if (registros.length === 0) {
      fimReal = true;
      break;
    }
    // O mesmo código repetido entre páginas é o MESMO cliente; ambíguo é código DISTINTO.
    for (const r of registros) if (!porCodigo.has(String(r.codigo_cliente))) porCodigo.set(String(r.codigo_cliente), r);
  }
  if (!fimReal) throw indeterminado(account, `a paginação não chegou à página vazia em ${maxPaginas} páginas`);
  if (porCodigo.size > 1) {
    throw new Error(
      `OMIE_LOOKUP_AMBIGUO (${account}): o Omie tem ${porCodigo.size} clientes com este documento (códigos ${[...porCodigo.keys()].join(", ")}) — confira o cadastro no Omie antes de vincular`,
    );
  }
  return porCodigo.size === 1 ? [...porCodigo.values()][0] : null;
}
