/**
 * Radar D2 — card "Prospectar hoje" do painel do farmer (migration 20261106181000).
 *
 * A RPC `radar_prospectar_hoje` devolve os municípios onde o vendedor tem mais clientes da carteira (o "território",
 * cada município com UM dono: quem tem mais clientes nele) e os top-N leads por score ali — sem já-cliente,
 * descartado, em conversa, sem score, baixado/inapto na Receita ou com dono temporário ativo de outro vendedor.
 * O e-mail semanal (D1) usa a MESMA escolha.
 *
 * O leitor é estrito: resposta fora do formato LANÇA (o card mostra "não consegui ler"), nunca vira "sem leads" —
 * ausente ≠ zero.
 */

export interface MunicipioTerritorio {
  municipioCodigo: string;
  municipioNome: string;
  uf: string;
  clientes: number;
  /** Pacote E: true = fallback — o vendedor não é dono de nenhum município e recebe os em que tem clientes. */
  compartilhado?: boolean;
}

/** Copy do card para cada motivo de território VAZIO (`territorio_motivo` do pacote E: 'nao_e_vendedor' |
 *  'sem_carteira' | 'carteira_sem_municipio'). Sem motivo (RPC antiga) ou código novo: o texto genérico de antes. */
export function textoSemTerritorio(motivo: string | null): string {
  switch (motivo) {
    case 'nao_e_vendedor': return 'Você não tem papel de vendedor no Radar (farmer, hunter ou closer), então não há carteira para usar de referência.';
    case 'sem_carteira': return 'Sua carteira está vazia — sem clientes, não há onde procurar leads perto deles.';
    case 'carteira_sem_municipio': return 'Os clientes da sua carteira não têm endereço em um município do Radar, então não há onde procurar leads perto deles.';
    default: return 'Sua carteira não tem clientes com endereço num município do Radar, então não há onde procurar leads perto dela.';
  }
}

export interface LeadProspectarHoje {
  posicao: number;
  cnpj: string;
  razaoSocial: string | null;
  nomeFantasia: string | null;
  municipioNome: string | null;
  uf: string | null;
  score: number;
  motivos: string[];
  /** Tamanho do universo elegível no território (denominador "3 de N"). */
  elegiveis: number;
  /** Pacote E: lead que o gestor passou ao vendedor (vem primeiro, mesmo fora do território). */
  atribuido: boolean;
  /** Posse ativa do PRÓPRIO vendedor, se a RPC a devolver marcada (o pacote E a tira do card; aceito os dois). */
  comVoce: boolean;
  /** Todo contato do lead parece ser da contabilidade (migration 20261109140000): o card manda VISITAR, não ligar.
   *  RPC anterior ao campo = false (o card de antes). */
  visitar: boolean;
  /** Endereço para a visita — só quando `visitar`. */
  endereco: string | null;
}

export interface ProspectarHoje {
  territorio: MunicipioTerritorio[];
  leads: LeadProspectarHoje[];
  /** Pacote E: motivo do território vazio; null quando há território ou a RPC é anterior ao campo. */
  territorioMotivo: string | null;
}

const ehObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const texto = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const inteiro = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);

function falha(origem: string, oque: string): never {
  throw new Error(`${origem}: resposta fora do formato (${oque})`);
}

export function lerProspectarHoje(data: unknown, origem: string): ProspectarHoje {
  if (!ehObj(data) || !Array.isArray(data.territorio) || !Array.isArray(data.leads)) falha(origem, 'territorio/leads');

  const territorio = (data.territorio as unknown[]).map((t, i): MunicipioTerritorio => {
    if (!ehObj(t)) falha(origem, `territorio[${i}]`);
    const codigo = texto(t.municipio_codigo);
    const nome = texto(t.municipio_nome);
    const clientes = inteiro(t.clientes);
    if (!codigo || !nome || clientes === null || clientes < 1) falha(origem, `territorio[${i}]`);
    return { municipioCodigo: codigo, municipioNome: nome, uf: texto(t.uf) ?? '', clientes, compartilhado: t.compartilhado === true };
  });

  const leads = (data.leads as unknown[]).map((l, i): LeadProspectarHoje => {
    if (!ehObj(l)) falha(origem, `leads[${i}]`);
    const cnpj = texto(l.cnpj);
    const posicao = inteiro(l.posicao);
    const score = inteiro(l.score);
    const elegiveis = inteiro(l.elegiveis);
    if (!cnpj || posicao === null || score === null || elegiveis === null || elegiveis < 1) falha(origem, `leads[${i}]`);
    const motivos = Array.isArray(l.score_motivos)
      ? l.score_motivos.filter((m): m is string => typeof m === 'string' && m.trim() !== '')
      : [];
    return {
      posicao,
      cnpj,
      razaoSocial: texto(l.razao_social),
      nomeFantasia: texto(l.nome_fantasia),
      municipioNome: texto(l.municipio_nome),
      uf: texto(l.uf),
      score,
      motivos,
      elegiveis,
      atribuido: l.atribuido === true,
      comVoce: l.com_voce === true,
      visitar: l.visitar === true,
      endereco: l.visitar === true ? texto(l.endereco) : null,
    };
  });

  return { territorio, leads, territorioMotivo: texto(data.territorio_motivo) };
}

/** Nome para mostrar: fantasia quando existe, senão razão social, senão o CNPJ. */
export function nomeDoLead(l: Pick<LeadProspectarHoje, 'nomeFantasia' | 'razaoSocial' | 'cnpj'>): string {
  return l.nomeFantasia ?? l.razaoSocial ?? l.cnpj;
}

/** Deep link da ficha no Radar (formato do pacote B5: `/radar?cnpj=`). */
export function linkFichaRadar(cnpj: string): string {
  return `/radar?cnpj=${encodeURIComponent(cnpj)}`;
}

/** "Divinópolis (358) · Nova Serrana (266)" — o porquê do território, com a contagem que o decide. */
export function resumoTerritorio(t: readonly MunicipioTerritorio[]): string {
  return t.map((m) => `${tituloMunicipio(m.municipioNome)} (${m.clientes})`).join(' · ');
}

/** Parâmetros do link `/radar/abrir/:envio/:cnpj` do e-mail semanal. `null` = link malformado. */
export function lerLinkDoEmail(envio: string | undefined, cnpj: string | undefined): { envio: string; cnpj: string } | null {
  const e = (envio ?? '').trim();
  const c = (cnpj ?? '').trim().toUpperCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(e)) return null;
  if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(c)) return null;
  return { envio: e.toLowerCase(), cnpj: c };
}

const PARTICULAS = new Set(['de', 'da', 'do', 'das', 'dos', 'e']);
/** Município vem em CAIXA ALTA da Receita ("PARA DE MINAS"); na tela vai em caixa de título ("Para de Minas"). */
export function tituloMunicipio(nome: string | null): string {
  if (!nome) return '';
  return nome
    .toLocaleLowerCase('pt-BR')
    .split(/\s+/)
    .filter(Boolean)
    .map((p, i) => (i > 0 && PARTICULAS.has(p) ? p : p.charAt(0).toLocaleUpperCase('pt-BR') + p.slice(1)))
    .join(' ');
}
