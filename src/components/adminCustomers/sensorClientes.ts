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

/** Modo ativo da lista: as duas ordens da base completa, ou a carteira (sempre A–Z, sem controle). */
export type ModoClientes = 'prioridade' | 'nome' | 'carteira';

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
  | { acao: 'pagina_carregada'; modo: ModoClientes; pagina: number };

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
