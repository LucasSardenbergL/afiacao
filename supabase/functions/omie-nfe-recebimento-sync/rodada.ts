// Uma rodada do cron numa conta do Omie: listagem com detalhes → triagem → a ÚNICA consulta de
// detalhe → gravação. O Omie e o banco entram por INJEÇÃO para o laço REAL ser testável no Deno
// (rodada_test.ts): na revisão do Codex de 2026-10-05, com só os helpers testados, cinco sabotagens
// do laço (pulo gastando a consulta, falha do detalhe lida e ignorada, contador fora da resposta…)
// passavam com tudo verde.
//
// Lógica sem rede nem banco próprios — cabe no `--no-remote` do `test:edges`.

import { mensagemDeErro } from "../_shared/erro-mensagem.ts";
import { avaliarPagina, proximoTotalPaginas } from "../_shared/omie-paginacao.ts";
import { type CabecalhoRecebimentoRow, mapearCabecalho, type OmieCabecRecebimento } from "./cabecalho.ts";
import { normalizarChaveAcesso } from "./chave.ts";
import type { OmieRecebimentoItem } from "./itens.ts";
import {
  type ContagemArmazem,
  contagemVazia,
  estadoNoOmie,
  falhaNoCorpo,
  identidadeDoRegistro,
  interpretarPaginaListagem,
  type JaImportados,
  paramsListagem,
  type RegistroListagem,
  registrarPulo,
  triarRegistro,
} from "./listagem.ts";

/** Teto anti-runaway do total DECLARADO pelo Omie. */
const MAX_PAGINAS_DECLARADAS = 500;
/** Teto de LEITURA por rodada (50 por página): amostra que o cron horário retoma. */
export const MAX_PAGINAS_POR_RODADA = 3;
/** 1 consulta de detalhe por conta e rodada: a trava anti-redundância do Omie morde o método por conta (~60s). */
export const MAX_CONSULTAS_POR_RODADA = 1;

export interface DepsRodada {
  /** `ListarRecebimentos` com estes parâmetros. Devolve o corpo — inclusive o de falha; lança só em falha de transporte. */
  listar(params: Record<string, unknown>): Promise<unknown>;
  /** `ConsultarRecebimento` do id, com o mesmo contrato de `listar`. */
  consultar(nIdReceb: number): Promise<unknown>;
  /** Dos ids (desta conta) e chaves informados, os que já estão em `nfe_recebimentos`. Lança se não conseguir ler. */
  jaImportados(ids: number[], chaves: string[]): Promise<JaImportados>;
  inserirCabecalho(row: CabecalhoRecebimentoRow): Promise<{ id: string } | { erro: string }>;
  /** `null` = itens gravados (ou nenhum a gravar); texto = o erro. */
  inserirItens(itens: OmieRecebimentoItem[], nfeRecebimentoId: string): Promise<string | null>;
}

/** O que aconteceu com a NF-e que recebeu a consulta da rodada. */
export type Desfecho =
  | "importada"
  | "itens_falharam"
  | "recebido_no_omie"
  | "cancelado"
  | "sem_chave"
  | "duplicada_por_chave"
  | "falha_omie"
  | "falha_banco";

export type Paginacao = "completa" | "truncada_no_teto" | "interrompida_por_erro";

/** O sensor do cron, por conta: vai em `por_armazem` na resposta, que o `net._http_response` guarda. */
export interface ResumoConta extends ContagemArmazem {
  janela_de: string;
  paginas_lidas: number;
  paginacao: Paginacao;
  consulta: { nIdReceb: number; desfecho: Desfecho } | null;
}

export interface ResultadoRodada {
  resumo: ResumoConta;
  erros: string[];
  importadas: number;
  /** O `skipped` da resposta, no sentido de antes: já importada ou já recebida no Omie. */
  puladas: number;
}

interface DetalheRecebimento {
  cabec?: OmieCabecRecebimento & { cChaveNFe?: string | null; cChaveNfe?: string | null };
  itensRecebimento?: OmieRecebimentoItem[];
  infoCadastro?: { cCancelada?: string; cRecebido?: string };
}

const semMensagem = (e: unknown) => mensagemDeErro(e) ?? "falha sem mensagem";

async function lerListagem(deps: DepsRodada, conta: string, dtDe: string, erros: string[]) {
  const registros: RegistroListagem[] = [];
  let totalPaginas = 1; // piso monotônico do total declarado (guards de _shared/omie-paginacao.ts)
  let paginasLidas = 0;
  for (let pagina = 1; pagina <= MAX_PAGINAS_POR_RODADA; pagina++) {
    let lida;
    try {
      lida = interpretarPaginaListagem(await deps.listar(paramsListagem(pagina, dtDe)));
    } catch (e) {
      erros.push(`${conta} ListarRecebimentos página ${pagina}: ${semMensagem(e)}`);
      return { registros, paginasLidas, paginacao: "interrompida_por_erro" as Paginacao };
    }
    if (lida.tipo === "falha") {
      // Registra em errors[]: o acumulado parcial seguiria com success:true e ninguém saberia da página perdida.
      erros.push(`${conta} ListarRecebimentos página ${pagina}: ${lida.mensagem}`);
      return { registros, paginasLidas, paginacao: "interrompida_por_erro" as Paginacao };
    }
    if (lida.tipo === "fim") break;
    totalPaginas = proximoTotalPaginas(totalPaginas, lida.totalPaginas, MAX_PAGINAS_DECLARADAS);
    const veredicto = avaliarPagina(lida.registros.length, pagina, totalPaginas);
    if (veredicto === "anomalia") {
      erros.push(`${conta} ListarRecebimentos página ${pagina}: página ${pagina}/${totalPaginas} veio vazia antes do fim declarado — acumulado parcial`);
      return { registros, paginasLidas, paginacao: "interrompida_por_erro" as Paginacao };
    }
    if (veredicto === "fim") break;
    registros.push(...lida.registros);
    paginasLidas = pagina;
    if (pagina >= totalPaginas) break;
  }
  const truncada = paginasLidas === MAX_PAGINAS_POR_RODADA && totalPaginas > MAX_PAGINAS_POR_RODADA;
  return { registros, paginasLidas, paginacao: (truncada ? "truncada_no_teto" : "completa") as Paginacao };
}

async function consultarEGravar(
  deps: DepsRodada,
  conta: string,
  warehouseId: string,
  nIdReceb: number,
  erros: string[],
): Promise<Desfecho> {
  let corpo: unknown;
  try {
    corpo = await deps.consultar(nIdReceb);
  } catch (e) {
    // Registra: com 1 consulta por rodada, a MESMA NF-e falhando toda hora trava a fila com
    // success:true — errors[] é o único sinal visível disso.
    erros.push(`${conta} ConsultarRecebimento ${nIdReceb}: ${semMensagem(e)}`);
    return "falha_omie";
  }
  const falha = falhaNoCorpo(corpo);
  if (falha !== null) {
    erros.push(`${conta} ConsultarRecebimento ${nIdReceb}: ${falha}`);
    return "falha_omie";
  }
  const detalhe = corpo as DetalheRecebimento;
  const cabec = detalhe.cabec ?? {};
  // O MESMO critério da listagem: a incompleta chega aqui sem triagem de estado, e a NF-e pode ter
  // sido cancelada ou recebida entre a listagem e a consulta — importá-la seria pendência fantasma.
  const estado = estadoNoOmie(detalhe.infoCadastro);
  if (estado !== null) return estado;
  const chave = normalizarChaveAcesso(cabec.cChaveNFe || cabec.cChaveNfe);
  if (chave === null) return "sem_chave";
  let ja: JaImportados;
  try {
    ja = await deps.jaImportados([], [chave]);
  } catch (e) {
    erros.push(`${conta} NF-e ${nIdReceb}: não consegui conferir a chave no banco — ${semMensagem(e)}`);
    return "falha_banco";
  }
  if (ja.chaves.has(chave)) return "duplicada_por_chave";

  const numero = String(cabec.cNumeroNFe ?? "");
  const gravado = await deps.inserirCabecalho(mapearCabecalho(cabec, warehouseId, chave, nIdReceb));
  if ("erro" in gravado) {
    erros.push(`NF-e ${numero}: ${gravado.erro}`);
    return "falha_banco";
  }
  const erroItens = await deps.inserirItens(detalhe.itensRecebimento ?? [], gravado.id);
  if (erroItens !== null) {
    // A NF-e ficou SÓ com o cabeçalho e a rodada seguinte a pula (já importada): o erro tem de sair
    // em errors[] — com o console.error sozinho ela contava como importada e a run dizia
    // success:true (foi assim que o NCM pontuado zerou os itens de prod em silêncio). O cabeçalho
    // NÃO é apagado: com 1 consulta por rodada, uma falha determinística re-tentada travaria a fila.
    erros.push(`NF-e ${numero}: cabeçalho gravado SEM itens — ${erroItens}`);
    return "itens_falharam";
  }
  return "importada";
}

export async function rodadaDaConta(
  deps: DepsRodada,
  conta: string,
  warehouseId: string,
  dtDe: string,
): Promise<ResultadoRodada> {
  const erros: string[] = [];
  const contagem = contagemVazia();
  const listagem = await lerListagem(deps, conta, dtDe, erros);
  contagem.listados = listagem.registros.length;
  const resumo = (consulta: ResumoConta["consulta"]): ResumoConta => ({
    ...contagem,
    janela_de: dtDe,
    paginas_lidas: listagem.paginasLidas,
    paginacao: listagem.paginacao,
    consulta,
  });
  if (listagem.registros.length === 0) return { resumo: resumo(null), erros, importadas: 0, puladas: 0 };

  // Só os ids e chaves LISTADOS: a leitura fica limitada à página (e não esbarra no teto de 1.000
  // linhas do PostgREST, que a leitura de todos os ids da conta acabaria atingindo).
  const ids: number[] = [];
  const chaves: string[] = [];
  for (const rec of listagem.registros) {
    const { id, chave } = identidadeDoRegistro(rec);
    if (id !== null) ids.push(id);
    if (chave !== null) chaves.push(chave);
  }
  let ja: JaImportados;
  try {
    ja = await deps.jaImportados(ids, chaves);
  } catch (e) {
    // Sem saber o que já está no banco, nenhuma consulta é gasta (o UNIQUE da chave seria a única defesa).
    erros.push(`${conta}: não consegui ler as NF-e já importadas — ${semMensagem(e)}`);
    return { resumo: resumo(null), erros, importadas: 0, puladas: 0 };
  }

  let puladas = 0;
  const completas: number[] = [];
  const incompletas: number[] = [];
  for (const rec of listagem.registros) {
    const t = triarRegistro(rec, ja);
    if (t.tipo === "pular") {
      registrarPulo(contagem, t.motivo);
      if (t.motivo === "ja_importado" || t.motivo === "recebido_no_omie") puladas++;
      continue;
    }
    if (t.incompleta === "listagem_magra") contagem.listagem_magra++;
    if (t.incompleta === "chave_na_listagem") contagem.sem_chave_na_listagem++;
    (t.incompleta === null ? completas : incompletas).push(t.nIdReceb);
  }
  // As completas primeiro: a incompleta só gasta a consulta quando não há outra candidata — senão
  // uma NF-e sem chave de verdade, no topo, voltaria a travar a fila em toda rodada.
  const fila = [...completas, ...incompletas];
  const escolhidas = fila.slice(0, MAX_CONSULTAS_POR_RODADA);
  contagem.aguardando = fila.length - escolhidas.length;

  let importadas = 0;
  let consulta: ResumoConta["consulta"] = null;
  for (const nIdReceb of escolhidas) {
    contagem.consultados++;
    const desfecho = await consultarEGravar(deps, conta, warehouseId, nIdReceb, erros);
    consulta = { nIdReceb, desfecho };
    if (desfecho === "importada") {
      importadas++;
      contagem.importados++;
    }
    if (desfecho === "recebido_no_omie" || desfecho === "duplicada_por_chave") puladas++;
  }
  return { resumo: resumo(consulta), erros, importadas, puladas };
}
