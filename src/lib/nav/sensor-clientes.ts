// Sensor de uso da tela Clientes (/admin/customers) — PostHog (`track`) + ledger autenticado.
//
// Por quê: a fase seguinte da tela (atalhos "Em risco" / "Primeira compra") só sai com SINAL positivo e
// denominador (docs/historico/fase-sem-sinal.md). O PostHog é censurado no Chrome do founder, então o
// sinal que decide nasce no ledger (`registrarNoLedger`); o `track` fica como conveniência de frequência.
// Leitura: db/sensor-clientes-adocao.sql (via psql-ro), com o denominador por papel.
//
// LGPD: o payload é FECHADO por tipo e só leva enums e inteiros. Nenhum id, nome, documento, telefone ou
// termo de busca do cliente sai daqui — nem na chave de dedup. A posição do clique é o que identifica a
// linha, e ela não aponta para ninguém fora daquela sessão.
//
// Dedup: o ledger grava 1 linha por titular × evento × chave × dia UTC. As chaves abaixo são escolhidas
// para que a contagem responda "quem usou e com qual valor", e para caber no teto de 500 linhas/dia.
import { track } from '@/lib/analytics';
import { registrarNoLedger, type EventoLedger } from '@/lib/analytics-ledger';
import { isLensActive } from '@/lib/impersonation/lens-write-guard';

/**
 * Modo ativo da lista: as duas ordens da base completa e as duas da carteira. Até a onda 1 a carteira
 * era sempre A–Z e gravava `carteira`; agora ela ordena e grava `carteira_prioridade`/`carteira_nome`
 * — é esse o sinal que mede se a VENDEDORA usa a priorização (antes só o gestor tinha a ordem).
 */
export type ModoClientes = 'prioridade' | 'nome' | 'carteira_prioridade' | 'carteira_nome';

export function modoClientes(isCarteira: boolean, ordem: 'prioridade' | 'nome'): ModoClientes {
  if (!isCarteira) return ordem;
  return ordem === 'nome' ? 'carteira_nome' : 'carteira_prioridade';
}

/**
 * De qual SUPERFÍCIE saiu a ação: a linha da lista (onda C), o cadastro (/admin/customers/:id) ou a 360.
 * O nome do campo segue `ficha` por compatibilidade com o que o ledger já guardou.
 */
export type FichaClientes = 'lista' | 'cadastro' | '360';
/**
 * Ações medidas. `abrir_cadastro` = a 360 abriu o Cadastro e ferramentas (emissor em IdentityColumn).
 * `whatsapp` sai do app (wa.me): só existe a tentativa.
 */
export type AcaoFicha =
  | 'ligar' | 'whatsapp' | 'novo_pedido' | 'abrir_360' | 'ver_pedidos' | 'registrar_desfecho' | 'criar_tarefa' | 'abrir_cadastro';
/**
 * Onda C: tentativa (o toque) e sucesso (o resultado confirmado) são eventos SEPARADOS. Ligar: atendida
 * (fim com duração > 0). Novo pedido: pedido enviado. Ver pedidos: o feed do cliente lido. Desfecho:
 * só a gravação confirmada pelo servidor (nunca o clique). O resto é navegação: só tentativa.
 */
export type FaseAcao = 'tentativa' | 'sucesso';

const FILTROS_SAUDE = ['all', 'saudavel', 'estavel', 'atencao', 'critico', 'sem_historico'] as const;
export type FiltroSaudeSensor = (typeof FILTROS_SAUDE)[number] | 'outro';

/** A URL é editável à mão: valor fora do enum vira 'outro', nunca texto livre no payload. */
export function normalizarFiltroSensor(valor: string | null | undefined): FiltroSaudeSensor {
  const v = valor ?? 'all';
  return (FILTROS_SAUDE as readonly string[]).includes(v) ? (v as FiltroSaudeSensor) : 'outro';
}

/** Inteiro positivo seguro para o payload (posição 1-based, página); qualquer outra coisa → null. */
function inteiroPositivo(n: number): number | null {
  return Number.isInteger(n) && n > 0 && n <= 1_000_000 ? n : null;
}

export type UsoClientes =
  | { acao: 'lista_aberta'; modo: ModoClientes }
  | { acao: 'modo_trocado'; de: ModoClientes; para: ModoClientes; origem: 'menu' | 'cabecalho' }
  | { acao: 'filtro_saude'; modo: ModoClientes; valor: string }
  | { acao: 'busca_usada'; modo: ModoClientes }
  | { acao: 'cliente_aberto'; modo: ModoClientes; posicao: number; filtroSaude: string; comBusca: boolean }
  | { acao: 'pagina_carregada'; modo: ModoClientes; pagina: number }
  | { acao: 'ficha_acao'; ficha: FichaClientes; tipo: AcaoFicha; fase?: FaseAcao };

export interface EventoClientes {
  evento: EventoLedger & `clientes.${string}`;
  /** Chave de dedup do ledger (≤100 chars; só enums e inteiros). */
  chave: string;
  props: Record<string, string | number | boolean | null>;
}

/** Monta evento, chave e payload — função PURA (é o que o teste trava contra PII). */
export function montarEventoClientes(uso: UsoClientes): EventoClientes {
  switch (uso.acao) {
    case 'lista_aberta':
      return { evento: 'clientes.lista_aberta', chave: uso.modo, props: { modo: uso.modo } };
    case 'modo_trocado':
      return {
        evento: 'clientes.modo_trocado',
        chave: `${uso.de}>${uso.para}`,
        props: { de: uso.de, para: uso.para, origem: uso.origem },
      };
    case 'filtro_saude': {
      const valor = normalizarFiltroSensor(uso.valor);
      return { evento: 'clientes.filtro_saude', chave: `${uso.modo}:${valor}`, props: { modo: uso.modo, valor } };
    }
    case 'busca_usada':
      return { evento: 'clientes.busca_usada', chave: uso.modo, props: { modo: uso.modo } };
    case 'cliente_aberto': {
      const posicao = inteiroPositivo(uso.posicao);
      const filtro = normalizarFiltroSensor(uso.filtroSaude);
      return {
        evento: 'clientes.cliente_aberto',
        chave: `${uso.modo}:${filtro}:${uso.comBusca ? 'b' : 's'}:${posicao ?? 'x'}`,
        props: { modo: uso.modo, posicao, filtro_saude: filtro, com_busca: uso.comBusca },
      };
    }
    case 'pagina_carregada': {
      const pagina = inteiroPositivo(uso.pagina);
      return {
        evento: 'clientes.pagina_carregada',
        chave: `${uso.modo}:${pagina ?? 'x'}`,
        props: { modo: uso.modo, pagina },
      };
    }
    case 'ficha_acao':
      // Sem id do cliente: a contagem responde "quem age a partir da ficha, e como" — não "com quem".
      // Sem `fase` = tentativa (os emissores de antes da onda C só mediam o toque).
      return {
        evento: 'clientes.ficha_acao',
        chave: `${uso.ficha}:${uso.tipo}:${uso.fase ?? 'tentativa'}`,
        props: { ficha: uso.ficha, tipo: uso.tipo, fase: uso.fase ?? 'tentativa' },
      };
  }
}

/**
 * Registra o uso nos DOIS canais. Fail-open (o ledger nunca lança). Sob a lente "Ver como" não registra
 * em nenhum: a inspeção do master inflaria o denominador com atividade que não é de quem usa.
 */
export function registrarUsoClientes(uso: UsoClientes): void {
  if (isLensActive()) return;
  const { evento, chave, props } = montarEventoClientes(uso);
  track(evento, props);
  void registrarNoLedger(evento, chave, props);
}

// ─── Sucesso medido no DESTINO (onda C) ──────────────────────────────────────────────────────────
// "Novo pedido" e "Ver pedidos" navegam: quem sabe se deu certo é a tela de destino. A ação deixa no
// `location.state` de qual superfície veio; o destino emite o sucesso quando o resultado se confirma.

const FICHAS: readonly FichaClientes[] = ['lista', 'cadastro', '360'];
const ACOES_COM_DESTINO = ['novo_pedido', 'ver_pedidos'] as const;
type AcaoComDestino = (typeof ACOES_COM_DESTINO)[number];

export interface SensorDestino {
  ficha: FichaClientes;
  tipo: AcaoComDestino;
}

/** `location.state` (parcial) que leva a origem do sensor ao destino. */
export function estadoSensorDestino(ficha: FichaClientes, tipo: AcaoComDestino): { sensorClientes: SensorDestino } {
  return { sensorClientes: { ficha, tipo } };
}

/** Lê a origem do sensor do `location.state` (`unknown`); formato fora do enum → `null`. */
export function lerSensorDestino(state: unknown): SensorDestino | null {
  if (state == null || typeof state !== 'object') return null;
  const v = (state as { sensorClientes?: unknown }).sensorClientes;
  if (v == null || typeof v !== 'object') return null;
  const { ficha, tipo } = v as { ficha?: unknown; tipo?: unknown };
  if (!FICHAS.includes(ficha as FichaClientes)) return null;
  if (!(ACOES_COM_DESTINO as readonly string[]).includes(tipo as string)) return null;
  return { ficha: ficha as FichaClientes, tipo: tipo as AcaoComDestino };
}

/** Emite o sucesso de uma ação que veio de uma superfície de Clientes (se veio de uma). */
export function registrarSucessoNoDestino(state: unknown, tipo: AcaoComDestino): boolean {
  const origem = lerSensorDestino(state);
  if (!origem || origem.tipo !== tipo) return false;
  registrarUsoClientes({ acao: 'ficha_acao', ficha: origem.ficha, tipo, fase: 'sucesso' });
  return true;
}

/** Ligação encerrada por um botão de Clientes: atendida (durou) vira sucesso; o resto não emite. */
export function registrarFimDaLigacao(ficha: FichaClientes, fim: { duration: number; state: string }): void {
  if (fim.state === 'finished' && fim.duration > 0) {
    registrarUsoClientes({ acao: 'ficha_acao', ficha, tipo: 'ligar', fase: 'sucesso' });
  }
}
