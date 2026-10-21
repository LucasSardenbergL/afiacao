// Contraparte intercompany por CÓDIGO Omie: quais cadastros de cada Omie são as OUTRAS empresas do
// grupo (testes em contrapartes_test.ts, `fetch` injetado).
//
// Fonte = o próprio Omie da empresa: `ListarClientes` com `clientesFiltro.cnpj_cpf` = CNPJ da outra
// empresa (cliente e fornecedor são o MESMO cadastro, então o código serve ao CR e ao CP). O filtro
// do Omie pode devolver registro de OUTRO documento (filtro parcial; ver omie-vendas-sync
// lookup-documento.ts) → só entra o registro cujo documento normalizado é EXATAMENTE o pedido.
//
// Fail-closed: qualquer resposta que não seja página com `clientes_cadastro` ou o EOF do contrato
// LANÇA — a edge aborta antes de tocar `fin_ic_matches` (mapa incompleto apagaria pares reais).
import { chamarOmie, fimDePaginacao, type RespostaOmie } from "../_shared/omie-cliente.ts";
import { normalizarDocumento } from "../_shared/cnpj-alfanumerico.ts";
import { MAX_PAGINAS_LISTAGEM, proximoTotalPaginas } from "../_shared/omie-paginacao.ts";

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

function falha(c: Consulta, pagina: number, r: RespostaOmie): Error {
  // Sem corpo: o texto do Omie pode ecoar dado de cadastro. Status + faultcode bastam para diagnóstico.
  return new Error(
    `OMIE_CONTRAPARTE_FALHOU (${c.empresa}→${c.alvo}, página ${pagina}): HTTP ${r.status}` +
      (r.faultcode ? ` · ${r.faultcode}` : "") + (r.faultstring ? ` · ${r.faultstring.slice(0, 120)}` : ""),
  );
}

/** Pagina até o EOF (ou o total declarado), com teto de páginas. */
export async function consultarCodigos(chamar: Chamar, c: Consulta): Promise<ResultadoConsulta> {
  const codigos = new Set<number>();
  let descartados = 0;
  let total = 1;
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
    total = proximoTotalPaginas(total, Number(r.corpo?.total_de_paginas ?? 1), MAX_PAGINAS_LISTAGEM);
    for (const reg of lista as Array<Record<string, unknown>>) {
      const codigo = Number(reg?.codigo_cliente_omie);
      const doc = normalizarDocumento(reg?.cnpj_cpf);
      if (doc === c.cnpjAlvo && Number.isSafeInteger(codigo) && codigo > 0) codigos.add(codigo);
      else descartados++;
    }
    if (lista.length === 0 && pagina < total) throw falha(c, pagina, r);
  }
  return { ...c, codigos: [...codigos].sort((a, b) => a - b), descartados };
}
