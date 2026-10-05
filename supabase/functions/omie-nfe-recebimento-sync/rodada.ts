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
  | "estado_desconhecido"
  | "sem_chave"
  | "duplicada_por_chave"
  | "falha_omie"
  | "falha_banco"
  | "falha_interna";

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

interface Listagem {
  registros: RegistroListagem[];
  paginasLidas: number;
  paginacao: Paginacao;
}

const semMensagem = (e: unknown) => mensagemDeErro(e) ?? "falha sem mensagem";

/**
 * Qual candidata recebe a consulta: RODÍZIO pela vez da rodada (a hora, no cron). Sem memória entre
 * rodadas, escolher sempre "a primeira" — ou "a primeira completa" — deixa uma candidata cuja
 * consulta termina em pulo (recebida só no detalhe, duplicata só pela chave…) com a consulta de TODA
 * rodada, e as de trás nunca são vistas: foi o que travou a Oben desde 14/08, e a revisão do Codex
 * de 2026-10-05 reproduziu a mesma trava com a prioridade às completas. Com passo 1, cada candidata
 * recebe a consulta ao menos uma vez a cada N rodadas.
 */
export function escolherNaVez(fila: readonly number[], vez: number, quantas: number): number[] {
  if (fila.length === 0) return [];
  const inicio = ((Math.trunc(vez) % fila.length) + fila.length) % fila.length;
  return Array.from({ length: Math.min(quantas, fila.length) }, (_, k) => fila[(inicio + k) % fila.length]);
}

async function lerListagem(deps: DepsRodada, conta: string, dtDe: string, erros: string[]): Promise<Listagem> {
  const registros: RegistroListagem[] = [];
  let totalPaginas = 1; // piso monotônico do total declarado (guards de _shared/omie-paginacao.ts)
  let paginasLidas = 0;
  const interrompida = (pagina: number, motivo: string): Listagem => {
    // Registra em errors[]: o acumulado parcial segue (é retomável), mas com success:false.
    erros.push(`${conta} ListarRecebimentos página ${pagina}: ${motivo}`);
    return { registros, paginasLidas, paginacao: "interrompida_por_erro" };
  };
  for (let pagina = 1; pagina <= MAX_PAGINAS_POR_RODADA; pagina++) {
    try {
      const lida = interpretarPaginaListagem(await deps.listar(paramsListagem(pagina, dtDe)));
      if (lida.tipo === "falha") return interrompida(pagina, lida.mensagem);
      if (lida.tipo === "fim") break;
      totalPaginas = proximoTotalPaginas(totalPaginas, lida.totalPaginas, MAX_PAGINAS_DECLARADAS);
      const veredicto = avaliarPagina(lida.registros.length, pagina, totalPaginas);
      if (veredicto === "anomalia") {
        return interrompida(pagina, `página ${pagina}/${totalPaginas} veio vazia antes do fim declarado — acumulado parcial`);
      }
      if (veredicto === "fim") break;
      registros.push(...lida.registros);
      paginasLidas = pagina;
      if (pagina >= totalPaginas) break;
    } catch (e) {
      return interrompida(pagina, semMensagem(e));
    }
  }
  const truncada = paginasLidas === MAX_PAGINAS_POR_RODADA && totalPaginas > MAX_PAGINAS_POR_RODADA;
  return { registros, paginasLidas, paginacao: truncada ? "truncada_no_teto" : "completa" };
}

async function gravar(
  deps: DepsRodada,
  conta: string,
  warehouseId: string,
  nIdReceb: number,
  detalhe: DetalheRecebimento,
  erros: string[],
): Promise<Desfecho> {
  const cabec = detalhe.cabec ?? {};
  // O MESMO critério da listagem: a incompleta chega aqui sem triagem de estado, e a NF-e pode ter
  // sido cancelada ou recebida entre a listagem e a consulta — importá-la seria pendência fantasma.
  // Sem `infoCadastro` não há evidência de que a nota está aberta: não grava (precisão > recall).
  if (!detalhe.infoCadastro) {
    erros.push(`${conta} ConsultarRecebimento ${nIdReceb}: o detalhe veio sem infoCadastro — estado no Omie desconhecido, NF-e não importada`);
    return "estado_desconhecido";
  }
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
  try {
    return await gravar(deps, conta, warehouseId, nIdReceb, corpo as DetalheRecebimento, erros);
  } catch (e) {
    erros.push(`${conta} NF-e ${nIdReceb}: falha inesperada ao gravar — ${semMensagem(e)}`);
    return "falha_interna";
  }
}

/**
 * Nunca lança: o que a rodada já viu (contagens, pulos, a consulta) volta mesmo quando algo quebra
 * no meio — a revisão do Codex de 2026-10-05 achou a exceção levando embora o resumo da conta.
 * `vez` escolhe a candidata do rodízio (ver `escolherNaVez`); o cron passa a hora corrente.
 */
export async function rodadaDaConta(
  deps: DepsRodada,
  conta: string,
  warehouseId: string,
  dtDe: string,
  vez: number,
): Promise<ResultadoRodada> {
  const erros: string[] = [];
  const contagem = contagemVazia();
  let listagem: Listagem = { registros: [], paginasLidas: 0, paginacao: "completa" };
  let importadas = 0;
  let puladas = 0;
  let consulta: ResumoConta["consulta"] = null;
  try {
    listagem = await lerListagem(deps, conta, dtDe, erros);
    contagem.listados = listagem.registros.length;
    if (listagem.registros.length > 0) {
      // Só os ids e chaves LISTADOS: a leitura fica limitada à página (e não esbarra no teto de
      // 1.000 linhas do PostgREST, que a leitura de todos os ids da conta acabaria atingindo).
      const ids: number[] = [];
      const chaves: string[] = [];
      for (const rec of listagem.registros) {
        const { id, chave } = identidadeDoRegistro(rec);
        if (id !== null) ids.push(id);
        if (chave !== null) chaves.push(chave);
      }
      let ja: JaImportados | null = null;
      try {
        ja = await deps.jaImportados(ids, chaves);
      } catch (e) {
        // Sem saber o que já está no banco, nenhuma consulta é gasta (o UNIQUE da chave seria a única defesa).
        erros.push(`${conta}: não consegui ler as NF-e já importadas — ${semMensagem(e)}`);
      }
      if (ja !== null) {
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
        // As completas à frente na ordem; o rodízio é que garante a vez de todas.
        const fila = [...completas, ...incompletas];
        const escolhidas = escolherNaVez(fila, vez, MAX_CONSULTAS_POR_RODADA);
        contagem.aguardando = fila.length - escolhidas.length;
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
      }
    }
  } catch (e) {
    erros.push(`${conta}: falha inesperada na rodada — ${semMensagem(e)}`);
  }
  const resumo: ResumoConta = {
    ...contagem,
    janela_de: dtDe,
    paginas_lidas: listagem.paginasLidas,
    paginacao: listagem.paginacao,
    consulta,
  };
  return { resumo, erros, importadas, puladas };
}
