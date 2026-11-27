// O que a EDIÇÃO de um pedido do app (`alterar_pedido`) pode mandar ao Omie, e quando ela é recusada.
// Puro (zero Deno/DB): provado por `deno test supabase/functions/omie-vendas-sync/edicao-omie_test.ts`.
//
// Por que existe (revisão Codex+Fable de 2026-11-25 da tela de edição em /sales; plano revisado pelo
// Codex em 2026-11-26):
//   • o AlterarPedidoVenda da edição mandava `etapa: "10"`, `data_previsao` = HOJE e um frete montado
//     do zero (modalidade "0", espécie "VOL") — salvar só uma observação podia REGREDIR a etapa no ERP,
//     trocar a previsão e apagar transportadora/volumes/valor do frete gravados no Omie;
//   • o recibo do app (`hash_payload` NULL) cujo espelho importado do MESMO `(account, omie_pedido_id)`
//     já está em separação/faturado seguia editável: a edge relê pelo id local e substitui os itens no
//     ERP. Medido em 2026-11-26 (psql-ro): 19 dos 25 recibos com PV estão `enviado` no app com o gêmeo
//     `faturado` (R$ 11.565,88), 2 deles com o PV reaproveitado no Omie para OUTRO cliente;
//   • os 25 recibos têm `customer_document` NULL, então a verificação de identidade da edição
//     (`deriveOmieAccountIdentity`) era pulada: nada impedia substituir os itens de um PV que hoje é
//     de outro cliente. A âncora que existe é o `codigo_cliente` que o PRÓPRIO app mandou ao criar o
//     PV (20 de 25 o têm no `omie_payload`; os 5 sem ele têm o gêmeo faturado).

/** Etapas do Omie em que o app ainda edita o pedido: 10 (pedido) e 20 (separar estoque). Restrição de
 *  PRODUTO assumida (o Omie aceita alterar em 50): em 50 o pedido já está em separação para faturar;
 *  60/70 faturado; 80 cancelado. Mesmo mapa de `_shared/omie-pedido.ts` (`omieEtapaToStatus`). */
const ETAPAS_EDITAVEIS: readonly string[] = ["10", "20"];

/** Status do ESPELHO importado (o que o sync gravou a partir da etapa) em que o app ainda edita. */
const STATUS_GEMEO_EDITAVEIS: readonly string[] = ["importado", "enviado"];

/** Status do PRÓPRIO pedido em que a edge recusa — a mesma lista do front (`BLOCKED_STATUSES` em
 *  `src/components/salesOrderEdit/types.ts`); a trava do React não protege uma tela antiga aberta. */
const STATUS_PEDIDO_NAO_EDITAVEIS: readonly string[] = ["cancelado", "entregue", "faturado", "importado"];

type BloqueioEdicao =
  | "conta_desconhecida"
  | "origem_omie"
  | "status_pedido"
  | "gemeo_omie"
  | "etapa_omie"
  | "leitura_omie_incompleta"
  | "cliente_omie"
  | "pedido_excluido"
  | "edicao_concorrente"
  | "versao_ausente";

export type VereditoEdicao =
  | { permitido: true }
  | { permitido: false; bloqueio: BloqueioEdicao; motivo: string };

/** O pedido local, ANTES de ler o Omie: conta conhecida, origem do app e status editável. */
export function vereditoPedidoLocalEdicao(input: {
  account: unknown;
  hashPayload: string | null;
  status: string | null;
  /** `deleted_at` preenchido. Opcional só para chamadas antigas; a edge sempre informa (#6). */
  excluido?: boolean;
}): VereditoEdicao {
  if (input.excluido === true) {
    return {
      permitido: false,
      bloqueio: "pedido_excluido",
      motivo: "o pedido foi excluído do app — nada foi alterado. Recarregue a lista de pedidos.",
    };
  }
  if (input.account !== "oben" && input.account !== "colacor") {
    return {
      permitido: false,
      bloqueio: "conta_desconhecida",
      motivo: `a conta do pedido é desconhecida (${String(input.account)}) — nada foi alterado.`,
    };
  }
  if (input.hashPayload !== null && input.hashPayload.startsWith("omie_")) {
    return {
      permitido: false,
      bloqueio: "origem_omie",
      motivo: "pedido importado do Omie: o app só espelha. Para alterar, altere no Omie.",
    };
  }
  if (!input.status || STATUS_PEDIDO_NAO_EDITAVEIS.includes(input.status)) {
    return {
      permitido: false,
      bloqueio: "status_pedido",
      motivo: `o pedido está com status "${input.status ?? "desconhecido"}" e não pode ser editado.`,
    };
  }
  return { permitido: true };
}

/** Espelho importado do mesmo PV, como lido de `sales_orders`. */
export interface GemeoLido {
  status: string | null;
}

/**
 * Recibo do app × espelho importado do mesmo PV. Sem gêmeo → permitido (o sync ainda não trouxe o PV;
 * a etapa e o cliente VIVOS ainda são conferidos no ConsultarPedido). O cliente NÃO se compara por
 * UUID aqui: o gêmeo pode estar sob o alias fiscal do mesmo cliente (Colacor SC × Oben) — quem prova
 * o cliente é o `codigo_cliente` vivo contra a âncora do recibo (`vereditoClienteEdicao`).
 */
export function vereditoGemeoEdicao(gemeo: GemeoLido | null): VereditoEdicao {
  if (!gemeo) return { permitido: true };
  if (!gemeo.status || !STATUS_GEMEO_EDITAVEIS.includes(gemeo.status)) {
    return {
      permitido: false,
      bloqueio: "gemeo_omie",
      motivo: `o pedido já avançou no Omie (status "${gemeo.status ?? "desconhecido"}") — altere direto no Omie.`,
    };
  }
  return { permitido: true };
}

/** `codigo_cliente` que o app mandou ao criar o PV (âncora do recibo), ou null se não houver. */
export function codigoClienteDoPayload(omiePayload: unknown): number | null {
  const cab = (omiePayload as { cabecalho?: { codigo_cliente?: unknown } } | null | undefined)?.cabecalho;
  const n = Number(cab?.codigo_cliente);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * O PV vivo ainda é do cliente para quem o app o criou? Sem âncora ou sem o cliente vivo, recusa:
 * a edição EXCLUI e reinclui todos os itens, e sem prova pode ser o pedido de outra pessoa
 * (PV reaproveitado no Omie — `docs/historico/gemeos-push-pull-contagem-unica.md`).
 */
export function vereditoClienteEdicao(input: {
  codigoClienteAncora: number | null;
  codigoClienteVivo: number | null;
  /** `false` quando o envio VINCULOU um PV já existente por duplicidade (`omie_response.reconciled`):
   *  desde o #4174 o `omie_payload` gravado é o PV consultado, então o cliente dele não prova nada sobre
   *  o cliente do pedido (Codex 2026-11-26). 0 recibos reconciliados na prod em 2026-11-26. */
  ancoraIndependente: boolean;
}): VereditoEdicao {
  if (!input.ancoraIndependente) {
    return {
      permitido: false,
      bloqueio: "cliente_omie",
      motivo: "este pedido foi vinculado a um PV que já existia no Omie (envio repetido) — não há registro independente do cliente. Confira e altere direto no Omie.",
    };
  }
  if (input.codigoClienteAncora === null || input.codigoClienteVivo === null) {
    return {
      permitido: false,
      bloqueio: "cliente_omie",
      motivo: input.codigoClienteAncora === null
        ? "não há registro do cliente para quem o app criou este pedido no Omie — não dá para provar que o PV ainda é dele. Altere direto no Omie."
        : "a leitura do pedido no Omie veio sem o cliente — nada foi alterado. Tente de novo; se repetir, altere no Omie.",
    };
  }
  if (input.codigoClienteAncora !== input.codigoClienteVivo) {
    return {
      permitido: false,
      bloqueio: "cliente_omie",
      motivo: "o número deste pedido no Omie está hoje com outro cliente (PV reaproveitado) — confira e altere direto no Omie.",
    };
  }
  return { permitido: true };
}

/** O que a edição precisa ler do ConsultarPedido para não fabricar cabeçalho, frete nem classificação. */
export interface CabecalhoLido {
  etapa: string | null;
  dataPrevisao: string | null;
  /** `infoCadastro.cancelado`/`faturado` como vieram: 'S', 'N' ou null (ausente/ilegível). */
  cancelado: string | null;
  faturado: string | null;
  frete: Record<string, unknown> | null;
  categoria: string | null;
  contaCorrente: number | null;
  codVend: number | null;
  /** `observacoes.obs_venda` VIVA do PV — o que a edição preserva quando a tela não manda observação. */
  observacaoViva?: string | null;
}

type ConsultaCrua = {
  pedido_venda_produto?: ConsultaCrua;
  cabecalho?: { etapa?: unknown; data_previsao?: unknown };
  frete?: unknown;
  infoCadastro?: { cancelado?: unknown; faturado?: unknown };
  informacoes_adicionais?: { codigo_categoria?: unknown; codigo_conta_corrente?: unknown; codVend?: unknown };
  observacoes?: { obs_venda?: unknown };
} | null | undefined;

function textoOuNull(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function inteiroPositivoOuNull(v: unknown): number | null {
  const n = Number(v);
  return v != null && v !== "" && Number.isSafeInteger(n) && n > 0 ? n : null;
}

function marcaSN(v: unknown): string | null {
  return v === "S" || v === "N" ? v : null;
}

/** Lê etapa, previsão, frete, classificação e as marcas de cancelado/faturado. Mesmo drift de shape do
 *  `det`: aninhado em `pedido_venda_produto` ou no topo. Ausente fica `null` — nunca um default. */
/**
 * Prazo da edição: sem escolha do vendedor, a edge herda a condição VIVA do PV (`parcelaEfetiva`). Se a
 * leitura também não a trouxer, `parcelaEfetiva` cairia no default `999` e uma edição de observação
 * TROCARIA o prazo do pedido — recusa antes de mutar (Codex r4).
 */
export function vereditoParcelaEdicao(input: { informada: unknown; viva: unknown }): VereditoEdicao {
  const texto = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  if (texto(input.informada) !== "" || texto(input.viva) !== "") return { permitido: true };
  return {
    permitido: false,
    bloqueio: "leitura_omie_incompleta",
    motivo: "a leitura do pedido no Omie veio sem a condição de pagamento e nenhuma foi escolhida — nada foi alterado. Escolha a condição ou tente de novo.",
  };
}

export function lerCabecalhoParaEdicao(consulta: ConsultaCrua): CabecalhoLido {
  const pv = consulta?.pedido_venda_produto ?? null;
  const cab = pv?.cabecalho ?? consulta?.cabecalho;
  const freteCru = pv?.frete ?? consulta?.frete;
  const info = pv?.infoCadastro ?? consulta?.infoCadastro;
  const adic = pv?.informacoes_adicionais ?? consulta?.informacoes_adicionais;
  const obsViva = pv?.observacoes?.obs_venda ?? consulta?.observacoes?.obs_venda;
  return {
    etapa: textoOuNull(cab?.etapa),
    dataPrevisao: textoOuNull(cab?.data_previsao),
    cancelado: marcaSN(info?.cancelado),
    faturado: marcaSN(info?.faturado),
    frete: freteCru && typeof freteCru === "object" && !Array.isArray(freteCru)
      ? { ...(freteCru as Record<string, unknown>) }
      : null,
    categoria: textoOuNull(adic?.codigo_categoria),
    contaCorrente: inteiroPositivoOuNull(adic?.codigo_conta_corrente),
    codVend: inteiroPositivoOuNull(adic?.codVend),
    observacaoViva: typeof obsViva === "string" && obsViva.trim() !== "" ? obsViva : null,
  };
}

/**
 * Pode editar pelo estado VIVO do Omie? Roda ANTES de qualquer mutação no ERP. Leitura incompleta
 * também recusa: sem etapa/previsão/frete o cabeçalho reenviado seria inventado, e sem a marca
 * EXPLÍCITA `cancelado = 'N'` não dá para descartar o cancelado congelado em etapa 10/20 (o Omie
 * congela o cancelado na etapa em que estava — `_shared/omie-pedido.ts` `canceladoNoOmie`).
 */
export function vereditoEtapaEdicao(lido: CabecalhoLido): VereditoEdicao {
  if (lido.cancelado === "S") {
    return { permitido: false, bloqueio: "etapa_omie", motivo: "o pedido está cancelado no Omie." };
  }
  if (lido.faturado === "S") {
    return { permitido: false, bloqueio: "etapa_omie", motivo: "o pedido já foi faturado no Omie." };
  }
  const falta = [
    lido.etapa === null ? "etapa" : null,
    lido.dataPrevisao === null ? "data de previsão" : null,
    lido.frete === null ? "frete" : null,
    lido.cancelado === null ? "situação de cancelamento" : null,
    lido.categoria === null ? "categoria" : null,
    lido.contaCorrente === null ? "conta corrente" : null,
  ].filter(Boolean);
  if (falta.length > 0) {
    return {
      permitido: false,
      bloqueio: "leitura_omie_incompleta",
      motivo: `a leitura do pedido no Omie veio sem ${falta.join(", ")} — nada foi alterado. Tente de novo; se repetir, altere no Omie.`,
    };
  }
  if (!ETAPAS_EDITAVEIS.includes(lido.etapa as string)) {
    return {
      permitido: false,
      bloqueio: "etapa_omie",
      motivo: `o pedido já está na etapa ${lido.etapa} no Omie (separação/faturamento) — altere direto no Omie.`,
    };
  }
  return { permitido: true };
}

/** Cabeçalho do AlterarPedidoVenda: etapa e previsão são as LIDAS (a edição não as muda); só a
 *  parcela é do vendedor. `codigo_cliente` vai junto só para o write-back local guardar a âncora
 *  (o payload regravado pela edição a perdia). Exige leitura aprovada por `vereditoEtapaEdicao`. */
export function cabecalhoDaEdicao(input: {
  codigoPedido: number;
  lido: CabecalhoLido;
  codigoParcela: string;
}): Record<string, unknown> {
  if (input.lido.etapa === null || input.lido.dataPrevisao === null) {
    throw new Error("cabecalhoDaEdicao: leitura sem etapa/previsão — vereditoEtapaEdicao deveria ter recusado");
  }
  return {
    codigo_pedido: input.codigoPedido,
    data_previsao: input.lido.dataPrevisao,
    etapa: input.lido.etapa,
    codigo_parcela: input.codigoParcela,
  };
}

/** Frete do AlterarPedidoVenda: o LIDO do Omie, intacto; o caller só sobrescreve volumes quando os
 *  manda (a tela de edição não manda). */
export function freteDaEdicao(input: {
  lido: CabecalhoLido;
  quantidadeVolumes?: unknown;
}): Record<string, unknown> {
  if (input.lido.frete === null) {
    throw new Error("freteDaEdicao: leitura sem frete — vereditoEtapaEdicao deveria ter recusado");
  }
  const frete = { ...input.lido.frete };
  const vol = Number(input.quantidadeVolumes);
  if (input.quantidadeVolumes != null && Number.isInteger(vol) && vol > 0) frete.quantidade_volumes = vol;
  return frete;
}

/** Classificação do AlterarPedidoVenda: a LIDA do Omie, sem default nenhum — uma reclassificação ou a
 *  remoção do vendedor feita no ERP não é desfeita por quem só trocou a observação. Categoria e conta
 *  corrente ausentes já recusaram em `vereditoEtapaEdicao`; vendedor ausente vai ausente (Codex
 *  2026-11-26: reenviar o `codVend` da criação restaurava um vendedor removido no Omie). */
export function informacoesAdicionaisDaEdicao(lido: CabecalhoLido): Record<string, unknown> {
  if (lido.categoria === null || lido.contaCorrente === null) {
    throw new Error("informacoesAdicionaisDaEdicao: leitura sem categoria/conta corrente — vereditoEtapaEdicao deveria ter recusado");
  }
  const out: Record<string, unknown> = {
    codigo_categoria: lido.categoria,
    codigo_conta_corrente: lido.contaCorrente,
  };
  if (lido.codVend !== null) out.codVend = lido.codVend;
  return out;
}

// ── Concorrência e desfecho da edição (revisão /sales, leva 1: #6, #7, #17, #30) ──────────────────────

/**
 * Versão da linha (`updated_at` visto ao abrir a tela) contra a qual a edição RESERVA o pedido antes de tocar o
 * Omie (#7). Ausente ou de tipo errado RECUSA (Codex 2026-11-26): emprestar a versão lida agora a uma aba antiga
 * deixaria a lista inteira dela desfazer a edição já concluída de outra pessoa. `null` explícito casa
 * `IS NULL` (no esquema atual `updated_at` é NOT NULL → 0 linhas → recusa na reserva).
 */
export type VersaoDaEdicao =
  | { ok: true; valor: string | null }
  | { ok: false; motivo: string };

export function versaoDaEdicao(input: { presente: boolean; informada: unknown }): VersaoDaEdicao {
  if (!input.presente) {
    return {
      ok: false,
      motivo: "esta tela é de uma versão antiga do app e não diz qual versão do pedido foi editada. " +
        "Atualize o app (recarregue a página) e edite de novo — nada foi alterado.",
    };
  }
  if (input.informada === null) return { ok: true, valor: null };
  if (typeof input.informada === "string" && input.informada.trim() !== "") return { ok: true, valor: input.informada };
  return { ok: false, motivo: "a versão do pedido enviada pela tela é ilegível — recarregue o pedido; nada foi alterado." };
}

export const MOTIVO_EDICAO_CONCORRENTE =
  "o pedido mudou desde que esta tela foi aberta (outra edição, envio, exclusão ou mudança de status). " +
  "Nada foi alterado no Omie — recarregue o pedido para ver a versão atual.";

/**
 * Observação que o write-back grava (#17). Antes: `editObs || notasAtuais` — limpar o campo (`""`) trazia a
 * observação velha de volta. Chave ausente = não mexer; string vazia/só espaço = limpar (NULL); outro tipo =
 * não é observação, mantém a atual.
 */
export function notasDaEdicao(input: { presente: boolean; informada: unknown; atuais: string | null }): string | null {
  if (!input.presente || typeof input.informada !== "string") return input.atuais;
  return input.informada.trim() === "" ? null : input.informada;
}

/**
 * Corpo do 500 do handler. `precisa_recarregar` = a falha veio DEPOIS da reserva do pedido (a versão já mudou
 * e o Omie pode ter mudado): a tela não pode reenviar o mesmo formulário (#30).
 */
export function corpoDoErro(input: {
  mensagem: string;
  /** `fora` = não é `alterar_pedido`; `antes` = falhou antes da reserva (nada mudou: tentar de novo é seguro). */
  edicao: "fora" | "antes" | "depois";
}): Record<string, unknown> {
  if (input.edicao === "fora") return { error: input.mensagem };
  // `false` EXPLÍCITO antes da reserva: a tela só destrava com a prova. Sem a chave (edge antiga, resposta
  // perdida, corpo não-JSON) o resultado é indeterminado e a tela congela (Codex 2026-11-26).
  return { error: input.mensagem, precisa_recarregar: input.edicao === "depois" };
}

/**
 * `obs_venda` que a edição manda ao Omie — e que o `omie_payload` espelha (#17, Codex 2026-11-26). Uma só
 * normalização para as duas pontas, irmã de `notasDaEdicao`:
 * • texto → o texto; vazio/só espaço = limpeza explícita → volta o texto padrão da conta (mesmo default da
 *   criação; na Oben carrega o texto fiscal do recibo, que espaços em branco apagariam);
 * • chave ausente → preserva a observação VIVA do PV (o prefixo por cima apagaria uma nota comercial);
 *   sem leitura viva, o padrão da conta.
 */
export function observacaoParaOmie(input: {
  presente: boolean;
  informada: unknown;
  viva: string | null | undefined;
  /** `sales_orders.notes`: o que a main mandava. Vale quando a leitura do PV não trouxe a observação. */
  notaLocal: string | null | undefined;
  padraoDaConta: string;
}): string {
  if (input.presente && typeof input.informada === "string") {
    return input.informada.trim() === "" ? input.padraoDaConta : input.informada;
  }
  // Leitura sem `observacoes` é inconclusiva, não "PV sem nota": cair no padrão apagaria uma condição
  // comercial no ERP (Codex 2026-11-26). Antes do padrão, a nota que o app tem.
  const local = typeof input.notaLocal === "string" && input.notaLocal.trim() !== "" ? input.notaLocal : null;
  return input.viva ?? local ?? input.padraoDaConta;
}

// ── Posse DURÁVEL da edição (leva 1 PR 2, migration 20261127100200) ──────────────────────────────────────
// Uma tentativa por token no banco (`pedido_edicao_omie_tentativa`), no máximo uma viva por (conta, PV).
// A tela gera o token e o manda; com ele, depois de perder a resposta, ela pergunta ao banco o que houve
// (`pedido_edicao_omie_encerrar_envio`). Tela antiga (sem token) → a edge gera um: a posse vale igual,
// só a consulta posterior que não.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TokenDaEdicao = { ok: true; valor: string; daTela: boolean } | { ok: false; motivo: string };

/** Token da tentativa. Presente e malformado RECUSA (não troca por um gerado: a tela consultaria outro). */
export function tokenDaEdicao(input: { presente: boolean; informado: unknown; gerar: () => string }): TokenDaEdicao {
  if (!input.presente || input.informado === undefined || input.informado === null) {
    return { ok: true, valor: input.gerar(), daTela: false };
  }
  if (typeof input.informado !== "string" || !UUID_RE.test(input.informado)) {
    return { ok: false, motivo: "identificador do salvamento inválido — atualize o app (recarregue a página) e tente de novo." };
  }
  return { ok: true, valor: input.informado.toLowerCase(), daTela: true };
}

export const MOTIVO_EDICAO_EM_CURSO =
  "este pedido está sendo salvo agora em outra aba ou aparelho. Nada foi alterado no Omie por esta tela — " +
  "aguarde alguns minutos e recarregue o pedido.";

export const MOTIVO_EDICAO_DIVERGENTE =
  "a última edição deste pedido pode ter alterado o Omie sem o app conseguir confirmar como ele ficou. " +
  "Confira o pedido direto no Omie; um gestor libera a edição no app depois de conferir.";

export type RecusaDaPosse = { bloqueio: "edicao_concorrente" | "edicao_em_curso" | "edicao_divergente"; motivo: string };

/**
 * Desfecho de `pedido_edicao_omie_reivindicar`. `null` = reivindicado (segue). Toda recusa vem ANTES de
 * tocar o Omie. Resposta desconhecida LANÇA (fail-closed: nunca vira "reivindicado" por omissão).
 */
export function recusaDaReivindicacao(desfecho: unknown): RecusaDaPosse | null {
  switch (desfecho) {
    case "reivindicado": return null;
    case "pedido_alterado":
    case "excluido":
    case "ausente":
    case "sem_pv":
    case "token_encerrado":
      return { bloqueio: "edicao_concorrente", motivo: MOTIVO_EDICAO_CONCORRENTE };
    case "em_edicao": return { bloqueio: "edicao_em_curso", motivo: MOTIVO_EDICAO_EM_CURSO };
    case "divergente": return { bloqueio: "edicao_divergente", motivo: MOTIVO_EDICAO_DIVERGENTE };
    default:
      throw new Error(`Edição recusada: resposta inesperada ao reservar o pedido (${JSON.stringify(desfecho)}). Nada foi alterado no Omie.`);
  }
}

/** Desfecho de `pedido_edicao_omie_despachar` (a fronteira da 1ª mutação no Omie). `null` = despachado. */
export function recusaDoDespacho(desfecho: unknown): RecusaDaPosse | null {
  switch (desfecho) {
    case "despachado": return null;
    case "pedido_alterado":
    case "gemeo_alterado":
    case "excluido":
    case "ausente":
    case "perdeu_posse":
      return { bloqueio: "edicao_concorrente", motivo: MOTIVO_EDICAO_CONCORRENTE };
    default:
      throw new Error(`Edição recusada: resposta inesperada ao confirmar a reserva (${JSON.stringify(desfecho)}). Nada foi alterado no Omie.`);
  }
}

/** Desfechos de `sales_order_excluir_conferido` que dão mensagem própria (os demais: ver a edge). */
export function recusaDaExclusao(desfecho: unknown): string | null {
  switch (desfecho) {
    case "excluido":
    case "ausente":
      return null;
    case "edicao_em_curso":
      return "Exclusão recusada: este pedido está sendo salvo no Omie agora (edição em curso). Tente de novo em alguns minutos.";
    case "envio_em_curso":
      return "Exclusão recusada: o pedido está sendo enviado ao Omie agora. Tente de novo em alguns minutos.";
    case "nao_e_orcamento":
      return "Exclusão recusada: este registro não é mais um orçamento (virou pedido?). Recarregue a página.";
    case "pedido_alterado":
      return "Exclusão recusada: o pedido mudou (conta ou PV) depois da conferência. Recarregue a página.";
    default:
      return `Exclusão recusada: resposta inesperada ao apagar o pedido (${String(desfecho)}).`;
  }
}
