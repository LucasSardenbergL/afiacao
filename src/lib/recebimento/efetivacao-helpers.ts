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
