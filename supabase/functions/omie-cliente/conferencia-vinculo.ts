// Conferência do código Omie antes de o vínculo do employee valer (residual do b339bb5b).
//
// O employee admite cliente novo, mas o código não pode vir do browser nem do body: se for o código que
// a Omie usa para OUTRO cliente V, a dona de V cai para Hunter quando o TTL do vínculo vence. O servidor
// pergunta à Omie, com a credencial DA CONTA, de quem é o código, e só então chama a
// `admitir_vinculo_conferido` (migration 20261116180000), que compara o documento com o do cadastro.
//
// Regra: só `conferido` deixa seguir. Falha de rede, fault desconhecido, resposta sem documento ou com
// outro código → nada é gravado e o motivo volta para a tela. Ausente ≠ ok.
//
// Puro (sem rede, sem Supabase): testado em conferencia-vinculo_test.ts.

import { mensagemDeErro } from "../_shared/erro-mensagem.ts";

/** O que a Omie devolve no ConsultarCliente e esta conferência lê. */
export interface ClienteOmieConsultado {
  codigo_cliente_omie?: number;
  cnpj_cpf?: string;
  faultstring?: string;
  [campo: string]: unknown;
}

export type ConferenciaOmie =
  | { tipo: "conferido"; documento: string; cliente: ClienteOmieConsultado }
  | { tipo: "nao_cadastrado"; motivo: string }
  | { tipo: "invalido"; motivo: string }
  | { tipo: "falha"; motivo: string };

// Os textos de "não existe" que a Omie usa nas faults de cliente. Qualquer OUTRA fault é falha (não
// recusa): credencial, limite de consumo e instabilidade não dizem nada sobre o código.
const FAULT_NAO_CADASTRADO = /n[ãa]o cadastrad|n[ãa]o encontrad|n[ãa]o localizad|n[ãa]o exist|nenhum registro/i;

export function codigoOmieValido(codigo: unknown): codigo is number {
  return typeof codigo === "number" && Number.isSafeInteger(codigo) && codigo > 0;
}

/**
 * Pergunta à Omie de quem é o código. `consultar` é o ConsultarCliente já amarrado à credencial da conta
 * (pode lançar em falha de rede). Nunca devolve `conferido` sem documento e sem o MESMO código de volta.
 */
export async function conferirCodigoNaOmie(
  consultar: (codigo: number) => Promise<ClienteOmieConsultado>,
  codigo: unknown,
): Promise<ConferenciaOmie> {
  if (!codigoOmieValido(codigo)) {
    return { tipo: "invalido", motivo: "Código Omie inválido." };
  }
  let resposta: ClienteOmieConsultado;
  try {
    resposta = await consultar(codigo);
  } catch (e) {
    return { tipo: "falha", motivo: `A Omie não respondeu à conferência do código ${codigo}: ${mensagemDeErro(e) ?? "erro desconhecido"}` };
  }
  if (!resposta || typeof resposta !== "object") {
    return { tipo: "falha", motivo: `A Omie devolveu uma resposta vazia para o código ${codigo}.` };
  }
  if (typeof resposta.faultstring === "string" && resposta.faultstring !== "") {
    if (FAULT_NAO_CADASTRADO.test(resposta.faultstring)) {
      return { tipo: "nao_cadastrado", motivo: `O código ${codigo} não existe na Omie desta empresa.` };
    }
    return { tipo: "falha", motivo: `A Omie recusou a conferência do código ${codigo}: ${resposta.faultstring}` };
  }
  if (resposta.codigo_cliente_omie !== codigo) {
    return { tipo: "invalido", motivo: `A Omie devolveu outro cliente para o código ${codigo}.` };
  }
  const documento = typeof resposta.cnpj_cpf === "string" ? resposta.cnpj_cpf.trim() : "";
  if (documento === "") {
    return { tipo: "invalido", motivo: `O código ${codigo} não tem CPF/CNPJ na Omie: o vínculo não pode ser conferido.` };
  }
  return { tipo: "conferido", documento, cliente: resposta };
}

/** Status HTTP da conferência que NÃO passou: falha é transitória (503), o resto é recusa (422). */
export function statusDaConferencia(c: Exclude<ConferenciaOmie, { tipo: "conferido" }>): number {
  return c.tipo === "falha" ? 503 : 422;
}

export type ResultadoListagem =
  | { tipo: "unico"; codigo: number }
  | { tipo: "nenhum" }
  | { tipo: "ambiguo" }
  | { tipo: "falha"; motivo: string };

export type PaginaListagem =
  | { tipo: "linhas"; codigos: number[] }
  | { tipo: "fim" }
  | { tipo: "falha"; motivo: string };

/**
 * Uma página do ListarClientes (filtro cnpj_cpf). Fim = página VAZIA ou fault "nenhum registro" — não
 * página curta nem total_de_paginas (Codex: a 1ª página não prova código único). Resposta sem o campo
 * de lista e sem fault é contrato quebrado → falha, nunca "nenhum".
 */
export function classificarPaginaListagem(resposta: {
  faultstring?: string;
  clientes_cadastro?: Array<{ codigo_cliente_omie?: number }>;
  clientes_cadastro_resumido?: Array<{ codigo_cliente_omie?: number; codigo_cliente?: number }>;
} | null | undefined): PaginaListagem {
  if (!resposta || typeof resposta !== "object") {
    return { tipo: "falha", motivo: "A Omie devolveu uma resposta vazia na busca por documento." };
  }
  if (typeof resposta.faultstring === "string" && resposta.faultstring !== "") {
    return FAULT_NAO_CADASTRADO.test(resposta.faultstring)
      ? { tipo: "fim" }
      : { tipo: "falha", motivo: `A Omie recusou a busca por documento: ${resposta.faultstring}` };
  }
  const linhas = resposta.clientes_cadastro ?? resposta.clientes_cadastro_resumido;
  if (!Array.isArray(linhas)) {
    return { tipo: "falha", motivo: "A Omie devolveu a busca por documento sem a lista de clientes." };
  }
  if (linhas.length === 0) return { tipo: "fim" };
  const codigos: number[] = [];
  for (const l of linhas) {
    const c = (l as { codigo_cliente_omie?: number }).codigo_cliente_omie
      ?? (l as { codigo_cliente?: number }).codigo_cliente;
    if (!codigoOmieValido(c)) return { tipo: "falha", motivo: "A Omie devolveu um cliente sem código válido." };
    codigos.push(c);
  }
  return { tipo: "linhas", codigos };
}

/** Teto de páginas da busca por documento: estourar sem página vazia é falha, não "único". */
export const MAX_PAGINAS_BUSCA_DOCUMENTO = 5;

/**
 * Código ÚNICO do documento numa conta, paginando até a página VAZIA (com teto). Dois códigos
 * distintos para o mesmo documento é ambíguo (o sync também trata assim) → não admite.
 */
export async function codigoUnicoDoDocumento(
  listarPagina: (pagina: number) => Promise<Parameters<typeof classificarPaginaListagem>[0]>,
): Promise<ResultadoListagem> {
  const codigos = new Set<number>();
  for (let pagina = 1; pagina <= MAX_PAGINAS_BUSCA_DOCUMENTO; pagina++) {
    let p: PaginaListagem;
    try {
      p = classificarPaginaListagem(await listarPagina(pagina));
    } catch (e) {
      return { tipo: "falha", motivo: `A Omie não respondeu à busca por documento: ${mensagemDeErro(e) ?? "erro desconhecido"}` };
    }
    if (p.tipo === "falha") return p;
    if (p.tipo === "fim") {
      if (codigos.size === 0) return { tipo: "nenhum" };
      if (codigos.size > 1) return { tipo: "ambiguo" };
      return { tipo: "unico", codigo: [...codigos][0] };
    }
    for (const c of p.codigos) codigos.add(c);
    if (codigos.size > 1) return { tipo: "ambiguo" };
  }
  return { tipo: "falha", motivo: "A busca por documento na Omie não terminou dentro do teto de páginas." };
}

/** Motivo legível e status HTTP para o erro da `admitir_vinculo_conferido` (SQLSTATE da migration). */
export function traduzirErroAdmissao(erro: { code?: string; message?: string }): { status: number; motivo: string } {
  switch (erro.code) {
    case "VC001":
    case "VC002":
    case "VC003":
      return { status: 422, motivo: erro.message ?? "Vínculo recusado na conferência." };
    case "23505":
      return { status: 409, motivo: "Este código Omie já está vinculado a outro cliente nesta empresa: vínculo recusado." };
    case "42501":
      return { status: 409, motivo: "O cliente já está vinculado a outro código Omie nesta empresa: só o master troca." };
    default:
      return { status: 500, motivo: `Falha ao registrar o vínculo do cliente: ${erro.message ?? "erro desconhecido"}` };
  }
}
