import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Json } from '@/integrations/supabase/types';
import { registrarNoLedger, type EventoLedger } from '@/lib/analytics-ledger';
import type { SubmitErrorEntry } from '@/services/orderSubmission/types';

/**
 * Sensor do FUNIL do Novo Pedido (`/sales/new`) — rodada 3, onda 2 (PR 9.1).
 *
 * Mora no LEDGER (`analytics_outbox`, via `analytics_ledger_registrar`), não no PostHog: o PostHog
 * é bloqueado no navegador do founder e a censura correlaciona com perfil (fase-sem-sinal.md).
 *
 * Unidade = JORNADA: um id aleatório por pedido em montagem (nasce ao abrir a tela, renasce no
 * sucesso TOTAL e quando o cliente sai da tela — "Trocar e limpar", "Novo pedido"). Sobrevive a refresh (sessionStorage),
 * para o rascunho restaurado continuar a mesma jornada. Os eventos de envio levam o `checkout_id`
 * nas props — é a ponte com `sales_orders.checkout_id` (a verdade do servidor).
 *
 * O ledger DEDUPA por titular × evento × chave × dia UTC. Eventos de "uma vez por jornada" usam a
 * jornada como chave; os repetíveis (tentativa, IA) levam um sufixo sequencial.
 *
 * Nenhum id/nome/documento de cliente vai nas props — só enums e contagens.
 * Fail-open: telemetria nunca quebra a tela (registrarNoLedger engole e loga).
 */

export type EventoFunilPedido = Extract<EventoLedger, `novo_pedido.${string}`>;
export type ContaEnvio = 'oben' | 'colacor' | 'afiacao';
export type ClasseFalhaEnvio =
  | 'validacao_local'  // guarda da tela antes do envio (vendedor, prazo, dia vencido, cliente carregando)
  | 'conflito_envelope' // envio pendente de outro carrinho
  | 'validacao'        // validate_* do service (preço, identidade, vendabilidade, ATP no modo cliente)
  | 'gravacao'         // insert_* (linha local não gravou)
  | 'credito'
  | 'estoque'          // ATP
  | 'preco_tinta'
  | 'bloqueio_outro'
  | 'pv_divergente'
  | 'erp_pendente'     // sync_*_omie: sem confirmação do Omie
  | 'afiacao'          // OS de Afiação pede ação / aguarda
  | 'excecao'          // throw no caminho de envio
  | 'desconhecida';

/** Steps que impedem "confirmado" — o MESMO conjunto do `allConfirmed` de submitOrder.ts. */
function classeDoStep(step: string): ClasseFalhaEnvio | null {
  if (step.startsWith('validate')) return 'validacao';
  if (step.startsWith('insert_')) return 'gravacao';
  if (step.startsWith('bloqueio_credito_')) return 'credito';
  if (step.startsWith('bloqueio_atp_')) return 'estoque';
  if (step.startsWith('bloqueio_tint_')) return 'preco_tinta';
  if (step.startsWith('bloqueio_desconhecido_')) return 'bloqueio_outro';
  if (step.startsWith('pv_divergente_')) return 'pv_divergente';
  if (step === 'sync_oben_omie' || step === 'sync_colacor_omie') return 'erp_pendente';
  if (step === 'sync_os_omie' || step.startsWith('afiacao_') || step === 'aguardar_os_afiacao') return 'afiacao';
  return null; // aviso (create_production_order, aviso_os_afiacao_desatualizada…): não é falha do envio
}

function contaDoStep(step: string): ContaEnvio | null {
  if (step.endsWith('_oben') || step === 'sync_oben_omie') return 'oben';
  if (step.endsWith('_colacor') || step === 'sync_colacor_omie') return 'colacor';
  if (step === 'sync_os_omie' || step.startsWith('afiacao_') || step === 'aguardar_os_afiacao') return 'afiacao';
  return null;
}

export interface DesfechoEnvio {
  confirmadas: ContaEnvio[];
  falhas: ClasseFalhaEnvio[];
}

/**
 * Desfecho por conta de UM envio. Conta com itens é confirmada só se nenhum step bloqueante dela
 * apareceu. `success: false` (o service parou antes) não confirma NADA — e a classe vem do 1º erro;
 * sem erro algum é `desconhecida`, nunca um "sucesso" fabricado.
 */
export function classificarDesfechoEnvio(
  result: { success: boolean; errors: SubmitErrorEntry[] },
  contasComItens: Record<ContaEnvio, boolean>,
): DesfechoEnvio {
  const falhas = new Set<ClasseFalhaEnvio>();
  const contasComFalha = new Set<ContaEnvio>();
  let falhaSemConta = false;
  for (const e of result.errors) {
    const classe = classeDoStep(e.step);
    if (!classe) continue;
    falhas.add(classe);
    const conta = contaDoStep(e.step);
    if (conta) contasComFalha.add(conta);
    else falhaSemConta = true;
  }
  if (!result.success) {
    if (falhas.size === 0) falhas.add('desconhecida');
    return { confirmadas: [], falhas: [...falhas] };
  }
  // Falha que não se atribui a uma conta (validate_* depois do success? hoje não ocorre): não confirma nenhuma.
  const confirmadas = falhaSemConta
    ? []
    : (['oben', 'colacor', 'afiacao'] as const).filter(c => contasComItens[c] && !contasComFalha.has(c));
  return { confirmadas, falhas: [...falhas] };
}

const CHAVE_STORAGE = 'novo_pedido_jornada';

function novaJornadaId(): string {
  const id = crypto.randomUUID();
  try { sessionStorage.setItem(CHAVE_STORAGE, id); } catch { /* sem storage: jornada só em memória */ }
  return id;
}

function jornadaInicial(): string {
  try {
    const salva = sessionStorage.getItem(CHAVE_STORAGE);
    if (salva && /^[0-9a-f-]{36}$/i.test(salva)) return salva;
  } catch { /* segue */ }
  return novaJornadaId();
}

type Props = { [chave: string]: Json | undefined };

export interface SensorFunilPedido {
  jornada: string;
  /** Evento repetível: a chave ganha sufixo sequencial (o dedup não engole a 2ª ocorrência). */
  registrar: (evento: EventoFunilPedido, props?: Props) => void;
  /** Fecha a jornada atual e abre outra (sucesso total, "Novo pedido", troca de cliente). */
  novaJornada: () => void;
  envioTentado: (props: Props) => string;
  envioFalhou: (tentativa: string, classe: ClasseFalhaEnvio, props?: Props) => void;
  envioDesfecho: (
    tentativa: string,
    result: { success: boolean; errors: SubmitErrorEntry[]; allConfirmed: boolean },
    contasComItens: Record<ContaEnvio, boolean>,
    checkoutId: string,
  ) => void;
}

export function useSensorFunilPedido(opts: {
  modo: 'staff' | 'customer';
  clienteEscolhido: boolean;
  temItem: boolean;
}): SensorFunilPedido {
  const [jornada, setJornada] = useState(jornadaInicial);
  const jornadaRef = useRef(jornada);
  jornadaRef.current = jornada;
  const seqRef = useRef(0);
  const modoRef = useRef(opts.modo);
  modoRef.current = opts.modo;

  const emitir = useCallback((evento: EventoFunilPedido, chave: string, props: Props = {}) => {
    void registrarNoLedger(evento, chave, { modo: modoRef.current, jornada: jornadaRef.current, ...props });
  }, []);

  // Uma vez por jornada (a chave = jornada; o dedup do ledger cobre re-render e StrictMode).
  useEffect(() => { emitir('novo_pedido.iniciado', jornada); }, [emitir, jornada]);
  useEffect(() => {
    if (opts.clienteEscolhido) emitir('novo_pedido.cliente_escolhido', jornada);
  }, [emitir, jornada, opts.clienteEscolhido]);
  // Cliente saiu da tela ("Trocar e limpar", "Novo pedido") = o pedido anterior acabou: jornada nova.
  const clienteAntesRef = useRef(opts.clienteEscolhido);
  useEffect(() => {
    const antes = clienteAntesRef.current;
    clienteAntesRef.current = opts.clienteEscolhido;
    if (antes && !opts.clienteEscolhido) {
      seqRef.current = 0;
      setJornada(novaJornadaId());
    }
  }, [opts.clienteEscolhido]);
  useEffect(() => {
    if (opts.temItem) emitir('novo_pedido.primeiro_item', jornada);
  }, [emitir, jornada, opts.temItem]);

  const registrar = useCallback((evento: EventoFunilPedido, props: Props = {}) => {
    seqRef.current += 1;
    emitir(evento, `${jornadaRef.current}:${seqRef.current}`, props);
  }, [emitir]);

  const novaJornada = useCallback(() => {
    seqRef.current = 0;
    setJornada(novaJornadaId());
  }, []);

  const envioTentado = useCallback((props: Props) => {
    seqRef.current += 1;
    const tentativa = `${jornadaRef.current}:t${seqRef.current}`;
    emitir('novo_pedido.envio_tentado', tentativa, props);
    return tentativa;
  }, [emitir]);

  const envioFalhou = useCallback((tentativa: string, classe: ClasseFalhaEnvio, props: Props = {}) => {
    emitir('novo_pedido.envio_falhou', `${tentativa}:${classe}`, { classe, ...props });
  }, [emitir]);

  const envioDesfecho = useCallback<SensorFunilPedido['envioDesfecho']>((tentativa, result, contasComItens, checkoutId) => {
    const { confirmadas, falhas } = classificarDesfechoEnvio(result, contasComItens);
    for (const classe of falhas) emitir('novo_pedido.envio_falhou', `${tentativa}:${classe}`, { classe, checkout_id: checkoutId });
    // Por conta, uma vez por jornada: o reenvio que acha o PV "já enviado" não conta duas vezes.
    for (const conta of confirmadas) {
      emitir('novo_pedido.envio_confirmado', `${jornadaRef.current}:${conta}`, {
        conta, checkout_id: checkoutId, total: result.allConfirmed,
      });
    }
    if (result.success && result.allConfirmed) novaJornada();
  }, [emitir, novaJornada]);

  return useMemo(
    () => ({ jornada, registrar, novaJornada, envioTentado, envioFalhou, envioDesfecho }),
    [jornada, registrar, novaJornada, envioTentado, envioFalhou, envioDesfecho],
  );
}
