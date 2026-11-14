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

/** Pacote G: um compromisso de retorno vencido até hoje (a agenda do vendedor, à parte do top de leads novos). */
export interface RetornoHoje {
  cnpj: string;
  razaoSocial: string | null;
  nomeFantasia: string | null;
  municipioNome: string | null;
  uf: string | null;
  /** 'conversa' = "em conversa" com data marcada; 'nao_atendeu' = tentar de novo depois do prazo. */
  tipo: 'conversa' | 'nao_atendeu';
  /** Dia civil BRT 'YYYY-MM-DD'. */
  retornoEm: string;
  atrasado: boolean;
  nota: string | null;
}

/** Pacote G3: posse do vendedor que vence nas próximas 48 h. */
interface PosseVencendo {
  atendimentoId: number;
  cnpj: string;
  razaoSocial: string | null;
  nomeFantasia: string | null;
  expiraEm: string;
}

export interface ProspectarHoje {
  territorio: MunicipioTerritorio[];
  leads: LeadProspectarHoje[];
  /** Pacote E: motivo do território vazio; null quando há território ou a RPC é anterior ao campo. */
  territorioMotivo: string | null;
  /** Pacote G: null = RPC anterior ao campo (não sei) — nunca "zero retornos". */
  retornos: { total: number; itens: RetornoHoje[] } | null;
  /** Pacote G3: null = RPC anterior ao campo (não sei) — nunca "nenhuma posse vencendo". */
  posses: { vencendo: PosseVencendo[]; vencidas7d: number } | null;
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

  return {
    territorio, leads, territorioMotivo: texto(data.territorio_motivo),
    retornos: lerRetornos(data.retornos, origem),
    posses: lerPosses(data.posses, origem),
  };
}

const RE_DIA = /^\d{4}-\d{2}-\d{2}$/;

/** Uma página de `radar_meus_retornos` (revisão 2026-11-11, item 8): a MESMA forma dos retornos do card, nunca nula. */
export function lerPaginaRetornos(v: unknown, origem: string): NonNullable<ProspectarHoje['retornos']> {
  const r = lerRetornos(v, origem);
  if (!r) falha(origem, 'retornos');
  return r;
}

function lerRetornos(v: unknown, origem: string): ProspectarHoje['retornos'] {
  if (v === undefined || v === null) return null;
  if (!ehObj(v) || !Array.isArray(v.itens)) falha(origem, 'retornos');
  const total = inteiro(v.total);
  if (total === null || total < 0) falha(origem, 'retornos.total');
  const itens = (v.itens as unknown[]).map((r, i): RetornoHoje => {
    if (!ehObj(r)) falha(origem, `retornos.itens[${i}]`);
    const cnpj = texto(r.cnpj);
    const dia = texto(r.retorno_em);
    if (!cnpj || !dia || !RE_DIA.test(dia) || (r.retorno_tipo !== 'conversa' && r.retorno_tipo !== 'nao_atendeu')) {
      falha(origem, `retornos.itens[${i}]`);
    }
    return {
      cnpj, razaoSocial: texto(r.razao_social), nomeFantasia: texto(r.nome_fantasia), municipioNome: texto(r.municipio_nome),
      uf: texto(r.uf), tipo: r.retorno_tipo, retornoEm: dia, atrasado: r.atrasado === true, nota: texto(r.nota),
    };
  });
  if (itens.length > total) falha(origem, 'retornos.total');
  return { total, itens };
}

function lerPosses(v: unknown, origem: string): ProspectarHoje['posses'] {
  if (v === undefined || v === null) return null;
  if (!ehObj(v) || !Array.isArray(v.vencendo)) falha(origem, 'posses');
  const vencidas7d = inteiro(v.vencidas_7d);
  if (vencidas7d === null || vencidas7d < 0) falha(origem, 'posses.vencidas_7d');
  const vencendo = (v.vencendo as unknown[]).map((p, i): PosseVencendo => {
    if (!ehObj(p)) falha(origem, `posses.vencendo[${i}]`);
    const cnpj = texto(p.cnpj);
    const id = inteiro(p.atendimento_id);
    const expira = texto(p.expira_em);
    if (!cnpj || id === null || !expira || Number.isNaN(Date.parse(expira))) falha(origem, `posses.vencendo[${i}]`);
    return { atendimentoId: id, cnpj, razaoSocial: texto(p.razao_social), nomeFantasia: texto(p.nome_fantasia), expiraEm: expira };
  });
  return { vencendo, vencidas7d };
}

/** Nome para mostrar: fantasia quando existe, senão razão social, senão o CNPJ. */
export function nomeDoLead(l: Pick<LeadProspectarHoje, 'nomeFantasia' | 'razaoSocial' | 'cnpj'>): string {
  return l.nomeFantasia ?? l.razaoSocial ?? l.cnpj;
}

/** Deep link da ficha no Radar (formato do pacote B5: `/radar?cnpj=`). `origem: 'card'` marca a ficha aberta pelo card
 *  "prospectar hoje": o /radar grava a ficha entregue no funil (`ficha_card`) quando ela abre. O link do e-mail não
 *  leva origem (a página dele grava a própria ficha antes do redirect). */
export function linkFichaRadar(cnpj: string, origem?: 'card' | { email: string }): string {
  const base = `/radar?cnpj=${encodeURIComponent(cnpj)}`;
  if (!origem) return base;
  // E-mail (revisão 2026-11-11, item 4): a ficha entregue é gravada pelo /radar quando ela APARECE, com o envio.
  if (typeof origem === 'object') return `${base}&origem=email&envio=${encodeURIComponent(origem.email)}`;
  return `${base}&origem=${origem}`;
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
