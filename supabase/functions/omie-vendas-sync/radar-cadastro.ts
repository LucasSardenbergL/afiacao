// Cadastro de lead do Radar no ERP pela action `criar_cliente` (revisão do Radar 2026-11-11, itens 5 e 7).
//
// Item 5 — ELEGIBILIDADE NO SERVIDOR. O cadastro em LOTE do gestor ia direto ao Omie com a linha da lista como
// snapshot, sem a releitura que a ficha faz (RFB não ativa, já cliente/vinculado, descartado). A checagem mora aqui,
// na edge, no ÚNICO ponto que todo caminho atravessa, e entre o lookup estrito e o IncluirCliente (parecer Codex
// 2026-11-12, P1): o lookup que ACHA o cliente reconcilia sempre (recuperação de cadastro cuja resposta se perdeu,
// mesmo que o lead tenha mudado depois); só a CRIAÇÃO de um cliente novo exige o lead elegível agora. Só liga quando
// o payload traz `radar` (o Radar manda; os outros usos da action seguem como estavam). Leitura que falha LANÇA:
// indeterminado, nunca "elegível".
//
// Item 7 — e-mail e complemento da Receita vão ao IncluirCliente (`clientes_cadastro.email`, ≤ 500;
// `.complemento`, ≤ 60). Inválido ou longo demais é OMITIDO: um campo opcional não derruba o cadastro, e o ERP nunca
// recebe dado truncado.

export interface LinhaRadarCadastro {
  ja_cliente: boolean | null;
  omie_codigo_cliente: string | null;
  rfb_situacao: string | null;
  prospeccao_status: string | null;
}

export type MotivoInelegivelRadar =
  | "lead_inexistente" | "ja_cliente" | "ja_vinculado_omie" | "rfb_nao_ativa" | "descartado" | "nao_em_conversa";

export interface ExigenciaRadar {
  /** A ficha do vendedor cadastra quem está EM CONVERSA; o lote do gestor não exige (cadastro antecipado). */
  exigirEmConversa: boolean;
}

/** Situação cadastral ATIVA na Receita (a mesma constante do front, `RFB_ATIVA`). */
const RFB_ATIVA = "02";

export function motivoInelegivelRadar(l: LinhaRadarCadastro | null, ex: ExigenciaRadar): MotivoInelegivelRadar | null {
  if (!l) return "lead_inexistente";
  if (l.ja_cliente) return "ja_cliente";
  // `!= null` (não truthiness): a mesma regra de `cadastravelNoOmie` — '' cai do lado do vínculo.
  if (l.omie_codigo_cliente != null) return "ja_vinculado_omie";
  if (l.rfb_situacao != null && l.rfb_situacao !== RFB_ATIVA) return "rfb_nao_ativa";
  if (l.prospeccao_status === "descartado") return "descartado";
  if (ex.exigirEmConversa && l.prospeccao_status !== "em_conversa") return "nao_em_conversa";
  return null;
}

/** `radar` do payload → exigência; ausente/forma estranha = a action não é do Radar (null, sem checagem). */
export function lerExigenciaRadar(v: unknown): ExigenciaRadar | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return { exigirEmConversa: (v as { exigir_em_conversa?: unknown }).exigir_em_conversa === true };
}

export interface BancoRadar {
  lerLead: (documento: string) => Promise<{ data: LinhaRadarCadastro | null; error: { message: string } | null }>;
}

export async function verificarElegibilidadeRadar(
  banco: BancoRadar, documento: string, ex: ExigenciaRadar,
): Promise<{ ok: true } | { ok: false; motivo: MotivoInelegivelRadar }> {
  const { data, error } = await banco.lerLead(documento);
  if (error) throw new Error(`RADAR_ELEGIBILIDADE_INDETERMINADA: não consegui reler o lead no Radar — nada foi criado (${error.message})`);
  const motivo = motivoInelegivelRadar(data, ex);
  return motivo ? { ok: false, motivo } : { ok: true };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX = 500;
const COMPLEMENTO_MAX = 60;

export function emailParaCadastro(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 && t.length <= EMAIL_MAX && EMAIL_RE.test(t) ? t : null;
}

export function complementoParaCadastro(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 && t.length <= COMPLEMENTO_MAX ? t : null;
}
