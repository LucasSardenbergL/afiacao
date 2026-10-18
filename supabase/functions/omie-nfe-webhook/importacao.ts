// Materialização do recebimento (cabeçalho + itens) com RETRY IDEMPOTENTE.
//
// Por que existe: as duas inserções (`nfe_recebimentos` e depois `nfe_recebimento_itens`) não
// são transacionais via PostgREST (transação é por REQUISIÇÃO). Se os itens falharem, o cabeçalho
// fica — e o Omie reenvia o webhook. Até aqui o guard de duplicata só olhava o `id` do cabeçalho e
// respondia "já importada": a retentativa não consertava, escondia (recebimento sem itens,
// invisível para quem confere).
//
// Desenho (2ª opinião Codex 2026-10-18, que reprovou a 1ª versão):
//  · IDEMPOTÊNCIA DE RETRY, não compensação: deletar o cabeçalho na falha também pode falhar, pode
//    apagar trabalho de um writer concorrente, e se o Omie não reenviar o cabeçalho ao menos
//    denuncia a NF-e. Aqui o guard lê `id, status, count(itens)` e, se o cabeçalho é REPARÁVEL
//    (abaixo) e o payload traz itens, COMPLETA o recebimento existente.
//  · Contagem ilegível é ERRO, nunca zero (ausente ≠ zero, money-path): responder "já importada"
//    sobre uma contagem que não se leu seria o mesmo silêncio de antes.
//  · A corrida webhook×webhook (dois envios da mesma chave em paralelo: ambos leem "sem itens" e
//    ambos inserem → 2N) NÃO se fecha com o UNIQUE do cabeçalho — o UNIQUE do pai não protege os
//    filhos. Fecha-se dando aos itens um `id` DETERMINÍSTICO (cabeçalho + sequência + posição):
//    o 2º lote colide na PK (23505) e o lote inteiro é rejeitado — zero ou N, nunca 2N. Quem
//    perde relê a contagem e responde "já importada". É o que dá para fechar SEM migration; o que
//    fica aberto (webhook×sync, que gera ids aleatórios; e `reconcile` promovendo o cabeçalho
//    entre a leitura e o insert) só fecha com RPC + lock por recebimento — follow-up.
//  · Reparável = `pendente` E count 0 comprovado E sem NENHUM sinal de uso (conferente, conferido,
//    efetivado, lock de efetivação — todos NULL comprovados; campo ausente não é NULL). Não se
//    injeta itens em recebimento que alguém já tocou.
//
// Sem dependência do supabase-js de propósito: a porta estreita abaixo é o que `porta.ts` adapta,
// e é o que o teste (`importacao_test.ts`, `deno test --no-remote`) injeta com um banco falso.

export interface CabecalhoExistente {
  id: string;
  status: string;
  /** Contagem COMPROVADA (número inteiro ≥ 0). Ilegível vira `erro` na leitura, não zero. */
  itens: number;
  /** true se QUALQUER sinal de uso está preenchido — ou se algum veio ausente (NULL não comprovado). */
  emUso: boolean;
}

export type LeituraPorChave =
  | ({ tipo: "existe" } & CabecalhoExistente)
  | { tipo: "nenhuma" }
  | { tipo: "erro"; mensagem: string };

export type ErroEscrita = { erro: string; code: string | null };
export type RespostaInsertCabecalho = { id: string } | ErroEscrita;

export interface PortaRecebimento {
  /** Cabeçalho pela chave de acesso, COM contagem de itens e sinais de uso. Ilegível → `erro`. */
  buscarPorChave(chave: string): Promise<LeituraPorChave>;
  /** Insere o cabeçalho e devolve o id, ou o erro com a SQLSTATE (23505 = corrida no UNIQUE). */
  inserirCabecalho(row: Record<string, unknown>): Promise<RespostaInsertCabecalho>;
  /** Insere o lote de itens (já com `id` e `nfe_recebimento_id`). `null` = gravou; 23505 = lote já existe. */
  inserirItens(linhas: Record<string, unknown>[]): Promise<ErroEscrita | null>;
}

export interface EntradaImportacao {
  chaveAcesso: string;
  cabecalho: Record<string, unknown>;
  /** Itens SEM `id`/`nfe_recebimento_id` — ambos são carimbados aqui, com o cabeçalho que valer. */
  itens: Record<string, unknown>[];
}

export type ResultadoImportacao =
  | { tipo: "importada"; id: string; itens: number }
  /** Cabeçalho já existia `pendente` sem itens e sem uso; os itens entraram agora. */
  | { tipo: "reparada"; id: string; itens: number }
  | { tipo: "ja_importada"; id: string; itens: number }
  | { tipo: "erro_leitura"; mensagem: string }
  | { tipo: "erro_cabecalho"; mensagem: string }
  /** O cabeçalho ficou gravado (`id`); a retentativa com o mesmo payload completa os itens. */
  | { tipo: "erro_itens"; id: string; mensagem: string };

const SQLSTATE_UNIQUE = "23505";
const STATUS_REPARAVEL = "pendente";

/**
 * `id` determinístico do item: UUID (versão 8, "custom") derivado de SHA-256 de
 * `cabeçalho | sequência | posição`. A posição entra porque `sequencia` vem do payload e pode
 * repetir; o mesmo payload reenviado produz os MESMOS ids — é isso que faz a PK barrar o 2º lote.
 */
export async function idDeterministicoDoItem(
  nfeRecebimentoId: string,
  sequencia: unknown,
  posicao: number,
): Promise<string> {
  const base = `${nfeRecebimentoId}|${String(sequencia)}|${posicao}`;
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(base)));
  const b = hash.slice(0, 16);
  b[6] = (b[6] & 0x0f) | 0x80; // versão 8 (RFC 9562: custom/experimental)
  b[8] = (b[8] & 0x3f) | 0x80; // variante RFC
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function carimbarItens(
  id: string,
  itens: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  return await Promise.all(
    itens.map(async (item, idx) => ({
      ...item,
      id: await idDeterministicoDoItem(id, item.sequencia, idx),
      nfe_recebimento_id: id,
    })),
  );
}

/** Reparável = ainda não entrou na conferência/efetivação e ninguém o tocou. */
export function reparavel(c: CabecalhoExistente, nItensPayload: number): boolean {
  return c.status === STATUS_REPARAVEL && c.itens === 0 && !c.emUso && nItensPayload > 0;
}

/**
 * Insere o lote num cabeçalho (novo ou existente). Se a PK barrar (23505), um concorrente já
 * gravou ESTE lote: relê e, com itens comprovados, é "já importada" — não é erro nem 2N.
 */
async function gravarLote(
  porta: PortaRecebimento,
  chave: string,
  id: string,
  itens: Record<string, unknown>[],
  sucesso: "importada" | "reparada",
): Promise<ResultadoImportacao> {
  const erro = await porta.inserirItens(await carimbarItens(id, itens));
  if (!erro) return { tipo: sucesso, id, itens: itens.length };
  if (erro.code === SQLSTATE_UNIQUE) {
    const releitura = await porta.buscarPorChave(chave);
    if (releitura.tipo === "existe" && releitura.id === id && releitura.itens > 0) {
      return { tipo: "ja_importada", id, itens: releitura.itens };
    }
  }
  return { tipo: "erro_itens", id, mensagem: erro.erro };
}

async function sobreExistente(
  porta: PortaRecebimento,
  chave: string,
  existente: CabecalhoExistente,
  itens: Record<string, unknown>[],
): Promise<ResultadoImportacao> {
  if (!reparavel(existente, itens.length)) {
    return { tipo: "ja_importada", id: existente.id, itens: existente.itens };
  }
  return await gravarLote(porta, chave, existente.id, itens, "reparada");
}

export async function materializarRecebimento(
  porta: PortaRecebimento,
  entrada: EntradaImportacao,
): Promise<ResultadoImportacao> {
  const { chaveAcesso: chave, itens } = entrada;
  const leitura = await porta.buscarPorChave(chave);
  if (leitura.tipo === "erro") return { tipo: "erro_leitura", mensagem: leitura.mensagem };
  if (leitura.tipo === "existe") return await sobreExistente(porta, chave, leitura, itens);

  const cab = await porta.inserirCabecalho(entrada.cabecalho);
  if ("erro" in cab) {
    // Corrida entre a leitura "nenhuma" e o insert: outro webhook da mesma chave gravou antes.
    // O UNIQUE(chave_acesso) barrou este; o cabeçalho que vale é o do concorrente — relê UMA vez
    // e segue pelo caminho do existente (completa se ele ainda estiver sem itens; se o concorrente
    // inserir os dele no meio, a PK determinística barra o nosso lote e viramos "já importada").
    if (cab.code === SQLSTATE_UNIQUE) {
      const releitura = await porta.buscarPorChave(chave);
      if (releitura.tipo === "existe") return await sobreExistente(porta, chave, releitura, itens);
      const detalhe = releitura.tipo === "erro" ? releitura.mensagem : "cabeçalho não encontrado após 23505";
      return { tipo: "erro_cabecalho", mensagem: `${cab.erro} (releitura: ${detalhe})` };
    }
    return { tipo: "erro_cabecalho", mensagem: cab.erro };
  }

  if (itens.length === 0) return { tipo: "importada", id: cab.id, itens: 0 };
  return await gravarLote(porta, chave, cab.id, itens, "importada");
}
