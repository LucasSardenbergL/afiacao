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
// Posse (decisão do founder 2026-11-14, recomendação Codex da revisão): o cadastro ANTECIPADO do lote do gestor (o que
// não exige conversa) PULA o lead em posse ativa ("em atendimento") de OUTRO vendedor — motivo `posse_de_outro`. A
// posse vem da RPC canônica `radar_atendimentos_ativos` com a identidade do CHAMADOR (a mesma definição de "ativa" que
// a tela mostra; `eh_meu` calculado no banco). Posse que não deu para ler LANÇA: desconhecida nunca vira "livre".
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
  | "lead_inexistente" | "ja_cliente" | "ja_vinculado_omie" | "rfb_nao_ativa" | "descartado" | "nao_em_conversa"
  | "posse_de_outro";

export interface ExigenciaRadar {
  /** A ficha do vendedor cadastra quem está EM CONVERSA; o lote do gestor não exige (cadastro antecipado). */
  exigirEmConversa: boolean;
  /** O lote (cadastro antecipado, sem exigir conversa) não atropela a posse de OUTRO vendedor. Derivado de
   *  `!exigirEmConversa` em `lerExigenciaRadar` — o build do lote que já está nos navegadores manda
   *  `exigir_em_conversa: false`, então a regra vale assim que a edge sobe, sem esperar o PWA atualizar. */
  respeitarPosse: boolean;
}

/** Situação cadastral ATIVA na Receita (a mesma constante do front, `RFB_ATIVA`). */
const RFB_ATIVA = "02";

export function motivoInelegivelRadar(
  l: LinhaRadarCadastro | null, ex: Pick<ExigenciaRadar, "exigirEmConversa">,
): MotivoInelegivelRadar | null {
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
  const exigirEmConversa = (v as { exigir_em_conversa?: unknown }).exigir_em_conversa === true;
  return { exigirEmConversa, respeitarPosse: !exigirEmConversa };
}

export interface BancoRadar {
  lerLead: (documento: string) => Promise<{ data: LinhaRadarCadastro | null; error: { message: string } | null }>;
  /** Linhas de `radar_atendimentos_ativos()` filtradas pelo documento, lidas com o JWT do CHAMADOR. `null` = não há
   *  client do usuário (cron/service role): a posse fica desconhecida. */
  lerPosse: ((documento: string) => Promise<{ data: unknown; error: { message: string } | null }>) | null;
}

export type VereditoRadar =
  | { ok: true }
  | { ok: false; motivo: MotivoInelegivelRadar; donoNome?: string | null };

const NOME_DONO_MAX = 200;

function posseIndeterminada(detalhe: string): Error {
  return new Error(`RADAR_POSSE_INDETERMINADA: não consegui ler quem atende o lead — nada foi criado (${detalhe})`);
}

/** Linhas da RPC → livre (null) ou o nome do dono alheio. Qualquer forma fora do contrato LANÇA (nunca "livre"). */
export function posseDeOutro(documento: string, data: unknown): { donoNome: string | null } | null {
  if (!Array.isArray(data)) throw posseIndeterminada("a leitura não devolveu uma lista");
  if (data.length === 0) return null;
  // Índice único parcial (cnpj) WHERE encerrado_em IS NULL: 2+ posses abertas do mesmo lead é contrato quebrado.
  if (data.length > 1) throw posseIndeterminada(`${data.length} posses ativas para o mesmo lead`);
  const l = data[0] as { cnpj?: unknown; eh_meu?: unknown; dono_nome?: unknown } | null;
  if (!l || typeof l !== "object" || l.cnpj !== documento) throw posseIndeterminada("linha de outro lead");
  if (typeof l.eh_meu !== "boolean") throw posseIndeterminada("eh_meu fora do contrato");
  if (l.eh_meu) return null;
  const nome = typeof l.dono_nome === "string" ? l.dono_nome.trim() : "";
  return { donoNome: nome.length > 0 && nome.length <= NOME_DONO_MAX ? nome : null };
}

export async function verificarElegibilidadeRadar(
  banco: BancoRadar, documento: string, ex: ExigenciaRadar,
): Promise<VereditoRadar> {
  const { data, error } = await banco.lerLead(documento);
  if (error) throw new Error(`RADAR_ELEGIBILIDADE_INDETERMINADA: não consegui reler o lead no Radar — nada foi criado (${error.message})`);
  const motivo = motivoInelegivelRadar(data, ex);
  if (motivo) return { ok: false, motivo };
  if (!ex.respeitarPosse) return { ok: true };
  if (!banco.lerPosse) throw posseIndeterminada("chamada sem usuário");
  const posse = await banco.lerPosse(documento);
  if (posse.error) throw posseIndeterminada(posse.error.message);
  const deOutro = posseDeOutro(documento, posse.data);
  return deOutro ? { ok: false, motivo: "posse_de_outro", donoNome: deOutro.donoNome } : { ok: true };
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
