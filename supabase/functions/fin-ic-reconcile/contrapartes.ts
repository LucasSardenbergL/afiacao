// Contraparte intercompany por CÓDIGO Omie: quais cadastros de cada Omie são as OUTRAS empresas do
// grupo (testes em contrapartes_test.ts, `fetch` injetado).
//
// Fonte = o próprio Omie da empresa: `ListarClientes` com `clientesFiltro.cnpj_cpf` = CNPJ da outra
// empresa (cliente e fornecedor são o MESMO cadastro, então o código serve ao CR e ao CP). O filtro
// do Omie pode devolver registro de OUTRO documento (filtro parcial; ver omie-vendas-sync
// lookup-documento.ts) → só entra o registro cujo documento normalizado é EXATAMENTE o pedido.
//
// Fail-closed: qualquer resposta que não seja página com `clientes_cadastro` ou o EOF do contrato
// LANÇA — a edge aborta antes de tocar `fin_ic_matches` (mapa incompleto deixaria par real de fora).
import { chamarOmie, fimDePaginacao, type RespostaOmie } from "../_shared/omie-cliente.ts";
import { normalizarDocumento } from "../_shared/cnpj-alfanumerico.ts";
import {
  avaliarPagina,
  MAX_PAGINAS_LISTAGEM,
  proximoTotalPaginas,
  varreduraTruncada,
} from "../_shared/omie-paginacao.ts";

const URL_CLIENTES = "https://app.omie.com.br/api/v1/geral/clientes/";
const REGISTROS_POR_PAGINA = 50;

export interface Credenciais {
  appKey: string;
  appSecret: string;
}

export interface Consulta {
  /** Empresa dona do Omie consultado (o código devolvido é DELA). */
  empresa: string;
  /** Empresa do grupo procurada e o seu CNPJ normalizado. */
  alvo: string;
  cnpjAlvo: string;
}

export interface ResultadoConsulta extends Consulta {
  codigos: number[];
  /** Registros que o filtro devolveu com OUTRO documento (descartados). */
  descartados: number;
}

export type Chamar = (metodo: string, param: unknown) => Promise<RespostaOmie>;

/** Transporte real: leitura com retentativa só em transitório (núcleo `_shared/omie-cliente.ts`). */
export function chamadorOmie(empresa: string, cred: Credenciais, fetchImpl?: typeof fetch): Chamar {
  return (metodo, param) =>
    chamarOmie(
      { url: URL_CLIENTES, metodo, param, credenciais: cred },
      { conta: empresa, maxTentativas: 3, fetchImpl },
    );
}

function falha(c: Consulta, pagina: number, r: RespostaOmie, motivo?: string): Error {
  // Sem corpo: o texto do Omie pode ecoar dado de cadastro. Status + faultcode bastam para diagnóstico.
  return new Error(
    `OMIE_CONTRAPARTE_FALHOU (${c.empresa}→${c.alvo}, página ${pagina}): HTTP ${r.status}` +
      (r.faultcode ? ` · ${r.faultcode}` : "") + (r.faultstring ? ` · ${r.faultstring.slice(0, 120)}` : "") +
      (motivo ? ` · ${motivo}` : ""),
  );
}

/**
 * Pagina até o EOF (ou o total declarado), com teto de páginas, e PROVA a completude: o Omie
 * declara `total_de_registros`, e os cadastros DISTINTOS lidos (com ou sem o documento pedido) têm
 * de alcançá-lo. Total de páginas ausente/curto, página repetida ou eco de outra página → lança.
 */
export async function consultarCodigos(chamar: Chamar, c: Consulta): Promise<ResultadoConsulta> {
  const codigos = new Set<number>();
  const vistos = new Set<string>();
  let descartados = 0;
  let total = 1;
  let declarados: number | null = null;
  for (let pagina = 1; pagina <= total; pagina++) {
    const r = await chamar("ListarClientes", {
      pagina,
      registros_por_pagina: REGISTROS_POR_PAGINA,
      apenas_importado_api: "N",
      clientesFiltro: { cnpj_cpf: c.cnpjAlvo },
    });
    if (fimDePaginacao(r)) {
      // EOF na 1ª página = o Omie não tem cadastro com esse CNPJ (legítimo). Depois dela, só se o
      // total declarado já acabou — senão é retrato PARCIAL.
      if (pagina === 1) break;
      throw falha(c, pagina, r);
    }
    const lista = r.corpo?.clientes_cadastro;
    if (!r.ok || r.faultstring !== null || !Array.isArray(lista)) throw falha(c, pagina, r);
    // Eco de OUTRA página (o Omie devolveu a errada) não é a página pedida.
    const eco = r.corpo?.pagina;
    if (eco !== undefined && Number(eco) !== pagina) throw falha(c, pagina, r, "página ecoada diferente");
    const tot = Number(r.corpo?.total_de_registros);
    if (!Number.isSafeInteger(tot) || tot < 0) throw falha(c, pagina, r, "sem total_de_registros");
    declarados = Math.max(declarados ?? 0, tot);
    // Total ausente/lixo degrada para o piso já visto (nunca encolhe o teto).
    total = proximoTotalPaginas(total, Number(r.corpo?.total_de_paginas), MAX_PAGINAS_LISTAGEM);
    const veredito = avaliarPagina(lista.length, pagina, total);
    if (veredito === "anomalia") throw falha(c, pagina, r);
    if (veredito === "fim") break;
    for (const reg of lista as Array<Record<string, unknown>>) {
      const codigo = Number(reg?.codigo_cliente_omie);
      vistos.add(String(reg?.codigo_cliente_omie));
      const doc = normalizarDocumento(reg?.cnpj_cpf);
      if (doc === c.cnpjAlvo && Number.isSafeInteger(codigo) && codigo > 0) codigos.add(codigo);
      else descartados++;
    }
  }
  if (declarados !== null && varreduraTruncada(vistos.size, declarados)) {
    throw new Error(
      `OMIE_CONTRAPARTE_FALHOU (${c.empresa}→${c.alvo}): ${vistos.size} cadastro(s) distinto(s) lido(s) ` +
        `de ${declarados} declarado(s) — retrato parcial`,
    );
  }
  return { ...c, codigos: [...codigos].sort((a, b) => a - b), descartados };
}

/** Linha do mapa durável `fin_ic_contrapartes`: no Omie de `empresa`, o cadastro `omie_codigo_cliente` é `empresa_alvo`. */
export interface LinhaContraparte {
  empresa: string;
  omie_codigo_cliente: number;
  empresa_alvo: string;
}

export function linhasDeContraparte(consultas: ReadonlyArray<ResultadoConsulta>): LinhaContraparte[] {
  const vistas = new Set<string>();
  const linhas: LinhaContraparte[] = [];
  for (const c of consultas) {
    for (const codigo of c.codigos) {
      const chave = `${c.empresa}:${codigo}:${c.alvo}`;
      if (vistas.has(chave)) continue;
      vistas.add(chave);
      linhas.push({ empresa: c.empresa, omie_codigo_cliente: codigo, empresa_alvo: c.alvo });
    }
  }
  return linhas;
}

/** O mínimo do PostgREST para gravar o mapa: INSERT ... ON CONFLICT DO NOTHING. */
export type GravarContrapartes = (linhas: LinhaContraparte[]) => PromiseLike<{ error: { message: string } | null }>;

export function escritorContrapartes(tabela: () => {
  upsert(linhas: LinhaContraparte[], opcoes: { onConflict: string; ignoreDuplicates: boolean }): PromiseLike<{ error: { message: string } | null }>;
}): GravarContrapartes {
  return (linhas) =>
    tabela().upsert(linhas, { onConflict: "empresa,omie_codigo_cliente,empresa_alvo", ignoreDuplicates: true });
}

/**
 * Grava o mapa de contraparte SÓ ACRESCENTANDO (o banco nem concede UPDATE/DELETE à edge). É a fonte
 * durável do "CR aparecido" da RPC `fin_consolidado_intercompany`: ela acha ali o CR do destino que
 * contradiz uma venda sem cobrança, sem depender das linhas informativas — que esta edge apaga e
 * reinsere em duas requisições, e que nunca nascem para CR sem emissão. Código a mais só deixa a RPC
 * mais conservadora (pende), nunca elimina; por isso acrescentar é seguro e apagar não é.
 */
export async function gravarContrapartes(
  gravar: GravarContrapartes,
  consultas: ReadonlyArray<ResultadoConsulta>,
): Promise<{ ok: true; linhas: number } | { ok: false; erro: string }> {
  const linhas = linhasDeContraparte(consultas);
  if (linhas.length === 0) return { ok: true, linhas: 0 };
  const { error } = await gravar(linhas);
  return error ? { ok: false, erro: error.message } : { ok: true, linhas: linhas.length };
}

/** Folga do marco: o relógio da edge e o do banco não são o mesmo (o `created_at` do CR é do banco). */
export const FOLGA_MARCO_MS = 5 * 60_000;

/**
 * O marco da rodada: "o mapa foi gravado a partir do que o Omie respondeu em `mapa_lido_em`" (o início da
 * leitura, menos a folga). A RPC o usa como trava de bootstrap: sem marco nenhum, a venda sem cobrança não
 * elimina (o mapa durável ainda não foi alimentado pela edge).
 */
export function marcoDaRodada(inicioMs: number): { mapa_lido_em: string } {
  return { mapa_lido_em: new Date(inicioMs - FOLGA_MARCO_MS).toISOString() };
}
