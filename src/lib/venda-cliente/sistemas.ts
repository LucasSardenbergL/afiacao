// "Falta completar o sistema" (venda R2 · Entrega 4) — só o founder confirma pares tinta/verniz → catalisador/diluente.
// Borda do `jsonb` de `public.venda_sistema_fila` / `venda_sistema_sensor` (migration 20261113213317).
//
// Fail-closed: chave AUSENTE ou forma desconhecida LANÇA (a tela mostra a falha, nunca uma fila ou taxa fabricada).
// Ausente ≠ zero: número NULL só onde a RPC o produz (taxa com denominador zero, valor sem preço) e vira `null`.
// Coocorrência é só CANDIDATO: nada aqui decide — quem decide é o founder, pelo botão.

export const EMPRESAS_SISTEMA = ['oben', 'colacor'] as const;
export type EmpresaSistema = (typeof EMPRESAS_SISTEMA)[number];
export type PapelSistema = 'catalisador' | 'diluente';
export type StatusPar = 'pendente' | 'confirmado' | 'rejeitado' | 'nao_sei';
export type DecisaoPar = Exclude<StatusPar, 'pendente'>;

export interface ProdutoPar {
  omieCodigoProduto: number;
  descricao: string | null;
}

export interface BoletimPar {
  /** confere = o boletim da base cita ESTE par · outro = cita outro código · nao_cita = não cita esse papel ·
   *  ambiguo = mais de um boletim casa a base (ambiguidade ⇒ nenhuma ficha). */
  situacao: 'confere' | 'outro' | 'nao_cita' | 'ambiguo';
  boletim: string | null;
  codigoCitado: string | null;
  proporcaoPct: number | null;
}

export interface CandidatoPar {
  id: number;
  status: 'pendente' | 'nao_sei';
  papel: PapelSistema;
  base: ProdutoPar & { familia: string | null; pedidos12m: number; valor12m: number | null };
  par: ProdutoPar & { familia: string | null };
  juntos: number;
  share: number;
  /** null = nenhum boletim aprovado casa a base. */
  boletim: BoletimPar | null;
}

export interface ParDecidido {
  id: number;
  status: 'confirmado' | 'rejeitado';
  papel: PapelSistema;
  decididoEm: string | null;
  base: ProdutoPar;
  par: ProdutoPar;
}

export interface FilaSistemas {
  empresa: EmpresaSistema;
  medidoEm: string;
  candidatos: CandidatoPar[];
  decididos: ParDecidido[];
}

export interface SensorFila {
  empresa: string;
  mostrados: number;
  confirmados: number;
  rejeitados: number;
  naoSei: number;
  pendentes: number;
  taxaConfirmacao: number | null;
}

export interface SensorPedidos {
  braco: string;
  elegiveis: number;
  completos: number;
  taxa: number | null;
}

export interface SensorSugestoes {
  braco: string;
  geradas: number;
  mostradas: number;
  abertas: number;
  viraram: number;
  naoVirou: number;
  naoMedivel: number;
  taxa: number | null;
}

export interface SensorSistemas {
  de: string;
  ate: string;
  fila: SensorFila[];
  pedidos: SensorPedidos[];
  sugestoes: SensorSugestoes[];
}

function obj(v: unknown, campo: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`venda_sistema: ${campo} malformado`);
  return v as Record<string, unknown>;
}
function chave(o: Record<string, unknown>, k: string, campo: string): unknown {
  if (!(k in o)) throw new Error(`venda_sistema: ${campo}.${k} ausente`);
  return o[k];
}
function num(o: Record<string, unknown>, k: string, campo: string): number {
  const v = chave(o, k, campo);
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) throw new Error(`venda_sistema: ${campo}.${k} nao numerico`);
  return n;
}
function numOuNull(o: Record<string, unknown>, k: string, campo: string): number | null {
  const v = chave(o, k, campo);
  return v === null ? null : num(o, k, campo);
}
function texto(o: Record<string, unknown>, k: string, campo: string): string {
  const v = chave(o, k, campo);
  if (typeof v !== 'string' || v === '') throw new Error(`venda_sistema: ${campo}.${k} ausente`);
  return v;
}
function textoOuNull(o: Record<string, unknown>, k: string, campo: string): string | null {
  const v = chave(o, k, campo);
  if (v === null) return null;
  if (typeof v !== 'string') throw new Error(`venda_sistema: ${campo}.${k} malformado`);
  return v.trim() === '' ? null : v;
}
function umDe<T extends string>(o: Record<string, unknown>, k: string, campo: string, validos: readonly T[]): T {
  const v = texto(o, k, campo);
  if (!(validos as readonly string[]).includes(v)) throw new Error(`venda_sistema: ${campo}.${k} desconhecido (${v})`);
  return v as T;
}
function lista(v: unknown, campo: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`venda_sistema: ${campo} nao e lista`);
  return v;
}

const PAPEIS = ['catalisador', 'diluente'] as const;

function lerBoletim(v: unknown): BoletimPar | null {
  if (v === null) return null;
  const b = obj(v, 'boletim');
  const situacao = umDe(b, 'situacao', 'boletim', ['confere', 'outro', 'nao_cita', 'ambiguo'] as const);
  if (situacao === 'ambiguo') return { situacao, boletim: null, codigoCitado: null, proporcaoPct: null };
  return {
    situacao,
    boletim: textoOuNull(b, 'boletim', 'boletim'),
    codigoCitado: textoOuNull(b, 'codigo_citado', 'boletim'),
    proporcaoPct: numOuNull(b, 'proporcao_pct', 'boletim'),
  };
}

/** Lê `venda_sistema_fila`. Lança em forma desconhecida (fail-closed). */
export function lerFilaSistemas(raw: unknown): FilaSistemas {
  const r = obj(raw, 'fila');
  return {
    empresa: umDe(r, 'empresa', 'fila', EMPRESAS_SISTEMA),
    medidoEm: texto(r, 'medido_em', 'fila'),
    candidatos: lista(chave(r, 'candidatos', 'fila'), 'candidatos').map((x): CandidatoPar => {
      const c = obj(x, 'candidato');
      const base = obj(chave(c, 'base', 'candidato'), 'candidato.base');
      const par = obj(chave(c, 'par', 'candidato'), 'candidato.par');
      return {
        id: num(c, 'id', 'candidato'),
        status: umDe(c, 'status', 'candidato', ['pendente', 'nao_sei'] as const),
        papel: umDe(c, 'papel', 'candidato', PAPEIS),
        base: {
          omieCodigoProduto: num(base, 'omie_codigo_produto', 'base'),
          descricao: textoOuNull(base, 'descricao', 'base'),
          familia: textoOuNull(base, 'familia', 'base'),
          pedidos12m: num(base, 'pedidos_12m', 'base'),
          valor12m: numOuNull(base, 'valor_12m', 'base'),
        },
        par: {
          omieCodigoProduto: num(par, 'omie_codigo_produto', 'par'),
          descricao: textoOuNull(par, 'descricao', 'par'),
          familia: textoOuNull(par, 'familia', 'par'),
        },
        juntos: num(c, 'juntos', 'candidato'),
        share: num(c, 'share', 'candidato'),
        boletim: lerBoletim(chave(c, 'boletim', 'candidato')),
      };
    }),
    decididos: lista(chave(r, 'decididos', 'fila'), 'decididos').map((x): ParDecidido => {
      const d = obj(x, 'decidido');
      const base = obj(chave(d, 'base', 'decidido'), 'decidido.base');
      const par = obj(chave(d, 'par', 'decidido'), 'decidido.par');
      return {
        id: num(d, 'id', 'decidido'),
        status: umDe(d, 'status', 'decidido', ['confirmado', 'rejeitado'] as const),
        papel: umDe(d, 'papel', 'decidido', PAPEIS),
        decididoEm: textoOuNull(d, 'decidido_em', 'decidido'),
        base: { omieCodigoProduto: num(base, 'omie_codigo_produto', 'base'), descricao: textoOuNull(base, 'descricao', 'base') },
        par: { omieCodigoProduto: num(par, 'omie_codigo_produto', 'par'), descricao: textoOuNull(par, 'descricao', 'par') },
      };
    }),
  };
}

/** Lê `venda_sistema_sensor`. Lança em forma desconhecida (fail-closed). */
export function lerSensorSistemas(raw: unknown): SensorSistemas {
  const r = obj(raw, 'sensor');
  return {
    de: texto(r, 'de', 'sensor'),
    ate: texto(r, 'ate', 'sensor'),
    fila: lista(chave(r, 'fila', 'sensor'), 'sensor.fila').map((x) => {
      const f = obj(x, 'sensor.fila');
      return {
        empresa: texto(f, 'empresa', 'sensor.fila'),
        mostrados: num(f, 'mostrados', 'sensor.fila'),
        confirmados: num(f, 'confirmados', 'sensor.fila'),
        rejeitados: num(f, 'rejeitados', 'sensor.fila'),
        naoSei: num(f, 'nao_sei', 'sensor.fila'),
        pendentes: num(f, 'pendentes', 'sensor.fila'),
        taxaConfirmacao: numOuNull(f, 'taxa_confirmacao', 'sensor.fila'),
      };
    }),
    pedidos: lista(chave(r, 'pedidos', 'sensor'), 'sensor.pedidos').map((x) => {
      const p = obj(x, 'sensor.pedidos');
      return {
        braco: texto(p, 'braco', 'sensor.pedidos'),
        elegiveis: num(p, 'elegiveis', 'sensor.pedidos'),
        completos: num(p, 'completos', 'sensor.pedidos'),
        taxa: numOuNull(p, 'taxa', 'sensor.pedidos'),
      };
    }),
    sugestoes: lista(chave(r, 'sugestoes', 'sensor'), 'sensor.sugestoes').map((x) => {
      const s = obj(x, 'sensor.sugestoes');
      return {
        braco: texto(s, 'braco', 'sensor.sugestoes'),
        geradas: num(s, 'geradas', 'sensor.sugestoes'),
        mostradas: num(s, 'mostradas', 'sensor.sugestoes'),
        abertas: num(s, 'abertas', 'sensor.sugestoes'),
        viraram: num(s, 'viraram', 'sensor.sugestoes'),
        naoVirou: num(s, 'nao_virou', 'sensor.sugestoes'),
        naoMedivel: num(s, 'nao_medivel', 'sensor.sugestoes'),
        taxa: numOuNull(s, 'taxa', 'sensor.sugestoes'),
      };
    }),
  };
}

/** Soma os braços (o total do sensor). Taxa só com denominador > 0 — ausente ≠ zero. */
export function totalPedidos(p: SensorPedidos[]): { elegiveis: number; completos: number; taxa: number | null } {
  const elegiveis = p.reduce((a, x) => a + x.elegiveis, 0);
  const completos = p.reduce((a, x) => a + x.completos, 0);
  return { elegiveis, completos, taxa: elegiveis > 0 ? completos / elegiveis : null };
}

export const ROTULO_BOLETIM: Record<BoletimPar['situacao'], string> = {
  confere: 'boletim cita este par',
  outro: 'boletim cita outro código',
  nao_cita: 'boletim não cita este papel',
  ambiguo: 'mais de um boletim casa a base',
};
