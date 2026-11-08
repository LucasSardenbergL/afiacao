/**
 * Radar D1 — painel do e-mail semanal de leads (migration 20261107140001, tela Governança → Usuários).
 *
 * `radar_email_semanal_painel` (só master) devolve o estado do cron `radar-avisar-vendedores-semanal` e, por pessoa da
 * equipe, o modo do e-mail: `desligado`, `teste` (vai para o e-mail do próprio master) ou `ligado` (vai para a
 * pessoa), além do território que o e-mail usaria e do último envio.
 *
 * O leitor é estrito: resposta fora do formato LANÇA (a tela mostra "não consegui ler"), nunca vira lista vazia ou
 * "desligado" — ausente ≠ zero. Cron ausente é `null` (≠ desligado).
 *
 * Pacote E (migration 20261107230000): cada município do território diz se é `compartilhado` (a pessoa não é dona de
 * nenhum município e recebe os municípios onde tem clientes) e o território vazio vem com `territorio_motivo`. Os dois
 * campos são opcionais na leitura: o front pode ir ao ar antes da migration, e aí cai na copy genérica.
 */

const MODOS_EMAIL = ['desligado', 'teste', 'ligado'] as const;
export type ModoEmail = (typeof MODOS_EMAIL)[number];

/** Os códigos de private.radar_territorio_motivo, na ordem em que o território os exige. */
const MOTIVOS_TERRITORIO = ['nao_e_vendedor', 'sem_carteira', 'carteira_sem_municipio'] as const;
type MotivoTerritorio = (typeof MOTIVOS_TERRITORIO)[number];
const ehMotivo = (v: unknown): v is MotivoTerritorio =>
  typeof v === 'string' && (MOTIVOS_TERRITORIO as readonly string[]).includes(v);

export interface UltimoEnvio {
  semana: string;
  ehTeste: boolean;
  nLeads: number;
  elegiveis: number;
  destinatario: string;
  /** Status do alerta no dispatch (`pendente_notificacao`, `notificado`, …); null se o alerta sumiu. */
  status: string | null;
}

export interface UsuarioEmailSemanal {
  userId: string;
  nome: string | null;
  email: string | null;
  papel: string | null;
  papelComercial: string | null;
  acessoRadar: boolean;
  modo: ModoEmail;
  emailTeste: string | null;
  territorio: { municipio: string; uf: string; clientes: number; compartilhado: boolean }[];
  /** Por que o território está vazio (null = há território, ou o banco ainda não diz). */
  territorioMotivo: MotivoTerritorio | null;
  ultimoEnvio: UltimoEnvio | null;
}

export interface PainelEmailSemanal {
  /** null = o job não existe no banco (≠ desligado). */
  cron: { ativo: boolean; agenda: string } | null;
  usuarios: UsuarioEmailSemanal[];
}

const ehObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const texto = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const inteiro = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);
const ehModo = (v: unknown): v is ModoEmail => typeof v === 'string' && (MODOS_EMAIL as readonly string[]).includes(v);

function falha(origem: string, oque: string): never {
  throw new Error(`${origem}: resposta fora do formato (${oque})`);
}

function lerUltimoEnvio(v: unknown, origem: string, i: number): UltimoEnvio | null {
  if (v === null || v === undefined) return null;
  if (!ehObj(v)) falha(origem, `usuarios[${i}].ultimo_envio`);
  const semana = texto(v.semana);
  const nLeads = inteiro(v.n_leads);
  const elegiveis = inteiro(v.elegiveis);
  const destinatario = texto(v.destinatario);
  if (!semana || typeof v.eh_teste !== 'boolean' || nLeads === null || elegiveis === null || !destinatario) {
    falha(origem, `usuarios[${i}].ultimo_envio`);
  }
  return { semana, ehTeste: v.eh_teste, nLeads, elegiveis, destinatario, status: texto(v.status) };
}

export function lerPainelEmailSemanal(data: unknown, origem: string): PainelEmailSemanal {
  if (!ehObj(data) || !Array.isArray(data.usuarios)) falha(origem, 'usuarios');

  let cron: PainelEmailSemanal['cron'] = null;
  if (data.cron !== null && data.cron !== undefined) {
    if (!ehObj(data.cron) || typeof data.cron.ativo !== 'boolean') falha(origem, 'cron');
    cron = { ativo: data.cron.ativo, agenda: texto(data.cron.agenda) ?? '' };
  }

  const usuarios = (data.usuarios as unknown[]).map((u, i): UsuarioEmailSemanal => {
    if (!ehObj(u)) falha(origem, `usuarios[${i}]`);
    const userId = texto(u.user_id);
    if (!userId || !ehModo(u.modo) || typeof u.acesso_radar !== 'boolean' || !Array.isArray(u.territorio)) {
      falha(origem, `usuarios[${i}]`);
    }
    const territorio = (u.territorio as unknown[]).map((t, j) => {
      if (!ehObj(t)) falha(origem, `usuarios[${i}].territorio[${j}]`);
      const municipio = texto(t.municipio);
      const clientes = inteiro(t.clientes);
      if (!municipio || clientes === null) falha(origem, `usuarios[${i}].territorio[${j}]`);
      if (t.compartilhado !== undefined && typeof t.compartilhado !== 'boolean') falha(origem, `usuarios[${i}].territorio[${j}]`);
      return { municipio, uf: texto(t.uf) ?? '', clientes, compartilhado: t.compartilhado === true };
    });
    // Código desconhecido (banco à frente do front) não derruba a tela: cai na copy genérica.
    const territorioMotivo = ehMotivo(u.territorio_motivo) ? u.territorio_motivo : null;
    return {
      userId,
      nome: texto(u.nome),
      email: texto(u.email),
      papel: texto(u.papel),
      papelComercial: texto(u.papel_comercial),
      acessoRadar: u.acesso_radar,
      modo: u.modo,
      emailTeste: texto(u.email_teste),
      territorio,
      territorioMotivo,
      ultimoEnvio: lerUltimoEnvio(u.ultimo_envio, origem, i),
    };
  });

  return { cron, usuarios };
}

const COPY_SEM_TERRITORIO: Record<MotivoTerritorio | 'desconhecido', string> = {
  nao_e_vendedor: 'Sem papel de vendedor (farmer, hunter ou closer): não há território para escolher leads.',
  sem_carteira: 'Sem carteira atribuída: não há municípios para escolher leads.',
  carteira_sem_municipio: 'Os clientes da carteira não têm endereço em um município do Radar: não há onde escolher leads.',
  desconhecido: 'Sem território: não há municípios para escolher leads.',
};

/**
 * Por que o e-mail desta pessoa NÃO sairia mesmo ligado — o mesmo motivo com que `radar_avisar_vendedores` a pula.
 * null = nada impede.
 */
export function impedimentoDoEnvio(u: UsuarioEmailSemanal): string | null {
  if (!u.acessoRadar) return 'Sem acesso ao Radar: o e-mail seria pulado.';
  if (u.territorio.length === 0) return `${COPY_SEM_TERRITORIO[u.territorioMotivo ?? 'desconhecido']} Só sai e-mail se o gestor passar leads a esta pessoa.`;
  if (u.modo === 'ligado' && !u.email) return 'Sem e-mail no cadastro: o envio real seria pulado.';
  return null;
}

/** "DIVINÓPOLIS, NOVA SERRANA e CLÁUDIO" — vazio vira "—"; território de fallback diz que é dividido com o dono. */
export function listaMunicipios(territorio: UsuarioEmailSemanal['territorio']): string {
  const nomes = territorio.map((t) => t.municipio);
  if (nomes.length === 0) return '—';
  const lista = nomes.length === 1 ? nomes[0] : `${nomes.slice(0, -1).join(', ')} e ${nomes[nomes.length - 1]}`;
  return territorio.some((t) => t.compartilhado) ? `${lista} (sem município próprio: divide com o dono)` : lista;
}

/** "semana de 23/11 · 5 de 972 · teste · enviado" */
export function resumoUltimoEnvio(e: UltimoEnvio | null): string {
  if (!e) return 'Nenhum envio ainda';
  const [ano, mes, dia] = e.semana.split('-');
  const quando = dia && mes && ano ? `${dia}/${mes}` : e.semana;
  const estado =
    e.status === 'notificado' ? 'enviado'
      : e.status === 'pendente_notificacao' ? 'na fila'
        : e.status === 'falha_notificacao' ? 'falhou'
          : e.status ?? 'sem alerta';
  return `semana de ${quando} · ${e.nLeads} de ${e.elegiveis} · ${e.ehTeste ? 'teste' : 'real'} · ${estado}`;
}
