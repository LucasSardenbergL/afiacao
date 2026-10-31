/**
 * Dono temporário do lead ("em atendimento por X") e aviso de telefone compartilhado — parsers estritos das RPCs
 * da migration 20261029201200 e o texto que a tela mostra. Forma inesperada LANÇA (vira erro de leitura), nunca
 * "sem dono": um lead que parece livre e não está é o retrabalho que o recurso existe para evitar.
 */

/** O PostgREST corta em 1.000 linhas calado; o servidor limita a 100 posses por dono. Bater no teto é ERRO. */
export const TETO_LEITURA_ATENDIMENTOS = 1000;

export interface AtendimentoAtivo {
  cnpj: string;
  donoUserId: string;
  donoNome: string | null;
  assumidoEm: string;
  expiraEm: string;
  ehMeu: boolean;
}

export type ResultadoAtendimento =
  | { ok: true; renovado: boolean; jaLivre: boolean; expiraEm: string | null }
  | { ok: false; motivo: 'em_atendimento' | 'nao_e_dono'; donoNome: string | null; expiraEm: string | null }
  | { ok: false; motivo: 'ja_cliente' }
  | { ok: false; motivo: 'limite'; limite: number };

const ehObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const texto = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const textoOuNulo = (v: unknown): v is string | null => v === null || v === undefined || typeof v === 'string';

function forma(fonte: string, esperado: string): never {
  throw new Error(`${fonte}: resposta fora da forma esperada (${esperado})`);
}

export function lerAtendimentosAtivos(data: unknown, fonte: string): Map<string, AtendimentoAtivo> {
  if (!Array.isArray(data)) forma(fonte, 'lista');
  if (data.length >= TETO_LEITURA_ATENDIMENTOS) {
    throw new Error(`${fonte}: ${data.length} linhas — no teto da leitura; a lista pode estar cortada`);
  }
  const m = new Map<string, AtendimentoAtivo>();
  for (const l of data) {
    if (!ehObj(l) || !texto(l.cnpj) || !texto(l.dono_user_id) || !texto(l.assumido_em) || !texto(l.expira_em)
      || typeof l.eh_meu !== 'boolean' || !textoOuNulo(l.dono_nome)) {
      forma(fonte, '{cnpj, dono_user_id, dono_nome, assumido_em, expira_em, eh_meu}');
    }
    m.set(l.cnpj, {
      cnpj: l.cnpj, donoUserId: l.dono_user_id, donoNome: (l.dono_nome as string | null | undefined) ?? null,
      assumidoEm: l.assumido_em, expiraEm: l.expira_em, ehMeu: l.eh_meu,
    });
  }
  return m;
}

export function lerResultadoAtendimento(v: unknown, fonte: string): ResultadoAtendimento {
  if (!ehObj(v) || typeof v.ok !== 'boolean') forma(fonte, '{ok, …}');
  const expira = textoOuNulo(v.expira_em) ? ((v.expira_em as string | null | undefined) ?? null) : forma(fonte, 'expira_em');
  if (v.ok) {
    return { ok: true, renovado: v.renovado === true, jaLivre: v.ja_livre === true, expiraEm: expira };
  }
  switch (v.motivo) {
    case 'em_atendimento':
    case 'nao_e_dono':
      if (!textoOuNulo(v.dono_nome)) forma(fonte, 'dono_nome');
      return { ok: false, motivo: v.motivo, donoNome: (v.dono_nome as string | null | undefined) ?? null, expiraEm: expira };
    case 'ja_cliente':
      return { ok: false, motivo: 'ja_cliente' };
    case 'limite':
      if (typeof v.limite !== 'number') forma(fonte, 'limite');
      return { ok: false, motivo: 'limite', limite: v.limite };
    default:
      return forma(fonte, 'motivo conhecido');
  }
}

/** "dd/mm" no fuso de São Paulo (a data que o vendedor lê). */
export function diaMes(iso: string): string {
  return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' });
}

/** Texto do chip na lista e na ficha. */
export function rotuloAtendimento(a: AtendimentoAtivo): string {
  if (a.ehMeu) return `com você até ${diaMes(a.expiraEm)}`;
  return `em atendimento por ${a.donoNome ?? 'outro vendedor'} até ${diaMes(a.expiraEm)}`;
}

/** Mensagem do toast quando assumir/liberar não aconteceu. */
export function mensagemRecusa(r: Exclude<ResultadoAtendimento, { ok: true }>): string {
  switch (r.motivo) {
    case 'em_atendimento':
      return `Já está em atendimento por ${r.donoNome ?? 'outro vendedor'}${r.expiraEm ? ` até ${diaMes(r.expiraEm)}` : ''}`;
    case 'nao_e_dono':
      return `Só ${r.donoNome ?? 'o dono'} ou um gestor pode liberar este lead`;
    case 'ja_cliente':
      return 'Esta empresa já é cliente: não há o que prospectar';
    case 'limite':
      return `Você já tem ${r.limite} leads em atendimento. Libere algum antes de assumir outro`;
  }
}

/**
 * Aviso de telefone compartilhado: "este número aparece em N empresas de raízes diferentes". É AVISO (contador,
 * central de escritório, telefone de contabilidade), nunca classificação de número inválido.
 */
export function avisoTelefoneCompartilhado(outrasRaizes: number): string | null {
  if (!Number.isInteger(outrasRaizes) || outrasRaizes < 1) return null;
  return outrasRaizes === 1
    ? 'Este número também aparece em 1 empresa de outra raiz de CNPJ'
    : `Este número aparece em ${outrasRaizes} empresas de raízes diferentes`;
}

const CHAVE_MODO_DISCAGEM = 'radar.modo_discagem';

/** Modo discagem ligado neste navegador? Preferência de conveniência: sem storage, o modo só não lembra. */
export function lerModoDiscagem(): boolean {
  try { return localStorage.getItem(CHAVE_MODO_DISCAGEM) === '1'; } catch { return false; }
}
export function gravarModoDiscagem(v: boolean): void {
  try { localStorage.setItem(CHAVE_MODO_DISCAGEM, v ? '1' : '0'); } catch { /* sem storage: só não persiste */ }
}
