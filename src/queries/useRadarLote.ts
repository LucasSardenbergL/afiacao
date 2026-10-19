import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { track } from '@/lib/analytics';
import type { RadarEmpresa } from '@/queries/useRadarLista';
import { depsCadastroSupabase } from '@/queries/useRadarAcoesLead';
import { cadastrarEmpresaNoOmie, ehThrottlingOmie, FalhaCadastro } from '@/lib/radar/cadastro-omie';
import { executarEmLote, resumirLote, CONCORRENCIA_LOTE, type ResultadoItem } from '@/lib/radar/lote';
import {
  chaveLotePersistido,
  itensPendentes,
  loteConcluido,
  parsearLote,
  serializarLote,
  type EstadoItemLote,
  type ItemLote,
  type LotePersistido,
} from '@/lib/radar/lote-persistido';

/**
 * Lote de cadastro no Omie (Oben), orquestrado NO CLIENTE.
 *
 * - Itens CONGELADOS no início (snapshot das empresas) — a lista pode mudar embaixo.
 * - Concorrência 1 e PARADA no primeiro throttling persistente do Omie (a edge já faz retry
 *   com backoff; insistir só alonga o bloqueio).
 * - Estado persistido no localStorage por usuário: fechar a aba perde a execução, não os
 *   efeitos; na volta, a tela oferece RETOMAR o que ficou pendente/indeterminado.
 * - Retry por ETAPA: falha na gravação do Radar com código conhecido só repete a RPC
 *   (relendo o vínculo antes); falha no Omie repete a edge (anti-dup pelo CNPJ).
 * - Cache do Radar invalidado SÓ ao final (não a cada item) — a paginação é por offset.
 */
export function useRadarLoteOmie() {
  const { user } = useAuth();
  const uid = user?.id ?? null;
  const qc = useQueryClient();

  const [lote, setLote] = useState<LotePersistido | null>(null);
  const [rodando, setRodando] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const snapshots = useRef<Map<string, RadarEmpresa>>(new Map());

  // Carrega o lote persistido 1× por usuário.
  useEffect(() => {
    if (!uid || typeof localStorage === 'undefined') return;
    try {
      const salvo = parsearLote(localStorage.getItem(chaveLotePersistido(uid)));
      if (salvo && !loteConcluido(salvo)) setLote(salvo);
    } catch {
      /* storage indisponível: segue sem retomada */
    }
  }, [uid]);

  // Persiste a cada mudança (remove quando esquecido ou concluído).
  useEffect(() => {
    if (!uid || typeof localStorage === 'undefined') return;
    try {
      const k = chaveLotePersistido(uid);
      if (!lote || loteConcluido(lote)) localStorage.removeItem(k);
      else localStorage.setItem(k, serializarLote(lote));
    } catch {
      /* quota cheia: o estado em memória continua valendo */
    }
  }, [lote, uid]);

  const atualizarItem = useCallback((cnpj: string, estado: EstadoItemLote) => {
    setLote((l) => (l ? { ...l, itens: l.itens.map((i) => (i.cnpj === cnpj ? { ...i, estado } : i)) } : l));
  }, []);

  const garantirSnapshots = useCallback(async (cnpjs: string[]) => {
    const faltam = cnpjs.filter((c) => !snapshots.current.has(c));
    if (faltam.length === 0) return;
    const { data, error } = await supabase.from('radar_empresas').select('*').in('cnpj', faltam);
    if (error) throw error;
    for (const e of (data ?? []) as RadarEmpresa[]) snapshots.current.set(e.cnpj, e);
  }, []);

  const executar = useCallback(
    async (itens: ItemLote[]) => {
      if (itens.length === 0 || rodando) return;
      setRodando(true);
      const ac = new AbortController();
      abortRef.current = ac;
      try {
        await garantirSnapshots(itens.filter((i) => !(i.estado.status === 'falha' && i.estado.codigo)).map((i) => i.cnpj));
      } catch (e) {
        // Sem os dados do lead não dá para montar o payload: marca a falha, não inventa.
        const msg = e instanceof Error ? e.message : 'não consegui ler os leads';
        for (const i of itens) atualizarItem(i.cnpj, { status: 'falha', etapa: 'omie', erro: msg, codigo: null });
        setRodando(false);
        return;
      }

      const resultados = await executarEmLote(
        itens,
        async (item) => {
          const anterior = item.estado;
          const opcoes =
            anterior.status === 'falha' && anterior.etapa === 'radar' && anterior.codigo
              ? { codigoConhecido: anterior.codigo }
              : anterior.status === 'falha' || anterior.status === 'cancelado'
                ? { retentativa: true }
                : {};
          const empresa = snapshots.current.get(item.cnpj);
          if (!empresa && !opcoes.codigoConhecido) throw new FalhaCadastro('omie', 'lead não encontrado no Radar');
          try {
            const r = await cadastrarEmpresaNoOmie(
              empresa ?? ({ cnpj: item.cnpj } as RadarEmpresa),
              depsCadastroSupabase,
              opcoes,
            );
            atualizarItem(item.cnpj, { status: 'ok', ...r });
            return r;
          } catch (e) {
            if (e instanceof FalhaCadastro) {
              atualizarItem(item.cnpj, { status: 'falha', etapa: e.etapa, erro: e.message, codigo: e.codigo });
            } else {
              atualizarItem(item.cnpj, { status: 'falha', etapa: 'omie', erro: e instanceof Error ? e.message : String(e), codigo: null });
            }
            throw e;
          }
        },
        { concorrencia: CONCORRENCIA_LOTE, signal: ac.signal, pararEm: ehThrottlingOmie },
      );

      for (const r of resultados) if (r.status === 'cancelado') atualizarItem(r.item.cnpj, { status: 'cancelado' });

      const resumo = resumirLote(resultados as ResultadoItem<ItemLote, { jaExistia: boolean }>[], (v) => v.jaExistia);
      track('radar.lote_cadastrado_omie', {
        total: resumo.total, criados: resumo.criados, ja_existiam: resumo.ja_existiam,
        falhas: resumo.falhas, cancelados: resumo.cancelados,
        parou_por_throttling: resultados.some((r) => r.status === 'falha' && /OMIE_TRANSIENT|rate.?limit/i.test(r.erro)),
      });

      // Só agora o cache: a lista é paginada por offset — reiniciar da 1ª página evita pular
      // empresas quando as cadastradas saem da fila. KPIs/ranking só invalidam.
      await qc.resetQueries({ queryKey: ['radar', 'lista'] });
      qc.invalidateQueries({ queryKey: ['radar', 'kpis'] });
      qc.invalidateQueries({ queryKey: ['radar', 'contagem-municipios'] });
      qc.invalidateQueries({ queryKey: ['radar', 'contatos'] });
      abortRef.current = null;
      setRodando(false);
    },
    [rodando, garantirSnapshots, atualizarItem, qc],
  );

  /** Inicia um lote NOVO com as empresas selecionadas (substitui lote anterior esquecido). */
  const iniciar = useCallback(
    (empresas: RadarEmpresa[]) => {
      if (rodando || empresas.length === 0) return;
      snapshots.current = new Map(empresas.map((e) => [e.cnpj, e]));
      const itens: ItemLote[] = empresas.map((e) => ({
        cnpj: e.cnpj,
        nome: e.nome_fantasia || e.razao_social || e.cnpj,
        estado: { status: 'pendente' },
      }));
      setLote({ v: 1, iniciadoEm: new Date().toISOString(), itens });
      void executar(itens);
    },
    [rodando, executar],
  );

  /** Retoma o que não está ok (pendente, falha, cancelado). */
  const retomar = useCallback(() => {
    if (!lote || rodando) return;
    void executar(itensPendentes(lote));
  }, [lote, rodando, executar]);

  /** Para novos disparos; o item em voo termina (não há como desfazer a chamada ao Omie). */
  const parar = useCallback(() => abortRef.current?.abort(), []);

  const esquecer = useCallback(() => {
    if (rodando) return;
    setLote(null);
    snapshots.current = new Map();
  }, [rodando]);

  const progresso = useMemo(() => {
    if (!lote) return null;
    const total = lote.itens.length;
    const feitos = lote.itens.filter((i) => i.estado.status !== 'pendente').length;
    const ok = lote.itens.filter((i) => i.estado.status === 'ok').length;
    const falhas = lote.itens.filter((i) => i.estado.status === 'falha').length;
    const cancelados = lote.itens.filter((i) => i.estado.status === 'cancelado').length;
    return { total, feitos, ok, falhas, cancelados, pendentes: total - feitos };
  }, [lote]);

  return { lote, rodando, progresso, iniciar, retomar, parar, esquecer };
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
        await qc.resetQueries({ queryKey: ['radar', 'lista'] });
        qc.invalidateQueries({ queryKey: ['radar', 'kpis'] });
        qc.invalidateQueries({ queryKey: ['radar', 'contagem-municipios'] });
        return { ok: resultados.length - falhas.length, falhas };
      } finally {
        setRodando(false);
      }
    },
    [qc],
  );
  return { executar, rodando };
}
