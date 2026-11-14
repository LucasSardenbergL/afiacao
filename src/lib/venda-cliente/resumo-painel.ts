// Borda do `jsonb` de `venda_resumo_painel` (venda R2 · Entrega 1: resumo diário por e-mail + grupo controle).
// Mesma régua de `painel-rpc.ts`: chave que a função SEMPRE monta e veio ausente = forma desconhecida e LANÇA; NULL só
// onde a função o produz; tipo trocado LANÇA. O lançamento cai no `isError` do react-query — a tela mostra a falha,
// nunca um número fabricado (ausente ≠ zero).
import type { Json } from '@/integrations/supabase/types';

export type StatusResumo = 'medindo' | 'acesso_pendente' | 'manter' | 'desligar';
const STATUS: readonly StatusResumo[] = ['medindo', 'acesso_pendente', 'manter', 'desligar'];

interface SorteioResumo {
  inicio: string;
  fracao_controle: number;
  algoritmo: string;
  realizado_em: string;
  compradores: number;
  controle: number;
}

export interface DiaResumo {
  dia: string;
  farmer_user_id: string;
  nome: string;
  envio_status: string | null;
  enviado_em: string | null;
  aberto_em: string | null;
  tentativa: number;
  entregues: number;
  clicadas: number;
  tentativas: number;
  ofertadas: number;
  acesso_validado: boolean | null;
  copia_status: string | null;
}

interface FarmerResumo {
  farmer_user_id: string;
  nome: string;
  primeiro_envio: string | null;
  dias_com_envio: number;
  dias_acesso_validado: number;
  entregues: number;
  clicadas: number;
  tentativas: number;
  ofertadas: number;
  taxa_ofertada: number | null;
  status: StatusResumo;
}

export interface BracoEfeito {
  compradores: number;
  maduros: number;
  converteram: number;
  nao_medivel: number;
  sem_linhas: number;
  taxa: number | null;
}

interface BracoAA {
  virou: number;
  nao_virou: number;
  taxa: number | null;
}

export interface ResumoPainel {
  periodo: { de: string; ate: string };
  hoje: string;
  sorteio: SorteioResumo | null;
  dias: DiaResumo[];
  farmers: FarmerResumo[];
  efeito: {
    tratamento: BracoEfeito | null;
    controle: BracoEfeito | null;
    diferenca: number | null;
    ic95: [number, number] | null;
    aviso: string;
  };
  aa_historico: { tratamento: BracoAA | null; controle: BracoAA | null };
}

type Obj = { [k: string]: Json | undefined };
const ehObj = (v: Json | undefined): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function obj(v: Json | undefined, onde: string): Obj {
  if (!ehObj(v)) throw new Error(`${onde}: não é objeto`);
  return v;
}
function campo(o: Obj, k: string, onde: string): Json {
  const v = o[k];
  if (v === undefined) throw new Error(`${onde}: sem "${k}"`);
  return v;
}
function str(o: Obj, k: string, onde: string): string {
  const v = campo(o, k, onde);
  if (typeof v !== 'string') throw new Error(`${onde}: "${k}" não é texto`);
  return v;
}
function strOuNulo(o: Obj, k: string, onde: string): string | null {
  const v = campo(o, k, onde);
  if (v !== null && typeof v !== 'string') throw new Error(`${onde}: "${k}" não é texto`);
  return v;
}
function num(o: Obj, k: string, onde: string): number {
  const v = campo(o, k, onde);
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${onde}: "${k}" não é número`);
  return v;
}
function numOuNulo(o: Obj, k: string, onde: string): number | null {
  const v = campo(o, k, onde);
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${onde}: "${k}" não é número`);
  return v;
}
function boolOuNulo(o: Obj, k: string, onde: string): boolean | null {
  const v = campo(o, k, onde);
  if (v !== null && typeof v !== 'boolean') throw new Error(`${onde}: "${k}" não é booleano`);
  return v;
}
function lista(o: Obj, k: string, onde: string): Json[] {
  const v = campo(o, k, onde);
  if (!Array.isArray(v)) throw new Error(`${onde}: "${k}" não é lista`);
  return v;
}

function lerBracoEfeito(v: Json | undefined, onde: string): BracoEfeito | null {
  // A chave do braço some quando o braço não tem ninguém selecionado (jsonb_object_agg): ausente = sem dado, não zero.
  if (v === undefined || v === null) return null;
  const o = obj(v, onde);
  return {
    compradores: num(o, 'compradores', onde),
    maduros: num(o, 'maduros', onde),
    converteram: num(o, 'converteram', onde),
    nao_medivel: num(o, 'nao_medivel', onde),
    sem_linhas: num(o, 'sem_linhas', onde),
    taxa: numOuNulo(o, 'taxa', onde),
  };
}

function lerBracoAA(v: Json | undefined, onde: string): BracoAA | null {
  if (v === undefined || v === null) return null;
  const o = obj(v, onde);
  return { virou: num(o, 'virou', onde), nao_virou: num(o, 'nao_virou', onde), taxa: numOuNulo(o, 'taxa', onde) };
}

export function lerResumoPainel(data: Json): ResumoPainel {
  const r = obj(data, 'venda_resumo_painel');
  const per = obj(campo(r, 'periodo', 'painel'), 'periodo');

  const sv = campo(r, 'sorteio', 'painel');
  let sorteio: SorteioResumo | null = null;
  if (sv !== null) {
    const s = obj(sv, 'sorteio');
    sorteio = {
      inicio: str(s, 'inicio', 'sorteio'),
      fracao_controle: num(s, 'fracao_controle', 'sorteio'),
      algoritmo: str(s, 'algoritmo', 'sorteio'),
      realizado_em: str(s, 'realizado_em', 'sorteio'),
      compradores: num(s, 'compradores', 'sorteio'),
      controle: num(s, 'controle', 'sorteio'),
    };
  }

  const dias = lista(r, 'dias', 'painel').map((v, i): DiaResumo => {
    const onde = `dias[${i}]`;
    const d = obj(v, onde);
    return {
      dia: str(d, 'dia', onde),
      farmer_user_id: str(d, 'farmer_user_id', onde),
      nome: str(d, 'nome', onde),
      envio_status: strOuNulo(d, 'envio_status', onde),
      enviado_em: strOuNulo(d, 'enviado_em', onde),
      aberto_em: strOuNulo(d, 'aberto_em', onde),
      tentativa: num(d, 'tentativa', onde),
      entregues: num(d, 'entregues', onde),
      clicadas: num(d, 'clicadas', onde),
      tentativas: num(d, 'tentativas', onde),
      ofertadas: num(d, 'ofertadas', onde),
      acesso_validado: boolOuNulo(d, 'acesso_validado', onde),
      copia_status: strOuNulo(d, 'copia_status', onde),
    };
  });

  const farmers = lista(r, 'farmers', 'painel').map((v, i): FarmerResumo => {
    const onde = `farmers[${i}]`;
    const f = obj(v, onde);
    const status = str(f, 'status', onde);
    if (!(STATUS as readonly string[]).includes(status)) throw new Error(`${onde}: status desconhecido "${status}"`);
    return {
      farmer_user_id: str(f, 'farmer_user_id', onde),
      nome: str(f, 'nome', onde),
      primeiro_envio: strOuNulo(f, 'primeiro_envio', onde),
      dias_com_envio: num(f, 'dias_com_envio', onde),
      dias_acesso_validado: num(f, 'dias_acesso_validado', onde),
      entregues: num(f, 'entregues', onde),
      clicadas: num(f, 'clicadas', onde),
      tentativas: num(f, 'tentativas', onde),
      ofertadas: num(f, 'ofertadas', onde),
      taxa_ofertada: numOuNulo(f, 'taxa_ofertada', onde),
      status: status as StatusResumo,
    };
  });

  const e = obj(campo(r, 'efeito', 'painel'), 'efeito');
  const icv = campo(e, 'ic95', 'efeito');
  let ic95: [number, number] | null = null;
  if (icv !== null) {
    if (!Array.isArray(icv) || icv.length !== 2 || typeof icv[0] !== 'number' || typeof icv[1] !== 'number') {
      throw new Error('efeito: "ic95" fora da forma [baixo, alto]');
    }
    ic95 = [icv[0], icv[1]];
  }
  const aa = obj(campo(r, 'aa_historico', 'painel'), 'aa_historico');

  return {
    periodo: { de: str(per, 'de', 'periodo'), ate: str(per, 'ate', 'periodo') },
    hoje: str(r, 'hoje', 'painel'),
    sorteio,
    dias,
    farmers,
    efeito: {
      tratamento: lerBracoEfeito(e.tratamento, 'efeito.tratamento'),
      controle: lerBracoEfeito(e.controle, 'efeito.controle'),
      diferenca: numOuNulo(e, 'diferenca', 'efeito'),
      ic95,
      aviso: str(e, 'aviso', 'efeito'),
    },
    aa_historico: { tratamento: lerBracoAA(aa.tratamento, 'aa.tratamento'), controle: lerBracoAA(aa.controle, 'aa.controle') },
  };
}

/** Rótulo e tom do status de desligamento (critério do founder: < 50% ofertadas após 10 dias úteis com e-mail). */
export const ROTULO_STATUS: Record<StatusResumo, { rotulo: string; tom: 'info' | 'warning' | 'success' | 'error' }> = {
  medindo: { rotulo: 'medindo (< 10 dias úteis)', tom: 'info' },
  acesso_pendente: { rotulo: 'acesso não validado', tom: 'warning' },
  manter: { rotulo: 'manter', tom: 'success' },
  desligar: { rotulo: 'desligar (< 50% ofertadas)', tom: 'error' },
};
