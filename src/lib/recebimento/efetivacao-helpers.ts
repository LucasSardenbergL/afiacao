/**
 * Helpers puros da efetivação de NF-e de recebimento (Fase A — closed-loop honesto).
 *
 * Oráculo testável (vitest) ESPELHADO VERBATIM no edge `omie-nfe-recebimento` (Deno).
 * O edge não importa de `src/` — qualquer mudança aqui precisa ser copiada lá.
 *
 * Princípios (metodologia Codex, 3 rodadas):
 * - Sucesso HTTP ≠ sucesso Omie: o Omie devolve HTTP 200 com `faultstring` em erro
 *   de negócio (padrão do repo: omie-sync / process-nfe fazem `if (faultstring) throw`).
 * - Passos NÃO-idempotentes até prova: o retry só roda o passo sem `ok`.
 * - "Já concluído"/"já na etapa" só viram sucesso benigno se a faultstring for conhecida.
 * - efetivado só com TODOS os passos obrigatórios ok; algum efeito + pendência = parcial.
 */

export interface OmieRespInput {
  /** `res.ok` do fetch (HTTP < 400). */
  httpOk: boolean;
  /** Status HTTP, se houver. */
  status?: number;
  /** Corpo já parseado (objeto/array/string/null) da resposta do Omie. */
  body: unknown;
}

export interface OmieClassificacao {
  sucesso: boolean;
  erro: string | null;
  /** `codigo_status`/`cCodStatus` do Omie, se presente (diagnóstico). */
  omieStatus: string | null;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * Decide se uma resposta do Omie é sucesso REAL (não só HTTP 200).
 * Falha quando: HTTP≥400, `faultstring` presente, ou `codigo_status`/`cCodStatus` ≠ "0".
 * Ausência de `codigo_status` NÃO é falha (muitos endpoints não retornam).
 */
export function classificarRespostaOmie(r: OmieRespInput): OmieClassificacao {
  const obj = asRecord(r.body);
  const faultstring = typeof obj.faultstring === 'string' ? obj.faultstring.trim() : '';
  const codRaw = obj.codigo_status ?? obj.cCodStatus;
  const omieStatus = codRaw == null ? null : String(codRaw).trim();
  const desc =
    (typeof obj.descricao_status === 'string' && obj.descricao_status.trim()) ||
    (typeof obj.cDescStatus === 'string' && obj.cDescStatus.trim()) ||
    '';

  if (!r.httpOk) {
    return { sucesso: false, erro: faultstring || `HTTP ${r.status ?? '???'}`, omieStatus };
  }
  if (faultstring) {
    return { sucesso: false, erro: faultstring, omieStatus };
  }
  if (omieStatus != null && omieStatus !== '' && omieStatus !== '0') {
    return { sucesso: false, erro: desc || `status ${omieStatus}`, omieStatus };
  }
  return { sucesso: true, erro: null, omieStatus };
}

/**
 * Allowlist conservadora de faultstrings benignas POR operação (Codex Q2/Q3):
 * "já concluído"/"já está na etapa"/"já efetivado" → o efeito JÁ existe no Omie,
 * então tratar como sucesso do passo. Qualquer string fora da allowlist = falha real.
 */
const BENIGNOS: Record<string, RegExp[]> = {
  alterar_etapa: [/j[áa]\s+est[áa]\s+(na|nesta|nessa)?\s*etapa/i, /mesma\s+etapa/i, /etapa\s+(atual|j[áa])/i],
  concluir_recebimento: [/j[áa]\s+(foi\s+)?conclu/i, /j[áa]\s+(foi\s+)?efetiv/i, /recebimento\s+conclu/i],
};

export function erroBenigno(faultstring: string | null | undefined, operacao: string): boolean {
  const fs = (faultstring ?? '').trim();
  if (!fs) return false;
  const pats = BENIGNOS[operacao];
  return pats ? pats.some((re) => re.test(fs)) : false;
}

export interface PassoFlags {
  alterarOk: boolean;
  etapaOk: boolean;
  concluirOk: boolean;
  /** Há CT-e a concluir nesta NF? Quando `false`, o CT-e não é passo obrigatório nem conta como efeito. */
  cteAplicavel: boolean;
  /** CT-e concluído (só relevante quando `cteAplicavel`). */
  cteOk: boolean;
  ajustesTentados: number;
  ajustesOk: number;
}

export type EfetivacaoStatus = 'efetivado' | 'falha_efetivacao' | 'efetivacao_parcial';

/**
 * Status final a partir das flags por passo.
 * `efetivado` só com todos os obrigatórios ok (alterar+etapa+concluir + CT-e se aplicável + ajustes completos);
 * nenhum efeito externo concretizado → `falha_efetivacao`; algum efeito + pendência → `efetivacao_parcial`.
 * CT-e não-aplicável NÃO conta como efeito (senão NF sem CT-e nunca cairia em `falha_efetivacao`).
 */
export function decidirStatusEfetivacao(f: PassoFlags): EfetivacaoStatus {
  const ajustesCompletos = f.ajustesOk >= f.ajustesTentados;
  const cteCompleto = !f.cteAplicavel || f.cteOk;
  const todosOk = f.alterarOk && f.etapaOk && f.concluirOk && cteCompleto && ajustesCompletos;
  if (todosOk) return 'efetivado';
  const algumEfeito = f.alterarOk || f.etapaOk || f.concluirOk || (f.cteAplicavel && f.cteOk) || f.ajustesOk > 0;
  return algumEfeito ? 'efetivacao_parcial' : 'falha_efetivacao';
}

export interface PassosOkFlags {
  alterarOk: boolean;
  etapaOk: boolean;
  concluirOk: boolean;
  cteAplicavel: boolean;
  cteOk: boolean;
}

/**
 * Passos de NF (não-item) a executar no retry — só os que ainda não têm `ok`.
 * O passo `cte` só entra se houver CT-e aplicável. Ajustes de estoque são por-item
 * (selecionados à parte por `ajuste_estoque_ok`).
 */
export function selecionarPassosPendentes(f: PassosOkFlags): string[] {
  const p: string[] = [];
  if (!f.alterarOk) p.push('alterar_recebimento');
  if (!f.etapaOk) p.push('alterar_etapa');
  if (!f.concluirOk) p.push('concluir_recebimento');
  if (f.cteAplicavel && !f.cteOk) p.push('cte');
  return p;
}

export function podeReprocessar(status: string): boolean {
  return status === 'falha_efetivacao' || status === 'efetivacao_parcial';
}

/** Concatena erros por operação num resumo truncado pra caber em `efetivacao_erro`. */
export function resumirErros(falhas: { operacao: string; erro: string }[], max = 500): string {
  const txt = falhas.map((f) => `${f.operacao}: ${f.erro}`).join(' | ');
  if (txt.length <= max) return txt;
  return txt.slice(0, Math.max(0, max - 1)) + '…';
}

// ════════════════════════════════════════════════════════════════════════════
// PR2 (A1 — coreografia de escrita): consultar-antes → reconciliar | escrever
// Espelhado VERBATIM no edge. Money-path: o Omie é a fonte da verdade, o ledger é
// auditoria. Furos do Codex (v2): identidade por chave, bifurcação tríplice
// (cEtapa=80 sem cRecebido=S é INCONSISTENTE), reconsulta valida quantidade+produto,
// cruzamento item-a-item app×Omie, gate de conversão pelo fator do Omie.
// ════════════════════════════════════════════════════════════════════════════

/** Item parseado do `ConsultarRecebimento` (`itensRecebimento[]`). */
export interface ItemOmie {
  nSequencia: number;
  nIdProduto: number | null;
  cCodigoProduto: string | null;
  nQtdeNFe: number;
  nQtdeRecebida: number | null;
  cUnidadeNfe: string | null;
  cIgnorarItem: boolean;
  /** Fator de conversão consolidado de todas as fontes (cabec/ajustes/subobjetos, ambas grafias); ≠1 = conversão. */
  nFatorConversao: number | null;
}

/** Item conferido no app (`nfe_recebimento_itens`). */
export interface ItemApp {
  sequencia: number;
  produto_omie_id: number | null;
  quantidade_conferida: number;
  quantidade_convertida: number | null;
  status_item: string;
  unidade_nfe: string | null;
  unidade_estoque: string | null;
}

/** Payload de edição do `AlterarRecebimento` (sem produto — o Omie casa por sequência). */
export interface ItemEditar {
  itensIde: { nSequencia: number; cAcao: 'EDITAR' };
  itensAjustes: { nQtdeRecebida: number };
}

/** O que pretendemos gravar, com o produto — pra a reconsulta confirmar (o `ItemEditar` não carrega produto). */
export interface ItemPretendido {
  nSequencia: number;
  nIdProduto: number | null;
  nQtdeRecebida: number;
}

export interface EstadoConsulta {
  cRecebido: string | null;
  cEtapa: string | null;
  nIdReceb: number | null;
  cChaveNfe: string | null;
  itensOmie: ItemOmie[];
}

function asNum(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function asStr(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

/** Primeiro fator ≠1 entre os candidatos; senão 1 se algum=1; senão null (sem informação). */
function fatorEfetivo(candidatos: unknown[]): number | null {
  const nums = candidatos.map(asNum).filter((n): n is number => n != null && n > 0);
  if (nums.length === 0) return null;
  const naoUm = nums.find((n) => Math.abs(n - 1) > 1e-9);
  return naoUm != null ? naoUm : 1;
}

function parseItemOmie(raw: unknown): ItemOmie {
  const it = asRecord(raw);
  const itc = asRecord(it.itensCabec);
  const aj = asRecord(it.itensAjustes);
  const conv = asRecord(it.itensConversao);
  const nfe = asRecord(it.itensNfe);
  return {
    nSequencia: asNum(itc.nSequencia) ?? 0,
    nIdProduto: asNum(itc.nIdProduto),
    cCodigoProduto: asStr(itc.cCodigoProduto),
    nQtdeNFe: asNum(itc.nQtdeNFe) ?? 0,
    nQtdeRecebida: asNum(aj.nQtdeRecebida),
    cUnidadeNfe: asStr(itc.cUnidadeNfe) ?? asStr(aj.cUnidade),
    cIgnorarItem: asStr(itc.cIgnorarItem) === 'S',
    nFatorConversao: fatorEfetivo([
      itc.nFatorConversao, itc.nFatorConv, aj.nFatorConversao, aj.nFatorConv, conv.nFatorConversao, nfe.nFatorConversao,
    ]),
  };
}

/** Parse robusto do `ConsultarRecebimento`. Body não-objeto → defaults vazios (sem fabricar campos). */
export function extrairEstadoConsulta(body: unknown): EstadoConsulta {
  const obj = asRecord(body);
  const cabec = asRecord(obj.cabec);
  const infoCadastro = asRecord(obj.infoCadastro);
  const itensRaw = Array.isArray(obj.itensRecebimento) ? obj.itensRecebimento : [];
  return {
    cRecebido: asStr(infoCadastro.cRecebido),
    cEtapa: asStr(cabec.cEtapa),
    nIdReceb: asNum(cabec.nIdReceb),
    cChaveNfe: asStr(cabec.cChaveNfe),
    itensOmie: itensRaw.map(parseItemOmie),
  };
}

/**
 * Identidade da NF (Codex P1.1): a consulta É feita com `{nIdReceb, cChaveNfe}` (a chave do banco
 * como filtro do Omie). Exige `cabec.nIdReceb` presente e batendo; se o Omie ecoar `cChaveNfe`,
 * exige bater também (defesa em profundidade — chave ausente já foi filtro na consulta).
 */
export function validarIdentidade(
  estado: EstadoConsulta,
  esperado: { nIdReceb: number; chaveAcesso: string },
): { ok: boolean; erro: string | null } {
  if (estado.nIdReceb == null) return { ok: false, erro: 'consulta do Omie sem nIdReceb' };
  if (estado.nIdReceb !== esperado.nIdReceb) {
    return { ok: false, erro: `nIdReceb diverge (Omie ${estado.nIdReceb} ≠ app ${esperado.nIdReceb})` };
  }
  if (estado.cChaveNfe != null && estado.cChaveNfe !== esperado.chaveAcesso) {
    return { ok: false, erro: 'chave de acesso diverge entre Omie e app' };
  }
  return { ok: true, erro: null };
}

/**
 * Bifurcação tríplice (Codex P1.2): `cRecebido=S` é o ÚNICO sinal pra reconciliar (não escrever);
 * `cEtapa=80` sem `cRecebido=S` é estado INCONSISTENTE (recebido-parcial/lag) — não escreve, não
 * reconcilia; senão escreve.
 */
export function decidirAcaoRecebimento(estado: EstadoConsulta): 'reconciliar' | 'escrever' | 'inconsistente' {
  const rec = (estado.cRecebido ?? '').trim().toUpperCase();
  const etapa = (estado.cEtapa ?? '').trim();
  if (rec === 'S') return 'reconciliar';
  if (etapa === '80') return 'inconsistente';
  return 'escrever';
}

function normUnidade(u: string | null): string {
  return (u ?? '').trim().toUpperCase();
}

/**
 * Gate de conversão FORTE (Codex P1.5): bloqueia se QUALQUER sinal — fator≠1 no Omie (qualquer fonte),
 * `quantidade_convertida` preenchida no app, ou unidade da NF ≠ unidade de estoque. Falso-positivo
 * bloqueia (fail-safe), nunca escreve quantidade/unidade errada.
 */
export function detectarConversao(itensOmie: ItemOmie[], itensApp: ItemApp[]): { temConversao: boolean; motivo: string | null } {
  if (itensOmie.some((i) => i.nFatorConversao != null && Math.abs(i.nFatorConversao - 1) > 1e-9)) {
    return { temConversao: true, motivo: 'fator de conversão ≠ 1 no Omie' };
  }
  if (itensApp.some((i) => i.quantidade_convertida != null)) {
    return { temConversao: true, motivo: 'quantidade convertida preenchida no app' };
  }
  if (itensApp.some((i) => i.unidade_estoque != null && i.unidade_nfe != null && normUnidade(i.unidade_nfe) !== normUnidade(i.unidade_estoque))) {
    return { temConversao: true, motivo: 'unidade da NF ≠ unidade de estoque' };
  }
  return { temConversao: false, motivo: null };
}

/**
 * Cruza os itens do app (conferidos) com o mapa do `ConsultarRecebimento` (Codex P1.4): casa por
 * `nSequencia` E `produto_omie_id === nIdProduto`; omite itens Omie `cIgnorarItem`; exige todos os
 * itens app conferidos, qtd finita ≥0, produto associado; contagem app == Omie (não-ignorados).
 */
export function cruzarItensParaEscrita(
  itensOmie: ItemOmie[],
  itensApp: ItemApp[],
): { ok: boolean; erro: string | null; itensEditar: ItemEditar[]; pretendidos: ItemPretendido[] } {
  const vazio = { itensEditar: [] as ItemEditar[], pretendidos: [] as ItemPretendido[] };
  const omieAtivos = itensOmie.filter((i) => !i.cIgnorarItem);
  const omieBySeq = new Map<number, ItemOmie>(omieAtivos.map((i) => [i.nSequencia, i]));
  if (itensApp.length !== omieAtivos.length) {
    return { ok: false, erro: `contagem de itens diverge (app ${itensApp.length} ≠ Omie ${omieAtivos.length})`, ...vazio };
  }
  const editar: ItemEditar[] = [];
  const pretendidos: ItemPretendido[] = [];
  for (const app of itensApp) {
    if (app.status_item !== 'conferido') {
      return { ok: false, erro: `item seq ${app.sequencia} não conferido (status ${app.status_item})`, ...vazio };
    }
    if (!Number.isFinite(app.quantidade_conferida) || app.quantidade_conferida < 0) {
      return { ok: false, erro: `item seq ${app.sequencia} com quantidade conferida inválida`, ...vazio };
    }
    if (app.produto_omie_id == null) {
      return { ok: false, erro: `item seq ${app.sequencia} sem produto associado no app`, ...vazio };
    }
    const omie = omieBySeq.get(app.sequencia);
    if (!omie) return { ok: false, erro: `item seq ${app.sequencia} sem par no Omie`, ...vazio };
    if (omie.nIdProduto == null || omie.nIdProduto !== app.produto_omie_id) {
      return { ok: false, erro: `produto diverge na seq ${app.sequencia} (app ${app.produto_omie_id} ≠ Omie ${omie.nIdProduto})`, ...vazio };
    }
    editar.push({ itensIde: { nSequencia: app.sequencia, cAcao: 'EDITAR' }, itensAjustes: { nQtdeRecebida: app.quantidade_conferida } });
    pretendidos.push({ nSequencia: app.sequencia, nIdProduto: app.produto_omie_id, nQtdeRecebida: app.quantidade_conferida });
  }
  editar.sort((a, b) => a.itensIde.nSequencia - b.itensIde.nSequencia);
  pretendidos.sort((a, b) => a.nSequencia - b.nSequencia);
  return { ok: true, erro: null, itensEditar: editar, pretendidos };
}

/** Gate puro de pré-condições de escrita (status conferido, sem lote escaneado, sem conversão). */
export function validarGatesEscrita(input: {
  statusApp: string;
  temLoteEscaneado: boolean;
  temConversao: boolean;
  motivoConversao: string | null;
}): { ok: boolean; erro: string | null } {
  if (input.statusApp !== 'conferido') {
    return { ok: false, erro: `status "${input.statusApp}" — confira a NF no app antes de efetivar` };
  }
  if (input.temLoteEscaneado) {
    return { ok: false, erro: 'NF com lote/validade escaneado — fluxo de lote não automatizado (follow-up)' };
  }
  if (input.temConversao) {
    return { ok: false, erro: input.motivoConversao ?? 'NF com conversão de unidade — não automatizado (follow-up)' };
  }
  return { ok: true, erro: null };
}

/**
 * Reconsulta como juiz final do `efetivado` (Codex P1.3): valida `cRecebido=S` + chave + por item
 * `nSequencia` presente + `nIdProduto` + `nQtdeRecebida === pretendido`. Qualquer divergência →
 * não confirmado (vira `efetivacao_parcial`).
 */
export function confirmarEfetivacao(
  estadoReconsulta: EstadoConsulta,
  esperado: { chaveAcesso: string; pretendidos: ItemPretendido[] },
): { confirmado: boolean; divergencias: string[] } {
  const div: string[] = [];
  const rec = (estadoReconsulta.cRecebido ?? '').trim().toUpperCase();
  if (rec !== 'S') div.push('cRecebido ≠ S no Omie após a conclusão');
  if (estadoReconsulta.cChaveNfe != null && estadoReconsulta.cChaveNfe !== esperado.chaveAcesso) {
    div.push('chave de acesso diverge na reconsulta');
  }
  const omieBySeq = new Map<number, ItemOmie>(estadoReconsulta.itensOmie.map((i) => [i.nSequencia, i]));
  for (const p of esperado.pretendidos) {
    const o = omieBySeq.get(p.nSequencia);
    if (!o) {
      div.push(`seq ${p.nSequencia}: ausente na reconsulta`);
      continue;
    }
    if (o.nIdProduto !== p.nIdProduto) {
      div.push(`seq ${p.nSequencia}: produto ${o.nIdProduto} ≠ ${p.nIdProduto}`);
    }
    if (asNum(o.nQtdeRecebida) !== asNum(p.nQtdeRecebida)) {
      div.push(`seq ${p.nSequencia}: qtd recebida ${o.nQtdeRecebida} ≠ ${p.nQtdeRecebida}`);
    }
  }
  return { confirmado: div.length === 0, divergencias: div };
}

/** Status base por passo, rebaixado pra parcial se a reconsulta NÃO confirmou o recebimento. */
export function decidirStatusComConfirmacao(flags: PassoFlags, recebidoConfirmado: boolean): EfetivacaoStatus {
  const s = decidirStatusEfetivacao(flags);
  if (s === 'efetivado' && !recebidoConfirmado) return 'efetivacao_parcial';
  return s;
}

// ── Reconciliação em lote (varredura automática, reconcile-only) ──

export type EfeitoReconcile =
  | { efeito: 'reconciliar' }
  | { efeito: 'pular'; motivo: 'consulta_falhou' | 'cancelada' | 'identidade_divergente' | 'aguardando_conferencia' | 'inconsistente' };

/**
 * Política da varredura automática sobre NF 'pendente': SÓ reconcilia (cRecebido=S no
 * Omie → marca efetivado no app, read-only no Omie). Qualquer outro caminho PULA sem
 * tocar o status — a varredura nunca escreve no Omie nem pinta falha no painel; falha
 * visível é reservada à ação humana (Efetivar/Reprocessar). Fail-closed além do fluxo
 * manual (Codex, design review 2026-07-14): NF cancelada no Omie nunca reconcilia
 * (recebida-e-depois-cancelada viraria entrada fantasma) e a varredura EXIGE a chave
 * de acesso na resposta (o fluxo manual tolera chave ausente; automático, não).
 */
export function decidirEfeitoReconcileLote(
  cls: OmieClassificacao,
  body: unknown,
  esperado: { nIdReceb: number; chaveAcesso: string },
): EfeitoReconcile {
  if (!cls.sucesso) return { efeito: 'pular', motivo: 'consulta_falhou' };
  const cancelada = asRecord(asRecord(body).infoCadastro).cCancelada;
  if (typeof cancelada === 'string' && cancelada.trim().toUpperCase() === 'S') {
    return { efeito: 'pular', motivo: 'cancelada' };
  }
  const estado = extrairEstadoConsulta(body);
  if (estado.cChaveNfe == null) return { efeito: 'pular', motivo: 'identidade_divergente' };
  if (!validarIdentidade(estado, esperado).ok) return { efeito: 'pular', motivo: 'identidade_divergente' };
  const acao = decidirAcaoRecebimento(estado);
  if (acao === 'reconciliar') return { efeito: 'reconciliar' };
  if (acao === 'inconsistente') return { efeito: 'pular', motivo: 'inconsistente' };
  return { efeito: 'pular', motivo: 'aguardando_conferencia' };
}

export interface ResumoReconcileLote {
  processadas: number;
  reconciliadas: number;
  puladas: { consulta_falhou: number; cancelada: number; identidade_divergente: number; aguardando_conferencia: number; inconsistente: number };
}

export function resumirReconcileLote(efeitos: EfeitoReconcile[]): ResumoReconcileLote {
  const resumo: ResumoReconcileLote = {
    processadas: efeitos.length,
    reconciliadas: 0,
    puladas: { consulta_falhou: 0, cancelada: 0, identidade_divergente: 0, aguardando_conferencia: 0, inconsistente: 0 },
  };
  for (const e of efeitos) {
    if (e.efeito === 'reconciliar') resumo.reconciliadas++;
    else resumo.puladas[e.motivo]++;
  }
  return resumo;
}

// ════════════════════════════════════════════════════════════════════════════
// v3 (2026-07-16): a trava anti-redundância do Omie é por MÉTODO+conta (provado
// em prod: params distintos a 4s → REDUNDANT; lote de 15 nIdReceb com trégua
// 1.1s → 15/15 REDUNDANT em 3 rodadas, escalando pra bloqueio de 30min). A
// varredura vira listagem-DIRETA: 1 ListarRecebimentos por conta (método sem a
// trava de rajada) + identidade FORTE (id + chave 44 idêntica) direto da página —
// zero ConsultarRecebimento. Espelhado verbatim na edge omie-nfe-reconcile.
// ════════════════════════════════════════════════════════════════════════════

/** A trava do Omie: re-tentar renova o timer — retry PRECISA parar neste erro. */
export function ehErroRedundante(erro: string | null | undefined): boolean {
  if (!erro) return false;
  return /redundant|redundante/i.test(erro);
}

export interface EstadoListagem {
  recebido: boolean;
  cancelada: boolean;
  /** cChaveNfe/cChaveNFe do cabec da listagem (identidade forte), quando presente. */
  chave: string | null;
  /** nIdReceb apareceu mais de uma vez na listagem → fail-closed no cruzamento. */
  duplicado: boolean;
}

/**
 * Extrai de páginas do ListarRecebimentos o mapa nIdReceb → {recebido, cancelada, chave}.
 * Parse defensivo: nIdReceb no cabec OU na raiz, string ou number; chave em ambas as
 * grafias (cChaveNfe/cChaveNFe); página malformada é ignorada (nunca lança — a decisão
 * fail-closed acontece no cruzamento). nIdReceb repetido → marcado `duplicado`.
 */
export function extrairRecebidosDaListagem(paginas: unknown[]): Map<number, EstadoListagem> {
  const mapa = new Map<number, EstadoListagem>();
  for (const pagina of paginas) {
    const recs = asRecord(pagina).recebimentos;
    if (!Array.isArray(recs)) continue;
    for (const raw of recs) {
      const rec = asRecord(raw);
      const cabec = asRecord(rec.cabec);
      const id = Number(cabec.nIdReceb ?? rec.nIdReceb);
      if (!Number.isFinite(id) || id <= 0) continue;
      const info = asRecord(rec.infoCadastro);
      const chaveRaw = cabec.cChaveNfe ?? cabec.cChaveNFe;
      const estado: EstadoListagem = {
        recebido: String(info.cRecebido ?? '').trim().toUpperCase() === 'S',
        cancelada: String(info.cCancelada ?? '').trim().toUpperCase() === 'S',
        chave: typeof chaveRaw === 'string' && chaveRaw.trim() !== '' ? chaveRaw.trim() : null,
        duplicado: false,
      };
      if (mapa.has(id)) {
        estado.duplicado = true;
        const prev = mapa.get(id)!;
        mapa.set(id, { ...prev, duplicado: true });
        continue;
      }
      mapa.set(id, estado);
    }
  }
  return mapa;
}

export interface PendenteReconcile {
  id: string;
  omie_id_receb: number | null;
  chave_acesso: string | null;
}

export interface SelecaoCandidatas<T extends PendenteReconcile> {
  /** Correspondências FORTES (id + chave 44 iguais, recebida, não-cancelada, sem duplicata) — reconciliáveis direto. */
  candidatas: T[];
  foraDaListagem: number;
  naoRecebidas: number;
  canceladas: number;
  /** Sem chave em um dos lados, chave inválida (≠44 dígitos) ou divergente — fail-closed. */
  identidadeFraca: number;
  /** nIdReceb duplicado na listagem OU repetido entre as pendentes do app (sem UNIQUE no banco). */
  duplicadas: number;
}

/**
 * Cruza as pendentes do app com o mapa da listagem usando IDENTIDADE FORTE (Codex v2 P1):
 * reconciliável direto da listagem SOMENTE quando (nIdReceb igual) E (chave de acesso
 * presente nos DOIS lados, com 44 dígitos, idêntica) E (cRecebido=S) E (não cancelada)
 * E (cardinalidade 1:1 — sem duplicata na listagem nem entre as pendentes).
 * Qualquer identidade em dúvida → contador, nunca candidata. `cap` limita o lote.
 * A ordem de `pendentes` é preservada (chame com mais antigas primeiro).
 */
export function selecionarCandidatasReconcile<T extends PendenteReconcile>(
  pendentes: T[],
  listagem: Map<number, EstadoListagem>,
  cap: number,
): SelecaoCandidatas<T> {
  const sel: SelecaoCandidatas<T> = {
    candidatas: [], foraDaListagem: 0, naoRecebidas: 0, canceladas: 0, identidadeFraca: 0, duplicadas: 0,
  };
  const idsRepetidos = new Set<number>();
  const vistos = new Set<number>();
  for (const p of pendentes) {
    const id = Number(p.omie_id_receb);
    if (!Number.isFinite(id) || id <= 0) continue;
    if (vistos.has(id)) idsRepetidos.add(id);
    vistos.add(id);
  }
  for (const p of pendentes) {
    const id = Number(p.omie_id_receb);
    if (!Number.isFinite(id) || id <= 0) continue;
    if (idsRepetidos.has(id)) { sel.duplicadas++; continue; }
    const estado = listagem.get(id);
    if (!estado) { sel.foraDaListagem++; continue; }
    if (estado.duplicado) { sel.duplicadas++; continue; }
    if (estado.cancelada) { sel.canceladas++; continue; }
    if (!estado.recebido) { sel.naoRecebidas++; continue; }
    const chaveApp = (p.chave_acesso ?? '').trim();
    if (chaveApp.length !== 44 || estado.chave == null || estado.chave !== chaveApp) {
      sel.identidadeFraca++;
      continue;
    }
    if (sel.candidatas.length < cap) sel.candidatas.push(p);
  }
  return sel;
}

// ── v3.1 (2026-07-16): cobertura da listagem por janelas de emissão consecutivas ──
// A 1ª rodada v3 em prod provou o transporte (zero REDUNDANT) mas cobriu pouco:
// janela única de 60d ancorada na pendente mais antiga (janeiro) deixou 15 de 24
// pendentes "fora_da_listagem" (emissões mar–mai). Este helper gera janelas
// DISJUNTAS e consecutivas da mais antiga até hoje (ou até a maior emissão
// registrada — dados sujos do Omie têm emissão futura), com cap de chamadas.

export interface JanelaEmissao { de: Date; ate: Date }

function parseEmissao(iso: string | null): Date | null {
  if (!iso) return null;
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * Janelas de emissão para o ListarRecebimentos: [emissãoMin - margem, +largura],
 * consecutivas e DISJUNTAS (de_{k+1} = ate_k + 1d — sobreposição faria a mesma NF
 * aparecer em 2 páginas e cair no fail-closed de duplicata), até alcançar
 * max(agora, emissãoMax) + 1d, com no máximo `maxJanelas` (cap de chamadas ao Omie
 * por conta por rodada). Âncora muito antiga → cobertura parcial honesta: o
 * chamador reporta `truncada` e a cobertura avança quando as antigas resolverem.
 * Datas inválidas/ausentes caem no fallback (agora - fallbackDias). Determinístico
 * (recebe `agora`); dias em UTC puro.
 */
export function janelasEmissaoConsecutivas(
  emissaoMinIso: string | null,
  emissaoMaxIso: string | null,
  agora: Date,
  opts?: { margemDias?: number; larguraDias?: number; maxJanelas?: number; fallbackDias?: number },
): JanelaEmissao[] {
  const DIA = 86_400_000;
  const margem = (opts?.margemDias ?? 7) * DIA;
  const largura = (opts?.larguraDias ?? 60) * DIA;
  const max = opts?.maxJanelas ?? 4;
  const fallback = (opts?.fallbackDias ?? 210) * DIA;

  const min = parseEmissao(emissaoMinIso);
  const maxEmissao = parseEmissao(emissaoMaxIso);
  const base = min ? new Date(min.getTime() - margem) : new Date(agora.getTime() - fallback);
  const alvo = new Date(Math.max(agora.getTime(), maxEmissao?.getTime() ?? 0) + DIA);

  const janelas: JanelaEmissao[] = [];
  let de = base;
  while (janelas.length < max) {
    const ate = new Date(de.getTime() + largura);
    janelas.push({ de, ate });
    if (ate.getTime() >= alvo.getTime()) break;
    de = new Date(ate.getTime() + DIA);
  }
  return janelas;
}
