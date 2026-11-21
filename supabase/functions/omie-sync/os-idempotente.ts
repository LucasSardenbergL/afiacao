// Orquestração IDEMPOTENTE da criação da OS de Afiação (follow-up Codex do #4042).
// Dependências injetadas (banco e Omie) para que cada ramo seja testado no runtime real
// (os-idempotente_test.ts) — a edge (`index.ts`) só liga as pontas.
//
// Ordem:
//   1. reserva o pedido (INSERT … ON CONFLICT DO NOTHING na PK order_id) e RELÊ a linha — dois
//      envios do mesmo checkout disputam a MESMA linha;
//   2. a linha já tem OS → devolve ela, conferindo a assinatura da 1ª tentativa (imutável);
//   3. a assinatura mudou e ainda não há OS → só reabre a reserva se o Omie PROVAR que a chave não
//      existe lá (a 1ª tentativa pode ter criado a OS e perdido a resposta);
//   4. IncluirOS com a chave determinística; QUALQUER falha (inclusive timeout e o "já cadastrado"
//      cujo texto não conhecemos) → ConsultarOS pela chave; achou a NOSSA → reconcilia; não achou →
//      relança o erro ORIGINAL;
//   5. vincula a OS na reserva UMA vez (`WHERE omie_codigo_os IS NULL`); quem vinculou é o
//      `primeiro` — só ele grava omie_ordens_servico/orders e manda o e-mail.
import {
  chaveIntegracaoOS,
  type Conferencia,
  conferirReserva,
  inclusaoValida,
  lerConsultaOS,
} from "./chave-os.ts";

export interface ReservaOS {
  order_id: string;
  chave_integracao: string;
  assinatura: string | null;
  omie_codigo_cliente: number | string;
  omie_codigo_os: number | string | null;
  omie_numero_os: string | null;
}

export interface DepsOS {
  /** INSERT … ON CONFLICT (order_id) DO NOTHING. Lança em erro de banco. */
  reservar(linha: { order_id: string; chave_integracao: string; assinatura: string | null; omie_codigo_cliente: number }): Promise<void>;
  /** Relê a reserva. Lança em erro de banco; `null` = linha não existe (não deveria após reservar). */
  lerReserva(orderId: string): Promise<ReservaOS | null>;
  /** Reabre a reserva SEM OS com a assinatura/cliente novos. Devolve true se trocou exatamente 1 linha. */
  regravarAssinatura(orderId: string, assinaturaAnterior: string | null, nova: { assinatura: string | null; omie_codigo_cliente: number }): Promise<boolean>;
  /** Grava a OS na reserva só se ainda não houver (`WHERE omie_codigo_os IS NULL`). true = esta chamada vinculou. */
  vincular(orderId: string, os: { nCodOS: number; cNumOS: string; desfecho: "incluida" | "reconciliada" }): Promise<boolean>;
  incluirOS(osParams: Record<string, unknown>): Promise<unknown>;
  consultarOS(chave: string): Promise<unknown>;
  /** Prova POSITIVA de que a OS não existe no Omie (o `osAusenteNoOmie` da edge). */
  osAusente(erro: unknown): boolean;
  log?(msg: string): void;
}

export type DesfechoOS = {
    ok: true;
    nCodOS: number;
    cNumOS: string;
    reconciliada: boolean;
    /** Esta chamada é a que vinculou a OS (grava os registros locais e manda o e-mail). */
    primeiro: boolean;
    conferencia: Conferencia;
    payloadEnviado: Record<string, unknown> | null;
    resposta: unknown;
  };

function erroMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Consulta a OS pela chave depois de uma falha. `null` = não deu para achar a NOSSA OS (o chamador
 *  decide o que fazer com o erro original). Cancelada lança: o Omie não aceita outra OS com a mesma
 *  chave, então o vendedor precisa de um pedido novo. */
async function consultarNossa(
  deps: DepsOS, chave: string, cliente: number,
): Promise<{ achou: { nCodOS: number; cNumOS: string; resposta: unknown } | null; ausente: boolean; erro?: unknown }> {
  let resposta: unknown;
  try {
    resposta = await deps.consultarOS(chave);
  } catch (e) {
    return { achou: null, ausente: deps.osAusente(e), erro: e };
  }
  const leitura = lerConsultaOS(resposta, chave, cliente);
  if (leitura.tipo === "cancelada") {
    throw new Error(`A OS ${leitura.cNumOS} deste pedido foi CANCELADA no Omie — não dá para recriá-la com a mesma chave. Monte um pedido novo.`);
  }
  if (leitura.tipo === "invalida") {
    deps.log?.(`[OS idempotente] ConsultarOS(${chave}) não comprovou a OS: ${leitura.motivo}`);
    return { achou: null, ausente: false };
  }
  return { achou: { nCodOS: leitura.nCodOS, cNumOS: leitura.cNumOS, resposta }, ausente: false };
}

export async function criarOuReconciliarOS(
  deps: DepsOS,
  args: {
    orderId: string;
    omieCodigoCliente: number;
    assinatura: string | null;
    /** Monta o payload do IncluirOS com a chave dada (preço/pagamento/itens ficam na edge). */
    montarPayload(chave: string): Record<string, unknown>;
  },
): Promise<DesfechoOS> {
  const { orderId, omieCodigoCliente: cliente, assinatura } = args;
  const chave = chaveIntegracaoOS(orderId);

  await deps.reservar({ order_id: orderId, chave_integracao: chave, assinatura, omie_codigo_cliente: cliente });
  const reserva = await deps.lerReserva(orderId);
  if (!reserva) throw new Error(`Reserva da OS do pedido ${orderId} não encontrada após gravar — envio abortado.`);
  if (reserva.chave_integracao !== chave) {
    throw new Error(`Reserva do pedido ${orderId} tem outra chave (${reserva.chave_integracao}) — envio abortado.`);
  }

  const conferencia = conferirReserva(reserva, { assinatura, omieCodigoCliente: cliente });

  // 2. Já existe OS vinculada: o caso comum de "a resposta se perdeu" (a edge concluiu).
  if (reserva.omie_codigo_os !== null && Number(reserva.omie_codigo_os) > 0) {
    return {
      ok: true,
      nCodOS: Number(reserva.omie_codigo_os),
      cNumOS: reserva.omie_numero_os ?? chave,
      reconciliada: true,
      primeiro: false,
      conferencia,
      payloadEnviado: null,
      resposta: null,
    };
  }

  // 3. Mudou o pedido (ou o cliente) e ainda não há OS vinculada: a 1ª tentativa pode ter criado
  //    a OS no Omie e perdido a resposta. Só o Omie decide.
  if (conferencia !== "confere") {
    const c = await consultarNossa(deps, chave, Number(reserva.omie_codigo_cliente));
    if (c.achou) {
      const primeiro = await deps.vincular(orderId, { nCodOS: c.achou.nCodOS, cNumOS: c.achou.cNumOS, desfecho: "reconciliada" });
      return {
        ok: true, nCodOS: c.achou.nCodOS, cNumOS: c.achou.cNumOS, reconciliada: true, primeiro,
        conferencia, payloadEnviado: null, resposta: { reconciliada: true, consulta: c.achou.resposta },
      };
    }
    if (!c.ausente) {
      throw new Error(
        `Não deu para conferir no Omie se a OS de uma tentativa anterior deste pedido existe` +
          `${c.erro ? ` (${erroMsg(c.erro)})` : ""}. Nada foi criado — tente de novo em instantes.`,
      );
    }
    const trocou = await deps.regravarAssinatura(orderId, reserva.assinatura, { assinatura, omie_codigo_cliente: cliente });
    if (!trocou) throw new Error(`Outro envio deste pedido mexeu na reserva ao mesmo tempo — nada foi criado. Tente de novo.`);
  }

  // 4. Inclusão com a chave determinística.
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

  if (criada) {
    const primeiro = await deps.vincular(orderId, { nCodOS: criada.nCodOS, cNumOS: criada.cNumOS, desfecho: "incluida" });
    if (!primeiro) return await jaVinculada(deps, orderId, criada, "confere");
    return { ok: true, ...criada, reconciliada: false, primeiro: true, conferencia: "confere", payloadEnviado: payload, resposta };
  }

  // Falhou: a OS pode existir mesmo assim (timeout, "já cadastrado", 200 sem corpo).
  deps.log?.(`[OS idempotente] IncluirOS(${chave}) falhou (${erroMsg(erroInclusao)}) — consultando pela chave`);
  const c = await consultarNossa(deps, chave, cliente);
  if (!c.achou) throw erroInclusao;
  const primeiro = await deps.vincular(orderId, { nCodOS: c.achou.nCodOS, cNumOS: c.achou.cNumOS, desfecho: "reconciliada" });
  if (!primeiro) return await jaVinculada(deps, orderId, c.achou, "confere");
  return {
    ok: true, nCodOS: c.achou.nCodOS, cNumOS: c.achou.cNumOS, reconciliada: true, primeiro: true,
    conferencia: "confere", payloadEnviado: payload,
    resposta: { reconciliada: true, erro_inclusao: erroMsg(erroInclusao), consulta: c.achou.resposta },
  };
}

/** Outro envio vinculou primeiro (corrida). Devolve a OS que ficou na reserva — e se ela não for a
 *  mesma que esta chamada viu no Omie, é anomalia: lança em vez de escolher uma. */
async function jaVinculada(
  deps: DepsOS, orderId: string, vista: { nCodOS: number; cNumOS: string }, conferencia: Conferencia,
): Promise<DesfechoOS> {
  const r = await deps.lerReserva(orderId);
  if (!r || r.omie_codigo_os === null || Number(r.omie_codigo_os) !== vista.nCodOS) {
    throw new Error(
      `Pedido ${orderId}: a OS vinculada (${r?.omie_codigo_os ?? "nenhuma"}) difere da que o Omie devolveu (${vista.nCodOS}) — confira no Omie.`,
    );
  }
  return {
    ok: true, nCodOS: vista.nCodOS, cNumOS: r.omie_numero_os ?? vista.cNumOS, reconciliada: true, primeiro: false,
    conferencia, payloadEnviado: null, resposta: null,
  };
}
