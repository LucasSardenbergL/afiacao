// Orquestração IDEMPOTENTE da criação da OS de Afiação (follow-up Codex do #4042).
// Dependências injetadas (banco e Omie) para que cada ramo seja testado no runtime real
// (os-idempotente_test.ts) — a edge (`index.ts`) só liga as pontas.
//
// Ordem:
//   1. chave = hash(orderId, cliente, assinatura) — mesmo checkout + mesmo carrinho = mesma chave;
//   2. reserva o pedido (INSERT … ON CONFLICT DO NOTHING na PK order_id) e RELÊ a linha;
//   3. a reserva tem OUTRA chave (o carrinho mudou desde a tentativa que reservou): se ela já tem
//      OS, ou o Omie acha a OS pela chave antiga → `diverge` (nada é criado). Só a ausência PROVADA
//      da OS antiga, e só depois da JANELA em que um IncluirOS antigo ainda pode concluir, reabre a
//      reserva para a chave nova — fecha a corrida "A em voo × B reabre" de forma durável;
//   4. mesma chave e OS já vinculada → CONFERE no Omie que ela segue ativa (excluída/cancelada é
//      terminal — não ressuscita o pedido) e devolve ela: o caso "a resposta se perdeu";
//   5. IncluirOS; QUALQUER falha (inclusive timeout e o "já cadastrado" cujo texto não conhecemos)
//      → ConsultarOS pela chave; achou a NOSSA → reconcilia; não achou → relança o erro ORIGINAL;
//   6. vincula a OS na reserva UMA vez (`WHERE chave = esta AND omie_codigo_os IS NULL`).
// Desfecho que pede AÇÃO do vendedor sai como `OsAcaoNoOmieError` (a edge responde 200 estruturado,
// não 500 — o SDK do front só vê "non-2xx" e a instrução se perderia).
import { ausenciaDaOS, chaveIntegracaoOS, type Conferencia, inclusaoValida, lerConsultaOS } from "./chave-os.ts";

/** Maior duração de um IncluirOS em voo (teto do relógio da chamada: 140s) + folga. */
export const JANELA_INCLUSAO_EM_VOO_MS = 3 * 60_000;

export interface ReservaOS {
  order_id: string;
  chave_integracao: string;
  assinatura: string | null;
  omie_codigo_cliente: number | string;
  omie_codigo_os: number | string | null;
  omie_numero_os: string | null;
  reservado_em: string;
}

export interface DepsOS {
  /** INSERT … ON CONFLICT (order_id) DO NOTHING. Lança em erro de banco. */
  reservar(linha: { order_id: string; chave_integracao: string; assinatura: string; omie_codigo_cliente: number }): Promise<void>;
  /** Relê a reserva. Lança em erro de banco; `null` = linha não existe (não deveria após reservar). */
  lerReserva(orderId: string): Promise<ReservaOS | null>;
  /** Reabre a reserva SEM OS da chave antiga para a nova, só se reservada antes de `reservadaAntesDe`.
   *  true = trocou exatamente 1 linha. */
  reabrir(
    orderId: string,
    chaveAnterior: string,
    reservadaAntesDe: string,
    nova: { chave_integracao: string; assinatura: string; omie_codigo_cliente: number; reservado_em: string },
  ): Promise<boolean>;
  /** Grava a OS só se a reserva ainda estiver nesta chave e sem OS. true = esta chamada vinculou. */
  vincular(orderId: string, chave: string, os: { nCodOS: number; cNumOS: string; desfecho: "incluida" | "reconciliada" }): Promise<boolean>;
  incluirOS(osParams: Record<string, unknown>): Promise<unknown>;
  consultarOS(chave: string): Promise<unknown>;
  /** Prova POSITIVA de que a OS não existe no Omie (o `osAusenteNoOmie` da edge). */
  osAusente(erro: unknown): boolean;
  agora?(): number;
  log?(msg: string): void;
}

export type DesfechoOS = {
  nCodOS: number;
  cNumOS: string;
  /** A OS já existia (reenvio do mesmo checkout ou criada por tentativa anterior). */
  reconciliada: boolean;
  /** Esta chamada vinculou a OS na reserva (só ela manda o e-mail). */
  primeiro: boolean;
  /** `diverge` = a OS que existe é de OUTRO carrinho deste pedido: nada de gravar `orders`. */
  conferencia: Conferencia;
  /** Payload REALMENTE enviado por esta chamada; `null` = esta chamada não enviou (não recalcular:
   *  os vencimentos dependem do dia do envio). */
  payloadEnviado: Record<string, unknown> | null;
  resposta: unknown;
};

export type MotivoAcao = "os_cancelada" | "os_excluida" | "pedido_mudou" | "aguardar";

/** Desfecho que o vendedor precisa ler (a edge devolve 200 `{success:false, motivo}`). */
export class OsAcaoNoOmieError extends Error {
  constructor(public motivo: MotivoAcao, public cNumOS: string | null, mensagem: string) {
    super(mensagem);
    this.name = "OsAcaoNoOmieError";
  }
}

function erroMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Consulta a OS pela chave. `achou` = a NOSSA OS (chave, cliente, ativa); `ausente` = prova
 *  positiva de que a OS consultada não existe (nunca a ausência de outra entidade). */
async function consultarNossa(
  deps: DepsOS, chave: string, cliente: number,
): Promise<{ achou: { nCodOS: number; cNumOS: string; resposta: unknown } | null; ausente: boolean; erro?: unknown }> {
  let resposta: unknown;
  try {
    resposta = await deps.consultarOS(chave);
  } catch (e) {
    return { achou: null, ausente: deps.osAusente(e) && ausenciaDaOS(erroMsg(e)), erro: e };
  }
  const leitura = lerConsultaOS(resposta, chave, cliente);
  if (leitura.tipo === "cancelada") {
    throw new OsAcaoNoOmieError(
      "os_cancelada", leitura.cNumOS,
      `A OS ${leitura.cNumOS} deste pedido foi CANCELADA no Omie — não dá para recriá-la com a mesma chave. Monte um pedido novo.`,
    );
  }
  if (leitura.tipo === "invalida") {
    deps.log?.(`[OS idempotente] ConsultarOS(${chave}) não comprovou a OS: ${leitura.motivo}`);
    return { achou: null, ausente: false };
  }
  return { achou: { nCodOS: leitura.nCodOS, cNumOS: leitura.cNumOS, resposta }, ausente: false };
}

function naoConferiu(c: { erro?: unknown }): Error {
  return new Error(
    `Não deu para conferir no Omie a OS de uma tentativa anterior deste pedido` +
      `${c.erro ? ` (${erroMsg(c.erro)})` : ""}. Nada foi criado — tente de novo em instantes.`,
  );
}

export async function criarOuReconciliarOS(
  deps: DepsOS,
  args: {
    orderId: string;
    omieCodigoCliente: number;
    assinatura: string;
    /** Monta o payload do IncluirOS com a chave dada (preço/pagamento/itens ficam na edge). */
    montarPayload(chave: string): Record<string, unknown>;
  },
): Promise<DesfechoOS> {
  const { orderId, omieCodigoCliente: cliente, assinatura } = args;
  const agora = deps.agora?.() ?? Date.now();
  const chave = await chaveIntegracaoOS(orderId, cliente, assinatura);

  await deps.reservar({ order_id: orderId, chave_integracao: chave, assinatura, omie_codigo_cliente: cliente });
  const reserva = await deps.lerReserva(orderId);
  if (!reserva) throw new Error(`Reserva da OS do pedido ${orderId} não encontrada após gravar — envio abortado.`);
  const temOS = reserva.omie_codigo_os !== null && Number(reserva.omie_codigo_os) > 0;

  if (reserva.chave_integracao !== chave) {
    // 3. O carrinho (ou o cliente) mudou desde a tentativa que reservou o pedido.
    if (temOS) {
      return {
        nCodOS: Number(reserva.omie_codigo_os), cNumOS: reserva.omie_numero_os ?? reserva.chave_integracao,
        reconciliada: true, primeiro: false, conferencia: "diverge", payloadEnviado: null, resposta: null,
      };
    }
    const c = await consultarNossa(deps, reserva.chave_integracao, Number(reserva.omie_codigo_cliente));
    if (c.achou) {
      // A tentativa anterior criou a OS e perdeu a resposta: registra o vínculo dela e acusa a divergência.
      const vinculou = await deps.vincular(orderId, reserva.chave_integracao, { ...c.achou, desfecho: "reconciliada" });
      return {
        nCodOS: c.achou.nCodOS, cNumOS: c.achou.cNumOS, reconciliada: true, primeiro: vinculou,
        conferencia: "diverge", payloadEnviado: null, resposta: { reconciliada: true, consulta: c.achou.resposta },
      };
    }
    if (!c.ausente) throw naoConferiu(c);
    const limite = new Date(agora - JANELA_INCLUSAO_EM_VOO_MS).toISOString();
    if (!(Date.parse(reserva.reservado_em) < Date.parse(limite))) {
      throw new OsAcaoNoOmieError(
        "aguardar", null,
        "Uma tentativa anterior deste pedido começou há menos de 3 minutos e ainda pode criar a OS no Omie. Aguarde alguns minutos e reenvie.",
      );
    }
    const reabriu = await deps.reabrir(orderId, reserva.chave_integracao, limite, {
      chave_integracao: chave, assinatura, omie_codigo_cliente: cliente, reservado_em: new Date(agora).toISOString(),
    });
    if (!reabriu) throw new Error(`Outro envio deste pedido mexeu na reserva ao mesmo tempo — nada foi criado. Tente de novo.`);
  } else if (temOS) {
    // 4. Mesmo carrinho, OS já vinculada: a resposta anterior se perdeu. Ela segue ativa no Omie?
    const c = await consultarNossa(deps, chave, cliente);
    if (c.achou) {
      return {
        nCodOS: c.achou.nCodOS, cNumOS: c.achou.cNumOS, reconciliada: true, primeiro: false,
        conferencia: "confere", payloadEnviado: null, resposta: null,
      };
    }
    if (c.ausente) {
      throw new OsAcaoNoOmieError(
        "os_excluida", reserva.omie_numero_os,
        `A OS ${reserva.omie_numero_os ?? ""} deste pedido não existe mais no Omie (foi excluída). Monte um pedido novo.`,
      );
    }
    throw naoConferiu(c);
  }

  // 5. Inclusão com a chave do conteúdo.
  const payload = args.montarPayload(chave);
  let criada: { nCodOS: number; cNumOS: string } | null = null;
  let resposta: unknown = null;
  let erroInclusao: unknown = null;
  try {
    resposta = await deps.incluirOS(payload);
    criada = inclusaoValida(resposta, chave);
    if (!criada) erroInclusao = new Error(`Omie respondeu ao IncluirOS sem uma OS válida (${JSON.stringify(resposta)})`);
  } catch (e) {
    erroInclusao = e;
  }

  let os = criada;
  let reconciliada = false;
  if (!os) {
    // Falhou: a OS pode existir mesmo assim (timeout, "já cadastrado", 200 incompleto).
    deps.log?.(`[OS idempotente] IncluirOS(${chave}) falhou (${erroMsg(erroInclusao)}) — consultando pela chave`);
    const c = await consultarNossa(deps, chave, cliente);
    if (!c.achou) throw erroInclusao;
    os = { nCodOS: c.achou.nCodOS, cNumOS: c.achou.cNumOS };
    resposta = { reconciliada: true, erro_inclusao: erroMsg(erroInclusao), consulta: c.achou.resposta };
    reconciliada = true;
  }

  // 6. Vínculo único.
  const vinculou = await deps.vincular(orderId, chave, { ...os, desfecho: reconciliada ? "reconciliada" : "incluida" });
  if (!vinculou) {
    const r = await deps.lerReserva(orderId);
    if (!r || r.chave_integracao !== chave) {
      throw new OsAcaoNoOmieError(
        "pedido_mudou", os.cNumOS,
        `O pedido mudou enquanto a OS ${os.cNumOS} era criada no Omie (com o carrinho anterior). Confira no Omie antes de reenviar.`,
      );
    }
    if (r.omie_codigo_os === null || Number(r.omie_codigo_os) !== os.nCodOS) {
      throw new Error(
        `Pedido ${orderId}: a OS vinculada (${r.omie_codigo_os ?? "nenhuma"}) difere da que o Omie devolveu (${os.nCodOS}) — confira no Omie.`,
      );
    }
    return { ...os, reconciliada: true, primeiro: false, conferencia: "confere", payloadEnviado: payload, resposta };
  }
  return { ...os, reconciliada, primeiro: true, conferencia: "confere", payloadEnviado: payload, resposta };
}
