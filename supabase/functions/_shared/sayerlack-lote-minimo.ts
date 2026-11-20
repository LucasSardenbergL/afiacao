// Lote mínimo do portal Sayerlack — Fase 0 (money-path).
// Spec: docs/superpowers/specs/2026-11-18-sayerlack-lote-minimo-portal-design.md
//
// ⚠️ ESPELHO BYTE-IDÊNTICO em `supabase/functions/_shared/sayerlack-lote-minimo.ts` (o edge
// não importa de src/ — Deno). Paridade e guard de interpolação em
// `__tests__/sayerlack-lote-minimo.test.ts`. Sem imports de propósito: os dois caminhos
// relativos diferem e quebrariam a identidade de bytes. Arquivo separado de
// `sayerlack-pos-login.ts` para não mudar o bundle das outras 3 edges que importam aquele.

export interface LoteMinimoPortal {
  /** Lote mínimo de venda, em Qtd UN do portal (confirmado pelo founder, 2026-11-18). */
  lote: number;
  /** Trecho exato que casou — evidência para auditoria. */
  trecho: string;
}

export interface ContextoLoteMinimo {
  skuPortal: string | null;
  lote: number;
  qtdeEnviada: number | null;
  /** Fase 1: por que o robô NÃO subiu ao lote (ou não provou o ajuste). Ausente = Fase 0 (só recusa). */
  motivo?: string | null;
}

/**
 * Lê a recusa "Quantidade informada menor que o lote mínimo de venda (N)" nos textos
 * vistos após o salvar-item (corpo do POST + alertas do DOM). Puro, sem I/O.
 *
 * Roda em DOIS lugares: aqui (vitest) e no Chrome remoto, interpolada via toString()
 * dentro do template literal do Browserless — por isso o corpo NÃO pode ter crase nem
 * cifrão-chave (guard no teste).
 *
 * Ausente/ilegível → null (nunca um lote fabricado): sem número > 0 não é recusa provada.
 */
export function extrairLoteMinimoPortal(textos: Array<string | null | undefined>): LoteMinimoPortal | null {
  const re = /lote\s+m[ií]nimo\s+de\s+venda\s*\(\s*(\d+(?:[.,]\d+)?)\s*\)/i;
  for (let i = 0; i < textos.length; i++) {
    const t = textos[i];
    if (typeof t !== 'string' || t.length === 0) continue;
    const m = re.exec(t);
    if (!m) continue;
    const lote = Number(m[1].replace(',', '.'));
    if (!Number.isFinite(lote) || lote <= 0) continue;
    return { lote: lote, trecho: m[0] };
  }
  return null;
}

/**
 * Lado Deno: lê evidence.loteMinimo (vindo do Chrome remoto, logo NÃO confiável) e só
 * devolve o contexto se o lote for número finito > 0. Forma estranha → null (o alerta
 * sai com "nao capturado", nunca com número fabricado).
 */
export function lerLoteMinimoDaEvidencia(evidence: unknown): ContextoLoteMinimo | null {
  if (!evidence || typeof evidence !== 'object') return null;
  const lm = (evidence as Record<string, unknown>).loteMinimo;
  if (!lm || typeof lm !== 'object') return null;
  const o = lm as Record<string, unknown>;
  const lote = typeof o.lote === 'number' ? o.lote : NaN;
  if (!Number.isFinite(lote) || lote <= 0) return null;
  const qtde = typeof o.qtdeEnviada === 'number' && Number.isFinite(o.qtdeEnviada) ? o.qtdeEnviada : null;
  const sku = typeof o.skuPortal === 'string' && o.skuPortal.length > 0 ? o.skuPortal : null;
  const motivo = typeof o.motivo === 'string' && o.motivo.length > 0 ? o.motivo.substring(0, 60) : null;
  return { skuPortal: sku, lote: lote, qtdeEnviada: qtde, motivo: motivo };
}

/**
 * Texto do `fornecedor_alerta` para LOTE_MINIMO_PORTAL. Alerta na PRIMEIRA vez: retentar a
 * MESMA quantidade repete a recusa. É decisão de compra (comprar o lote, pedir redução ao
 * CRS ou tirar o item), não falha técnica — por isso 'atencao', não 'urgente'.
 */
export function decidirAlertaLoteMinimo(lm: ContextoLoteMinimo | null): {
  titulo: string;
  mensagem: string;
  severidade: 'urgente' | 'atencao';
} {
  const sku = lm && lm.skuPortal ? lm.skuPortal : '(SKU nao capturado)';
  const lote = lm ? String(lm.lote) : '(lote nao capturado)';
  const qtde = lm && lm.qtdeEnviada !== null ? String(lm.qtdeEnviada) : '?';
  return {
    titulo: 'Portal Sayerlack recusou item abaixo do lote minimo',
    mensagem:
      'O portal recusou o item ' + sku + ': lote minimo de venda ' + lote + ' UN, o pedido tinha ' +
      qtde + ' UN. Nenhum pedido foi colocado no fornecedor (o clique de finalizacao nunca ocorreu). ' +
      'O robo nao subiu ao lote automaticamente: ' + descreverMotivoLote(lm ? lm.motivo : null) + '. ' +
      'ACAO: conferir o item no portal e reenviar o pedido (spec 2026-11-18-sayerlack-lote-minimo-portal).',
    severidade: 'atencao',
  };
}

// ============================================================
// Fase 1 (revisada 2026-11-18): subir ao lote, efetivar e registrar a divergência.
// As 3 primeiras funções rodam TAMBÉM no Chrome remoto (interpoladas via toString() no template do
// Browserless): corpo sem crase nem cifrão-chave e SEM chamar outra função do módulo (guard no teste).
// ============================================================

export type MotivoLoteMinimo =
  | 'lote_nao_inteiro'
  | 'lote_nao_maior'
  | 'ja_ajustado'
  | 'recusa_apos_ajuste'
  | 'ajuste_nao_confirmado'
  | 'grade_divergente'
  | 'recusa_ambigua';

const MOTIVOS_LOTE: Record<string, string> = {
  lote_nao_inteiro: 'o lote lido nao e um inteiro de Qtd UN',
  lote_nao_maior: 'o lote lido nao e maior que a qtde enviada',
  ja_ajustado: 'o item ja tinha sido ajustado uma vez e foi recusado de novo',
  recusa_apos_ajuste: 'o portal recusou de novo depois de lancar o lote',
  ajuste_nao_confirmado: 'a linha nao confirmou a Qtd UN igual ao lote',
  grade_divergente: 'a grade antes do Efetivar nao bateu com o esperado',
  recusa_ambigua: 'a linha ficou aberta com um alerta de lote que nao da para atribuir ao item',
};

function descreverMotivoLote(motivo: string | null | undefined): string {
  if (!motivo) return 'recusa sem ajuste automatico';
  return MOTIVOS_LOTE[motivo] || ('motivo ' + motivo);
}

/**
 * Decide se o robô sobe o item recusado ao lote. Só com prova: lote inteiro seguro, maior que a qtde
 * enviada, e no máximo 1 ajuste por item (2ª recusa = aborta, nunca um 2º palpite). Puro.
 */
export function decidirAjusteLote(
  lote: number,
  qtdeEnviada: number,
  jaAjustado: boolean,
): { acao: 'ajustar'; lote: number } | { acao: 'abortar'; motivo: MotivoLoteMinimo } {
  if (jaAjustado) return { acao: 'abortar', motivo: 'ja_ajustado' };
  if (!Number.isSafeInteger(lote) || lote <= 0) return { acao: 'abortar', motivo: 'lote_nao_inteiro' };
  if (!Number.isSafeInteger(qtdeEnviada) || qtdeEnviada <= 0 || lote <= qtdeEnviada) {
    return { acao: 'abortar', motivo: 'lote_nao_maior' };
  }
  return { acao: 'ajustar', lote: lote };
}

export interface LinhaGradeProva {
  /** SKU identificado por token na linha ('' = não identificado). */
  sku_portal: string;
  /** Texto da célula Qtd UN (por cabeçalho) de linha CONFIRMADA; null se a célula tem editor. */
  qtd_un_texto: string | null;
  /** A linha tem input/select visível (modo edição = não gravada). */
  em_edicao: boolean;
}

/**
 * Prova da grade (o portal valida o lote no cliente e o POST do salvar-item não leva qtde: o texto do
 * alerta não prova nada, a GRADE prova). Exige: nº de linhas = nº de esperados; linha i ↔ item i pelo SKU;
 * nenhuma linha em edição; Qtd UN como TEXTO, inteiro estrito (sem separador: "1.000" é ambíguo → falha),
 * igual ao esperado. Qualquer furo → ok:false. Puro.
 */
export function provarGradeAjustada(
  linhas: LinhaGradeProva[] | null | undefined,
  esperados: Array<{ sku_portal: string; qtde: number }>,
): { ok: true } | { ok: false; motivo: string; linha: number | null } {
  if (!Array.isArray(linhas)) return { ok: false, motivo: 'sem_grade', linha: null };
  if (linhas.length !== esperados.length) return { ok: false, motivo: 'n_linhas', linha: null };
  for (let i = 0; i < esperados.length; i++) {
    const l = linhas[i];
    if (!l || l.em_edicao !== false) return { ok: false, motivo: 'linha_em_edicao', linha: i };
    const skuL = String(l.sku_portal || '').trim().toUpperCase();
    const skuE = String(esperados[i].sku_portal || '').trim().toUpperCase();
    if (!skuE || skuL !== skuE) return { ok: false, motivo: 'sku_divergente', linha: i };
    const txt = typeof l.qtd_un_texto === 'string' ? l.qtd_un_texto.trim() : '';
    if (!/^[0-9]{1,9}$/.test(txt)) return { ok: false, motivo: 'qtde_ilegivel', linha: i };
    if (Number(txt) !== esperados[i].qtde) return { ok: false, motivo: 'qtde_divergente', linha: i };
  }
  return { ok: true };
}

/**
 * Campos do payload do Efetivar (POST /order-creation/form/add, multipart ou urlencoded) cujo nome
 * parece item/quantidade — EVIDÊNCIA pós-clique para conciliar o que o portal recebeu (não decide nada).
 * Limitado a 200 pares × 80 chars. Puro.
 */
export function extrairCamposPayloadEfetivar(body: string | null | undefined): Array<[string, string]> {
  if (typeof body !== 'string' || body.length === 0) return [];
  const re = /qt|quant|it_codigo|item|seq/i;
  const out: Array<[string, string]> = [];
  if (body.indexOf('name="') !== -1) {
    const mp = /name="([^"]{1,120})"\r?\n\r?\n([^\r\n]*)/g;
    let m = mp.exec(body);
    while (m !== null && out.length < 200) {
      if (re.test(m[1])) out.push([m[1], m[2].substring(0, 80)]);
      m = mp.exec(body);
    }
    return out;
  }
  const partes = body.split('&');
  for (let i = 0; i < partes.length && out.length < 200; i++) {
    const kv = partes[i].split('=');
    let k = kv[0] || '';
    let v = kv.slice(1).join('=');
    try { k = decodeURIComponent(k.replace(/\+/g, ' ')); v = decodeURIComponent(v.replace(/\+/g, ' ')); } catch (e) { /* cru */ }
    if (re.test(k)) out.push([k.substring(0, 120), v.substring(0, 80)]);
  }
  return out;
}

export interface AjusteLote {
  idx: number;
  skuPortal: string;
  /** Qtd UN que ESTA execução enviou (a necessidade, já convertida para a unidade do portal). */
  qtdeOriginal: number;
  /** Qtd UN lançada = lote mínimo do portal. */
  lote: number;
}

/**
 * Lado Deno: lê evidence.ajustesLote (vindo do Chrome remoto → NÃO confiável) contra o que esta execução
 * ENVIOU. Só é válido o ajuste com idx no intervalo, SKU = item idx, qtdeOriginal = qtde enviada e lote
 * inteiro > qtdeOriginal, sem idx repetido. O resto conta em `invalidos` (o Deno alerta urgente e NÃO
 * grava ledger com número que não provou). Campo ausente = sem ajuste.
 */
export function lerAjustesLoteDaEvidencia(
  evidence: unknown,
  enviados: Array<{ sku_portal: string; qtde: number }>,
): { validos: AjusteLote[]; invalidos: number } {
  if (!evidence || typeof evidence !== 'object') return { validos: [], invalidos: 0 };
  const bruto = (evidence as Record<string, unknown>).ajustesLote;
  if (bruto === undefined || bruto === null) return { validos: [], invalidos: 0 };
  if (!Array.isArray(bruto)) return { validos: [], invalidos: 1 };
  const validos: AjusteLote[] = [];
  const vistos = new Set<number>();
  let invalidos = 0;
  for (const x of bruto) {
    const o = (x && typeof x === 'object') ? x as Record<string, unknown> : null;
    const idx = o && typeof o.idx === 'number' ? o.idx : NaN;
    const env = Number.isSafeInteger(idx) && idx >= 0 && idx < enviados.length ? enviados[idx] : null;
    const lote = o && typeof o.lote === 'number' ? o.lote : NaN;
    const qtdeOriginal = o && typeof o.qtdeOriginal === 'number' ? o.qtdeOriginal : NaN;
    const ok = !!env && !vistos.has(idx)
      && o !== null && o.skuPortal === env.sku_portal
      && qtdeOriginal === env.qtde
      && Number.isSafeInteger(lote) && lote > qtdeOriginal;
    if (!ok) { invalidos++; continue; }
    vistos.add(idx);
    validos.push({ idx: idx, skuPortal: env.sku_portal, qtdeOriginal: qtdeOriginal, lote: lote });
  }
  return { validos: validos, invalidos: invalidos };
}

/**
 * Alerta do pedido EFETIVADO com ajuste de lote. Com `emailAutomatico` (Fase 2a: protocolo + ledger provado +
 * sucesso_portal), o e-mail ao CRS sai sozinho pela edge `email-crs-ajuste-lote` e o alerta diz para NÃO enviar à
 * mão (dois responsáveis = dois e-mails). Sem ele, traz o texto pronto para o founder enviar. `ledgerGravado=false`
 * ou `invalidos>0` = divergência sem registro confiável → conferir no portal (e o Deno segura o PO, ver index.ts).
 */
export function decidirAlertaAjusteLote(p: {
  protocolo: string | null;
  ajustes: Array<{ skuPortal: string; qtdeOriginal: number; lote: number; descricao?: string | null }>;
  invalidos: number;
  ledgerGravado: boolean;
  emailAutomatico?: boolean;
}): { titulo: string; mensagem: string; severidade: 'urgente' | 'atencao' } {
  const proto = p.protocolo ? p.protocolo : '(SEM PROTOCOLO - conciliar)';
  const linhas = p.ajustes.map(function (a) {
    return a.skuPortal + (a.descricao ? ' (' + a.descricao + ')' : '') + ': lancado ' + a.lote +
      ' UN pelo lote minimo, precisamos de ' + a.qtdeOriginal + ' UN';
  });
  const automatico = p.emailAutomatico === true && !!p.protocolo && p.ledgerGravado && p.invalidos === 0;
  let msg = 'Pedido Sayerlack ' + proto + ' efetivado com ajuste de lote minimo. ' + linhas.join('; ') + '. ' +
    'O PO do Omie vai com a qtde REAL. ';
  if (automatico) {
    msg += 'O e-mail a crs@sayerlack.com.br pedindo a reducao SAI AUTOMATICAMENTE em ate 5 min - NAO envie a mao. ' +
      'Voce recebe o aviso "e-mail ao CRS enviado"; se ele nao chegar, o sistema alerta.';
  } else {
    msg += 'ACAO: enviar a crs@sayerlack.com.br, assunto "Alteracao de quantidade - Pedido ' +
      proto + '": "Bom dia, no pedido ' + proto + ' ' + linhas.join('; ') + '. Conseguem alterar para a quantidade ' +
      'que precisamos? Se nao for possivel, pedimos o cancelamento desse(s) item(ns)."';
  }
  if (!p.ledgerGravado) {
    msg += ' ATENCAO: o registro do ajuste NAO gravou no sistema; o pedido foi para conciliacao e o PO do Omie ' +
      'NAO foi criado automaticamente.';
  }
  if (p.invalidos > 0) {
    msg += ' ATENCAO: ' + p.invalidos + ' ajuste(s) com evidencia ilegivel - conferir as quantidades no portal.';
  }
  return {
    titulo: automatico
      ? 'Sayerlack: pedido efetivado acima da necessidade (lote minimo) - e-mail ao CRS automatico'
      : 'Sayerlack: pedido efetivado acima da necessidade (lote minimo) - pedir reducao ao CRS',
    mensagem: msg,
    severidade: 'urgente',
  };
}
