// Conflito de cadastro Radar×Omie registrado no SERVIDOR (`radar_cadastro_conflitos`, migration 20261027160000 —
// achado 3 do Codex no PR #3293). O lote vive no localStorage e cada aba o regrava inteiro: o `divergente` de uma
// aba sumia pela outra. A evidência agora é do servidor; aqui ficam a forma das respostas (conferida — desvio
// LANÇA, nunca vira "sem conflito") e a regra de sobreposição local × servidor (desenho Codex 2026-10-27).

/**
 *  - `vinculo_divergente`: o CNPJ já está vinculado a OUTRO código (v2 em RD001, ou retomada com código ≠ vínculo);
 *  - `codigo_de_outro_cnpj`: o código já está vinculado a OUTRO CNPJ (v2 em RD002);
 *  - `lookup_divergente`: a edge achou no Omie um cliente com OUTRO documento (`OMIE_LOOKUP_DIVERGENTE`) — relato
 *    que o banco não consegue verificar.
 */
export type MotivoDivergencia = 'vinculo_divergente' | 'codigo_de_outro_cnpj' | 'lookup_divergente';
const MOTIVOS: ReadonlySet<string> = new Set<MotivoDivergencia>(['vinculo_divergente', 'codigo_de_outro_cnpj', 'lookup_divergente']);

export const ehMotivoDivergencia = (v: unknown): v is MotivoDivergencia => typeof v === 'string' && MOTIVOS.has(v);

/** SQLSTATE do erro do PostgREST (objeto plano, não `Error`) — null quando não há. */
export function sqlstateDe(e: unknown): string | null {
  if (!e || typeof e !== 'object' || !('code' in e)) return null;
  const c = (e as { code: unknown }).code;
  return typeof c === 'string' ? c : null;
}

export interface ConflitoCadastro {
  id: number;
  cnpj: string;
  motivo: MotivoDivergencia;
  /** O que o Omie disse (null quando a divergência veio antes do código). */
  codigoRecebido: string | null;
  /** O vínculo que o SERVIDOR tinha na última observação. */
  codigoVinculado: string | null;
  /** Em `codigo_de_outro_cnpj`: o CNPJ dono do código. */
  cnpjDoCodigo: string | null;
  detalhe: string;
  ocorrencias: number;
  /** Concorrência otimista do "conferi no Omie": muda a cada observação nova. */
  versao: number;
  ultimaEm: string;
  resolvidoEm: string | null;
  notaResolucao: string | null;
}

export interface EstadoCadastro {
  vinculo: string | null;
  /** Conflitos ABERTOS do CNPJ, lidos no MESMO instante do vínculo (FOR SHARE no servidor). */
  conflitos: ConflitoCadastro[];
}

/** Resposta da `radar_registrar_cadastro_omie_v2`. */
export type ResultadoRegistroRadar =
  | { ok: true; deduped: boolean }
  | { ok: false; bloqueado: boolean; conflito: ConflitoCadastro };

type Obj = Record<string, unknown>;
const ehObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const texto = (v: unknown): v is string => typeof v === 'string';
const textoOuNulo = (v: unknown): v is string | null => v === null || typeof v === 'string';
const inteiro = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1;

function forma(fonte: string, o: string): never {
  throw new Error(`RADAR_RESPOSTA_INDETERMINADA: ${fonte} fora da forma (${o})`);
}

/** Uma linha de `radar_cadastro_conflitos` (snake_case, do `to_jsonb` ou do SELECT). Lança fora da forma. */
export function parsearConflito(v: unknown, fonte = 'conflito'): ConflitoCadastro {
  if (!ehObj(v)) forma(fonte, 'não é objeto');
  const { id, cnpj, motivo, codigo_recebido, codigo_vinculado, cnpj_do_codigo, detalhe, ocorrencias, versao, ultima_em, resolvido_em, nota_resolucao } = v;
  if (!inteiro(id) || !texto(cnpj) || !ehMotivoDivergencia(motivo) || !texto(detalhe) || !inteiro(ocorrencias) || !inteiro(versao)
      || !texto(ultima_em) || !textoOuNulo(codigo_recebido) || !textoOuNulo(codigo_vinculado) || !textoOuNulo(cnpj_do_codigo)
      || !textoOuNulo(resolvido_em) || !textoOuNulo(nota_resolucao)) {
    forma(fonte, 'campos do conflito');
  }
  return {
    id, cnpj, motivo, codigoRecebido: codigo_recebido, codigoVinculado: codigo_vinculado,
    cnpjDoCodigo: cnpj_do_codigo, detalhe, ocorrencias, versao, ultimaEm: ultima_em, resolvidoEm: resolvido_em, notaResolucao: nota_resolucao,
  };
}

/** `radar_estado_cadastro_omie`: `{vinculo, conflitos[]}`. */
export function parsearEstadoCadastro(v: unknown): EstadoCadastro {
  if (!ehObj(v) || !textoOuNulo(v.vinculo) || !Array.isArray(v.conflitos)) forma('radar_estado_cadastro_omie', '{vinculo, conflitos}');
  const vinculo = v.vinculo === null || v.vinculo.trim() === '' ? null : v.vinculo.trim();
  return { vinculo, conflitos: v.conflitos.map((c) => parsearConflito(c, 'radar_estado_cadastro_omie')) };
}

/** `radar_registrar_cadastro_omie_v2`: `{ok:true, deduped}` ou `{ok:false, bloqueado, conflito}` — nada além disso. */
export function parsearRegistroV2(v: unknown): ResultadoRegistroRadar {
  const fonte = 'radar_registrar_cadastro_omie_v2';
  if (!ehObj(v)) forma(fonte, 'não é objeto');
  if (v.ok === true && typeof v.deduped === 'boolean') return { ok: true, deduped: v.deduped };
  if (v.ok === false && typeof v.bloqueado === 'boolean') return { ok: false, bloqueado: v.bloqueado, conflito: parsearConflito(v.conflito, fonte) };
  return forma(fonte, '{ok, deduped} | {ok:false, bloqueado, conflito}');
}

export function rotuloMotivo(m: MotivoDivergencia): string {
  if (m === 'vinculo_divergente') return 'CNPJ já vinculado a outro código Omie';
  if (m === 'codigo_de_outro_cnpj') return 'código Omie já vinculado a outro CNPJ';
  return 'o Omie achou um cliente com outro documento (relato da integração, não verificável pelo Radar)';
}

/** Uma linha legível do conflito: o que o Omie disse × o que o Radar tem. */
export function resumoConflito(c: ConflitoCadastro): string {
  const partes = [rotuloMotivo(c.motivo)];
  if (c.codigoRecebido) partes.push(`Omie devolveu ${c.codigoRecebido}`);
  if (c.codigoVinculado) partes.push(`Radar tem ${c.codigoVinculado}`);
  if (c.cnpjDoCodigo) partes.push(`código é de ${c.cnpjDoCodigo}`);
  if (c.ocorrencias > 1) partes.push(`${c.ocorrencias} ocorrências`);
  return partes.join(' · ');
}

/**
 * Como mostrar um item do lote cruzando o local (localStorage desta aba) com o servidor (Codex 2026-10-27, g):
 *  - `aberto`: há conflito ABERTO no servidor — vence até um item local `ok` (não conta como sucesso atual);
 *  - `conferido`: o conflito que ESTA aba registrou foi resolvido e não há outro aberto (resolvido ≠ ok);
 *  - `nao_sincronizado`: divergência local sem registro correspondente no servidor (o aviso fica local);
 *  - `indisponivel`: a leitura do servidor falhou — mantém a evidência local, nunca vira "sem conflito";
 *  - `nenhum`: nada a sobrepor.
 */
export type SituacaoConflito =
  | { tipo: 'aberto'; conflitos: ConflitoCadastro[] }
  | { tipo: 'conferido'; conflito: ConflitoCadastro }
  | { tipo: 'nao_sincronizado' }
  | { tipo: 'indisponivel' }
  | { tipo: 'nenhum' };

export function situacaoConflito(
  local: { divergente: boolean; conflitoId: number | null },
  doServidor: ConflitoCadastro[] | null,
): SituacaoConflito {
  if (doServidor === null) return local.divergente ? { tipo: 'indisponivel' } : { tipo: 'nenhum' };
  const abertos = doServidor.filter((c) => c.resolvidoEm === null);
  if (abertos.length > 0) return { tipo: 'aberto', conflitos: abertos };
  if (!local.divergente) return { tipo: 'nenhum' };
  const meu = local.conflitoId === null ? undefined : doServidor.find((c) => c.id === local.conflitoId);
  return meu ? { tipo: 'conferido', conflito: meu } : { tipo: 'nao_sincronizado' };
}
