import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { track } from '@/lib/analytics';
import { mensagemDeErro } from '@/lib/erro-mensagem';
import type { RadarEmpresa } from '@/queries/useRadarLista';
import { depsCadastroSupabase } from '@/queries/useRadarAcoesLead';
import { cadastrarEmpresaNoOmie, DivergenciaCadastro, ehThrottlingOmie, FalhaCadastro } from '@/lib/radar/cadastro-omie';
import { executarEmLote, resumirLote, CONCORRENCIA_LOTE, TETO_LOTE, type ResultadoItem } from '@/lib/radar/lote';
import { sqlstateDe } from '@/lib/radar/conflito-cadastro';
import { invalidarRadar } from '@/lib/radar/invalidar-cache';
import {
  chaveLotePersistido,
  divergentesNaoSincronizados,
  itensDivergentes,
  itensPendentes,
  loteConcluido,
  parsearLote,
  serializarLote,
  sincronizarDivergentes,
  type EstadoItemLote,
  type ItemLote,
  type LotePersistido,
} from '@/lib/radar/lote-persistido';

// Trava de execução POR USUÁRIO fora do React: sobrevive a unmount/remount da página (voltar
// e entrar de novo não pode disparar um 2º runner sobre o mesmo lote — P1 do review Codex).
const execucoesEmVoo = new Set<string>();

function gravarStorage(uid: string, lote: LotePersistido | null) {
  if (typeof localStorage === 'undefined') return;
  try {
    const k = chaveLotePersistido(uid);
    if (!lote || loteConcluido(lote)) localStorage.removeItem(k);
    else localStorage.setItem(k, serializarLote(lote));
  } catch {
    /* quota cheia: o estado em memória continua valendo */
  }
}

function lerStorage(uid: string): LotePersistido | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const salvo = parsearLote(localStorage.getItem(chaveLotePersistido(uid)));
    return salvo && !loteConcluido(salvo) ? salvo : null;
  } catch {
    return null; // storage indisponível: segue sem retomada
  }
}

/**
 * Estado do lote POR USUÁRIO, fora do React e OBSERVÁVEL (pacote A3). Antes cada instância do hook tinha o
 * próprio `useState`: o runner iniciado numa instância atualizava só ELA, e quem saía e voltava à tela durante
 * um lote ganhava uma instância nova presa em `aguardando`/`rodando` para sempre (o localStorage já dizia
 * ok/nao_iniciado) — a retomada ficava bloqueada. Agora o runner escreve aqui e TODA instância montada lê daqui.
 */
interface EstadoLoteUsuario {
  lote: LotePersistido | null;
  rodando: boolean;
  descartando: boolean;
}
const ESTADO_VAZIO: EstadoLoteUsuario = { lote: null, rodando: false, descartando: false };
const estados = new Map<string, EstadoLoteUsuario>();
const ouvintes = new Map<string, Set<() => void>>();
/** O controlador do runner em voo, por usuário: o "Parar" de uma instância remontada alcança o runner antigo. */
const controladores = new Map<string, AbortController>();

function estadoDe(uid: string): EstadoLoteUsuario {
  let e = estados.get(uid);
  if (!e) {
    e = { lote: lerStorage(uid), rodando: execucoesEmVoo.has(uid), descartando: false };
    estados.set(uid, e);
  }
  return e;
}

/** Escrita SÍNCRONA (o lote persiste a cada item, mesmo com a página desmontada) + aviso a quem observa. */
function escreverEstado(uid: string, patch: Partial<EstadoLoteUsuario>) {
  const novo = { ...estadoDe(uid), ...patch };
  estados.set(uid, novo);
  if ('lote' in patch) gravarStorage(uid, novo.lote);
  for (const f of ouvintes.get(uid) ?? []) f();
}

function assinar(uid: string, f: () => void) {
  let s = ouvintes.get(uid);
  if (!s) { s = new Set(); ouvintes.set(uid, s); }
  // 1º observador sem runner em voo: relê o localStorage (o "carrega o lote persistido" de cada montagem). Com o
  // runner em voo a memória É a verdade mais nova — reler o storage aqui não mudaria nada, mas a regra fica explícita.
  if (s.size === 0 && !execucoesEmVoo.has(uid)) estados.delete(uid);
  s.add(f);
  return () => { s?.delete(f); };
}

/**
 * Lote de cadastro no Omie (Oben), orquestrado NO CLIENTE.
 *
 * - Itens CONGELADOS no início (snapshot das empresas) — a lista pode mudar embaixo.
 * - Concorrência 1 e PARADA no primeiro throttling persistente do Omie (a edge já faz retry
 *   com backoff; insistir só alonga o bloqueio).
 * - Estado persistido no localStorage por usuário, gravado de forma SÍNCRONA a cada item
 *   (não via effect: continua gravando mesmo se a página desmontar com o lote em voo).
 * - Retomada: TODO item não-ok relê o vínculo no Radar antes de qualquer chamada; falha na
 *   gravação do Radar com código conhecido só repete a RPC.
 * - Cache do Radar invalidado SÓ ao final (não a cada item) — a paginação é por offset.
 * - Lote novo NÃO substitui um lote com pendências: o usuário resolve ou esquece o anterior.
 */
export function useRadarLoteOmie() {
  const { user } = useAuth();
  const uid = user?.id ?? null;
  const qc = useQueryClient();

  const subscribe = useCallback((f: () => void) => (uid ? assinar(uid, f) : () => {}), [uid]);
  const leitura = useCallback(() => (uid ? estadoDe(uid) : ESTADO_VAZIO), [uid]);
  const { lote, rodando, descartando } = useSyncExternalStore(subscribe, leitura, leitura);
  const snapshots = useRef<Map<string, RadarEmpresa>>(new Map());

  const loteAtual = useCallback(() => (uid ? estadoDe(uid).lote : null), [uid]);
  const gravar = useCallback((novo: LotePersistido | null) => {
    if (uid) escreverEstado(uid, { lote: novo });
  }, [uid]);

  // Desmontar a página PARA novos disparos (o item em voo termina e persiste pelo store).
  useEffect(() => () => { if (uid) controladores.get(uid)?.abort(); }, [uid]);

  const atualizarItem = useCallback((cnpj: string, estado: EstadoItemLote) => {
    const atual = loteAtual();
    if (!atual) return;
    gravar({ ...atual, itens: atual.itens.map((i) => (i.cnpj === cnpj ? { ...i, estado } : i)) });
  }, [loteAtual, gravar]);

  /** Lê do Radar as empresas sem snapshot. Devolve os CNPJs que NÃO conseguiu obter (e por quê). */
  const garantirSnapshots = useCallback(async (cnpjs: string[]): Promise<{ cnpj: string; erro: string }[]> => {
    const faltam = cnpjs.filter((c) => !snapshots.current.has(c));
    if (faltam.length === 0) return [];
    // `.in()` sobre a PK, delimitado pelo teto do lote (≤ 100): nunca pede "a tabela".
    const { data, error } = await supabase
      .from('radar_empresas')
      .select('*')
      .in('cnpj', faltam)
      .order('cnpj', { ascending: true }) // ordem estável junto do .range() (gate G7)
      .range(0, TETO_LOTE - 1);
    if (error) {
      const erro = `não consegui ler o lead no Radar: ${mensagemDeErro(error) ?? 'erro de leitura'}`;
      return faltam.map((cnpj) => ({ cnpj, erro }));
    }
    for (const e of (data ?? []) as RadarEmpresa[]) snapshots.current.set(e.cnpj, e);
    return faltam.filter((c) => !snapshots.current.has(c)).map((cnpj) => ({ cnpj, erro: 'lead não encontrado no Radar' }));
  }, []);

  const executar = useCallback(
    async (itens: ItemLote[], retomada: boolean) => {
      if (!uid || itens.length === 0 || execucoesEmVoo.has(uid)) return;
      execucoesEmVoo.add(uid);
      const ac = new AbortController();
      controladores.set(uid, ac);
      escreverEstado(uid, { rodando: true });

      // Quem precisa do snapshot: todo item que vai passar pela edge (sem código conhecido).
      const precisaSnapshot = (i: ItemLote) => !(i.estado.status === 'falha' && i.estado.etapa === 'radar' && i.estado.codigo);
      const semSnapshot = await garantirSnapshots(itens.filter(precisaSnapshot).map((i) => i.cnpj));
      const indisponiveis = new Map(semSnapshot.map((s) => [s.cnpj, s.erro]));
      for (const [cnpj, erro] of indisponiveis) atualizarItem(cnpj, { status: 'falha', etapa: 'omie', erro, codigo: null });
      const executaveis = itens.filter((i) => !indisponiveis.has(i.cnpj));

      const resultados = await executarEmLote(
        executaveis,
        async (item) => {
          const anterior = item.estado;
          const opcoes =
            anterior.status === 'falha' && anterior.etapa === 'radar' && anterior.codigo
              ? { codigoConhecido: anterior.codigo }
              : retomada
                ? { retentativa: true, ...(anterior.status === 'falha' && anterior.codigoVisto ? { codigoVisto: anterior.codigoVisto } : {}) }
                : {};
          try {
            const empresa = snapshots.current.get(item.cnpj);
            if (!empresa && !opcoes.codigoConhecido) throw new FalhaCadastro('omie', 'lead não encontrado no Radar');
            const r = await cadastrarEmpresaNoOmie(
              empresa ?? ({ cnpj: item.cnpj } as RadarEmpresa),
              depsCadastroSupabase,
              opcoes,
            );
            atualizarItem(item.cnpj, { status: 'ok', ...r });
            return r;
          } catch (e) {
            if (e instanceof DivergenciaCadastro) {
              atualizarItem(item.cnpj, { status: 'divergente', motivo: e.motivo, erro: e.message, codigo: e.codigoRecebido, conflitoId: e.conflito?.id ?? null });
            } else if (e instanceof FalhaCadastro) {
              atualizarItem(item.cnpj, { status: 'falha', etapa: e.etapa, erro: e.message, codigo: e.codigo, codigoVisto: e.codigoVisto });
            } else {
              atualizarItem(item.cnpj, { status: 'falha', etapa: 'omie', erro: mensagemDeErro(e) ?? 'falha desconhecida', codigo: null });
            }
            throw e;
          }
        },
        { concorrencia: CONCORRENCIA_LOTE, signal: ac.signal, pararEm: ehThrottlingOmie },
      );

      // Não iniciados: só quem ainda estava 'aguardando' muda de estado — uma falha anterior
      // (com código Omie confirmado, por exemplo) NÃO pode ser apagada por 'nao_iniciado'.
      for (const r of resultados) {
        if (r.status === 'cancelado' && r.item.estado.status === 'aguardando') atualizarItem(r.item.cnpj, { status: 'nao_iniciado' });
      }

      const resumo = resumirLote(resultados as ResultadoItem<ItemLote, { jaExistia: boolean }>[], (v) => v.jaExistia);
      track('radar.lote_cadastrado_omie', {
        total: itens.length, criados: resumo.criados, ja_existiam: resumo.ja_existiam,
        falhas: resumo.falhas + indisponiveis.size,
        divergentes_no_lote: loteAtual() ? itensDivergentes(loteAtual() as LotePersistido).length : 0, nao_iniciados: resumo.cancelados, retomada,
        parou_por_throttling: resultados.some((r) => r.status === 'falha' && ehThrottlingOmie(new Error(r.erro))),
      });

      // Só agora o cache: a lista é paginada por offset — reiniciar da 1ª página evita pular
      // empresas quando as cadastradas saem da fila. O resto (amostra, KPIs, sugeridos, mapa…) só invalida.
      try {
        await invalidarRadar(qc, { reiniciarLista: true });
      } finally {
        if (controladores.get(uid) === ac) controladores.delete(uid);
        execucoesEmVoo.delete(uid);
        escreverEstado(uid, { rodando: false });
      }
    },
    [uid, garantirSnapshots, atualizarItem, loteAtual, qc],
  );

  // Conflito de vínculo também segura o lote (não é retentável, mas só sai por "Esquecer lote").
  const temPendencias = !!lote && !loteConcluido(lote);

  /**
   * Inicia um lote NOVO. Recusa (false) se há lote rodando ou com pendências — o anterior
   * guarda códigos Omie já confirmados que uma substituição silenciosa perderia.
   */
  const iniciar = useCallback(
    (empresas: RadarEmpresa[]): boolean => {
      if (!uid || rodando || empresas.length === 0 || temPendencias || execucoesEmVoo.has(uid)) return false;
      snapshots.current = new Map(empresas.map((e) => [e.cnpj, e]));
      const itens: ItemLote[] = empresas.map((e) => ({
        cnpj: e.cnpj,
        nome: e.nome_fantasia || e.razao_social || e.cnpj,
        estado: { status: 'aguardando' },
      }));
      gravar({ v: 1, iniciadoEm: new Date().toISOString(), itens });
      void executar(itens, false);
      return true;
    },
    [uid, rodando, temPendencias, gravar, executar],
  );

  /** Retoma o que não está ok nem em conflito (aguardando, falha, não iniciado) — sempre relendo o vínculo. */
  const retomar = useCallback(() => {
    const atual = loteAtual();
    if (!atual || rodando || descartando) return;
    void executar(itensPendentes(atual), true);
  }, [rodando, descartando, loteAtual, executar]);

  /** Para novos disparos; o item em voo termina (não há como desfazer a chamada ao Omie). */
  const parar = useCallback(() => { if (uid) controladores.get(uid)?.abort(); }, [uid]);

  /**
   * Esquece o lote — mas antes envia ao servidor os conflitos que só esta aba conhece. Se algum não subir, o lote
   * FICA (devolve as falhas): apagá-lo perderia a única evidência. Resolver um conflito é na ficha, não aqui.
   */
  const esquecer = useCallback(async (): Promise<{ esquecido: boolean; falhas: { cnpj: string; erro: string }[] }> => {
    const atual = loteAtual();
    // A MESMA trava do runner (por usuário, fora do React) cobre o descarte INTEIRO: sem ela, uma retomada no meio
    // da sincronização registraria outro conflito local que o `gravar(null)` do fim apagaria (Codex, código P1).
    if (!uid || rodando || !atual || execucoesEmVoo.has(uid)) return { esquecido: false, falhas: [] };
    execucoesEmVoo.add(uid);
    escreverEstado(uid, { descartando: true });
    try {
      if (divergentesNaoSincronizados(atual).length > 0) {
        const r = await sincronizarDivergentes(atual, depsCadastroSupabase.registrarConflito, (e) => sqlstateDe(e) === 'RD003');
        qc.invalidateQueries({ queryKey: ['radar', 'conflitos-cadastro'] });
        if (r.falhas.length > 0) {
          gravar(r.lote);
          return { esquecido: false, falhas: r.falhas };
        }
      }
      gravar(null);
      snapshots.current = new Map();
      return { esquecido: true, falhas: [] };
    } finally {
      execucoesEmVoo.delete(uid);
      escreverEstado(uid, { descartando: false });
    }
  }, [uid, rodando, loteAtual, gravar, qc]);

  const progresso = useMemo(() => {
    if (!lote) return null;
    const total = lote.itens.length;
    const aguardando = lote.itens.filter((i) => i.estado.status === 'aguardando').length;
    const ok = lote.itens.filter((i) => i.estado.status === 'ok').length;
    const falhas = lote.itens.filter((i) => i.estado.status === 'falha').length;
    const naoIniciados = lote.itens.filter((i) => i.estado.status === 'nao_iniciado').length;
    const divergentes = itensDivergentes(lote).length;
    return {
      total, feitos: total - aguardando, ok, falhas, naoIniciados, aguardando, divergentes,
      naoSincronizados: divergentesNaoSincronizados(lote).length,
      pendentes: itensPendentes(lote).length, concluido: loteConcluido(lote),
    };
  }, [lote]);

  return { lote, rodando, descartando, progresso, temPendencias, iniciar, retomar, parar, esquecer };
}

/**
 * Ação simples em lote (descartar / criar tarefa): só RPC, sem ERP. Continua nos erros e
 * devolve o resumo; a UI mostra toast + quais falharam. Sem retry automático de tarefa
 * (a dedupe da RPC é de 2 min — repetir tarde cria duplicata).
 */
export function useRadarAcaoEmLote() {
  const qc = useQueryClient();
  const [rodando, setRodando] = useState(false);
  const executar = useCallback(
    async <R,>(cnpjs: string[], fn: (cnpj: string) => Promise<R>, evento: string) => {
      setRodando(true);
      try {
        const resultados = await executarEmLote(cnpjs, fn, { concorrencia: 2 });
        const falhas = resultados.filter((r) => r.status === 'falha') as Array<{ item: string; status: 'falha'; erro: string }>;
        track(evento, { total: cnpjs.length, ok: resultados.length - falhas.length, falhas: falhas.length });
        // Descarte em lote: a amostra entra na invalidação (o lead de controle descartado saía da fila só no F5).
        await invalidarRadar(qc, { reiniciarLista: true });
        return { ok: resultados.length - falhas.length, falhas };
      } finally {
        setRodando(false);
      }
    },
    [qc],
  );
  return { executar, rodando };
}
