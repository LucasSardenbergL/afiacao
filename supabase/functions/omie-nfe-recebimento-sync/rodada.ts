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
import { estadoNoOmie } from "./estado.ts";
import { type DesfechoImportacao, erroDeLote, registravel, validarLote } from "../_shared/nfe-importacao.ts";
import { type ItemRecebimentoRow, mapearItensRecebimento, type OmieRecebimentoItem } from "./itens.ts";
import {
  type ContagemArmazem,
  contagemVazia,
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
const MAX_CONSULTAS_POR_RODADA = 1;

export interface DepsRodada {
  /** `ListarRecebimentos` com estes parâmetros. Devolve o corpo — inclusive o de falha; lança só em falha de transporte. */
  listar(params: Record<string, unknown>): Promise<unknown>;
  /** `ConsultarRecebimento` do id, com o mesmo contrato de `listar`. */
  consultar(nIdReceb: number): Promise<unknown>;
  /**
   * Dos ids (desta conta) e chaves informados, os que NÃO precisam de consulta: já têm itens, ou não
   * são reparáveis, ou estão estacionados em `nfe_importacao_falhas`. Um cabeçalho `pendente` sem
   * itens e sem sinais de uso NÃO entra — a consulta desta rodada é o que o completa (RPC → reparada).
   * Lança se não conseguir ler.
   */
  jaImportados(ids: number[], chaves: string[]): Promise<JaImportados>;
  /** A RPC transacional `importar_nfe_recebimento`: cabeçalho + itens numa chamada. Nunca lança. */
  importar(cabecalho: CabecalhoRecebimentoRow, itens: ItemRecebimentoRow[]): Promise<DesfechoImportacao>;
  /** Registro durável (falha de DADO ou impedimento), fora da transação abortada. Tentativas acumuladas, ou null. */
  registrarFalha(chave: string, code: string, mensagem: string, omieIdReceb: number): Promise<number | null>;
}

/** O que aconteceu com a NF-e que recebeu a consulta da rodada. */
type Desfecho =
  | "importada"
  /** Cabeçalho que estava `pendente` sem itens (importação antiga que morreu no meio) e foi completado. */
  | "reparada"
  /** Cabeçalho sem itens que a RPC não pode completar (não-pendente ou em uso). */
  | "bloqueada"
  /** Itens gravados ≠ itens do Omie (cardinalidade ou conteúdo): ninguém aqui sabe qual lote vale. */
  | "divergente"
  /** O banco rejeitou o dado (NFE0x, tipo que não cabe): registrado em nfe_importacao_falhas. */
  | "falha_dado"
  | "recebido_no_omie"
  | "cancelado"
  | "estado_desconhecido"
  | "sem_chave"
  | "duplicada_por_chave"
  | "falha_omie"
  | "falha_banco"
  | "falha_interna";

type Paginacao = "completa" | "truncada_no_teto" | "interrompida_por_erro";

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

/** FNV-1a de 32 bits com o finalizador do murmur3: espalha bem até entradas sequenciais. */
function espalhar(texto: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < texto.length; i++) {
    h ^= texto.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Quais candidatas recebem a consulta: SORTEIO determinístico por hash de (vez, id). Sem memória
 * entre rodadas, escolher sempre "a primeira" — ou "a primeira completa" — deixa uma candidata cuja
 * consulta termina em pulo (recebida só no detalhe, duplicata só pela chave…) com a consulta de TODA
 * rodada: foi o que travou a Oben desde 14/08. Um rodízio pelo número da vez também falha — o cron
 * roda das 10 às 22h, e com 24 candidatas a hora módulo 24 nunca passava pelos índices 0–9 e 23
 * (3ª revisão do Codex, 2026-10-05). O hash não tem essa estrutura: em toda rodada, cada candidata
 * tem chance 1/N, mesmo com a fila mudando entre uma rodada e outra.
 */
export function escolherNaVez(candidatas: readonly number[], vez: number, quantas: number): number[] {
  return candidatas
    .map((id) => ({ id, peso: espalhar(`${Math.trunc(vez)}:${id}`) }))
    .sort((a, b) => a.peso - b.peso || a.id - b.id)
    .slice(0, Math.max(0, quantas))
    .map((c) => c.id);
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
  // O MESMO critério da listagem (estado.ts): a incompleta chega aqui sem triagem de estado, e a NF-e
  // pode ter sido cancelada ou recebida entre a listagem e a consulta — importá-la seria pendência
  // fantasma. Sem os "N" explícitos não há evidência de nota aberta: não grava (precisão > recall).
  const estado = estadoNoOmie(detalhe.infoCadastro);
  if (estado === "cancelado" || estado === "recebido_no_omie") return estado;
  if (estado === "desconhecido") {
    erros.push(`${conta} ConsultarRecebimento ${nIdReceb}: o detalhe não diz se a NF-e está aberta (cRecebido/cCancelada) — não importada`);
    return "estado_desconhecido";
  }
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
  // UMA transação (RPC): cabeçalho + itens entram juntos ou nada entra. Antes, o lote que falhava
  // deixava o cabeçalho SEM itens e a rodada seguinte o pulava como "já importada" (foi assim que o
  // NCM pontuado zerou os itens de prod em silêncio, 2026-09-26).
  // Estrutura do lote ANTES do banco (o mapper fabrica "Item"/quantidade 0 de entrada vazia, e o DDL
  // aceita): lote inválido é erro de DADO aqui mesmo, sem gastar a RPC — e vai ao ledger.
  const itens = mapearItensRecebimento(detalhe.itensRecebimento ?? []);
  const motivoLote = validarLote(itens);
  const d = motivoLote !== null
    ? erroDeLote(motivoLote)
    : await deps.importar(mapearCabecalho(cabec, warehouseId, chave, nIdReceb), itens);
  // Erro de DADO e IMPEDIMENTO (bloqueada/divergente) vão ao ledger durável, FORA da transação: com
  // rollback total a NF-e inválida voltaria a parecer inédita, e um conflito permanente (cabeçalho de
  // OUTRO armazém com a mesma chave → divergente toda rodada) disputaria a única consulta da rodada
  // para sempre. tentativas ≥ 3 estaciona a chave na triagem sem esconder a NF-e.
  const registro = registravel(d);
  const tentativas = registro ? await deps.registrarFalha(chave, registro.code, registro.mensagem, nIdReceb) : null;
  const ledger = `registrada em nfe_importacao_falhas (tentativas: ${tentativas ?? "NÃO registrou"})`;
  switch (d.tipo) {
    case "importada":
      return "importada";
    case "reparada":
      return "reparada";
    case "ja_importada":
      // Outro writer (webhook, botão) gravou entre a triagem e aqui — o mesmo conjunto de itens.
      return "duplicada_por_chave";
    case "bloqueada":
      erros.push(`NF-e ${numero}: cabeçalho ${d.id} sem itens e não reparável (${d.motivo}) — nada gravado — ${ledger}`);
      return "bloqueada";
    case "divergente":
      erros.push(`NF-e ${numero}: cabeçalho ${d.id} com itens divergentes do Omie (${d.motivo}: ${d.itens} gravados, ${d.esperados} no Omie) — nada gravado — ${ledger}`);
      return "divergente";
    case "erro": {
      if (d.classe === "dado") {
        erros.push(`NF-e ${numero}: rejeitada pelo banco (${d.code}) — ${d.mensagem} — ${ledger}`);
        return "falha_dado";
      }
      if (d.classe === "rpc_ausente") {
        erros.push(`NF-e ${numero}: RPC importar_nfe_recebimento ausente — migration db/2026-10-18-importar-nfe-recebimento-rpc.sql não aplicada; nada gravado`);
        return "falha_banco";
      }
      erros.push(`NF-e ${numero}: ${d.mensagem}`);
      return "falha_banco";
    }
  }
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
 * `vez` alimenta o sorteio da consulta (ver `escolherNaVez`); o cron passa o minuto corrente.
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
        const candidatas: number[] = [];
        for (const rec of listagem.registros) {
          const t = triarRegistro(rec, ja);
          if (t.tipo === "pular") {
            registrarPulo(contagem, t.motivo);
            if (t.motivo === "ja_importado" || t.motivo === "recebido_no_omie") puladas++;
            continue;
          }
          if (t.incompleta === "listagem_magra") contagem.listagem_magra++;
          if (t.incompleta === "chave_na_listagem") contagem.sem_chave_na_listagem++;
          candidatas.push(t.nIdReceb);
        }
        // Completa ou incompleta, todas entram no sorteio: só ele garante a vez de cada uma.
        const escolhidas = escolherNaVez(candidatas, vez, MAX_CONSULTAS_POR_RODADA);
        contagem.aguardando = candidatas.length - escolhidas.length;
        for (const nIdReceb of escolhidas) {
          contagem.consultados++;
          const desfecho = await consultarEGravar(deps, conta, warehouseId, nIdReceb, erros);
          consulta = { nIdReceb, desfecho };
          if (desfecho === "importada" || desfecho === "reparada") {
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
