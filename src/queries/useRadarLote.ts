import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { track } from '@/lib/analytics';
import { mensagemDeErro } from '@/lib/erro-mensagem';
import type { RadarEmpresa } from '@/queries/useRadarLista';
import { depsCadastroSupabase } from '@/queries/useRadarAcoesLead';
import { cadastrarEmpresaNoOmie, ehThrottlingOmie, FalhaCadastro } from '@/lib/radar/cadastro-omie';
import { executarEmLote, resumirLote, CONCORRENCIA_LOTE, TETO_LOTE, type ResultadoItem } from '@/lib/radar/lote';
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

// Trava de execução POR USUÁRIO fora do React: sobrevive a unmount/remount da página (voltar
// e entrar de novo não pode disparar um 2º runner sobre o mesmo lote — P1 do review Codex).
const execucoesEmVoo = new Set<string>();

function gravarStorage(uid: string | null, lote: LotePersistido | null) {
  if (!uid || typeof localStorage === 'undefined') return;
  try {
    const k = chaveLotePersistido(uid);
    if (!lote || loteConcluido(lote)) localStorage.removeItem(k);
    else localStorage.setItem(k, serializarLote(lote));
  } catch {
    /* quota cheia: o estado em memória continua valendo */
  }
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

  const [lote, setLote] = useState<LotePersistido | null>(null);
  const loteRef = useRef<LotePersistido | null>(null);
  const [rodando, setRodando] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const snapshots = useRef<Map<string, RadarEmpresa>>(new Map());

  const gravar = useCallback((novo: LotePersistido | null) => {
    loteRef.current = novo;
    setLote(novo);
    gravarStorage(uid, novo);
  }, [uid]);

  // Carrega o lote persistido 1× por usuário.
  useEffect(() => {
    if (!uid || typeof localStorage === 'undefined') return;
    try {
      const salvo = parsearLote(localStorage.getItem(chaveLotePersistido(uid)));
      if (salvo && !loteConcluido(salvo)) { loteRef.current = salvo; setLote(salvo); }
    } catch {
      /* storage indisponível: segue sem retomada */
    }
    setRodando(execucoesEmVoo.has(uid));
  }, [uid]);

  // Desmontar a página PARA novos disparos (o item em voo termina e persiste pelo ref).
  useEffect(() => () => abortRef.current?.abort(), []);

  const atualizarItem = useCallback((cnpj: string, estado: EstadoItemLote) => {
    const atual = loteRef.current;
    if (!atual) return;
    gravar({ ...atual, itens: atual.itens.map((i) => (i.cnpj === cnpj ? { ...i, estado } : i)) });
  }, [gravar]);

  /** Lê do Radar as empresas sem snapshot. Devolve os CNPJs que NÃO conseguiu obter (e por quê). */
  const garantirSnapshots = useCallback(async (cnpjs: string[]): Promise<{ cnpj: string; erro: string }[]> => {
    const faltam = cnpjs.filter((c) => !snapshots.current.has(c));
    if (faltam.length === 0) return [];
    // `.in()` sobre a PK, delimitado pelo teto do lote (≤ 100): nunca pede "a tabela".
    const { data, error } = await supabase.from('radar_empresas').select('*').in('cnpj', faltam).range(0, TETO_LOTE - 1);
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
      setRodando(true);
      const ac = new AbortController();
      abortRef.current = ac;

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
                ? { retentativa: true }
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
            if (e instanceof FalhaCadastro) {
              atualizarItem(item.cnpj, { status: 'falha', etapa: e.etapa, erro: e.message, codigo: e.codigo });
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
        falhas: resumo.falhas + indisponiveis.size, nao_iniciados: resumo.cancelados, retomada,
        parou_por_throttling: resultados.some((r) => r.status === 'falha' && ehThrottlingOmie(new Error(r.erro))),
      });

      // Só agora o cache: a lista é paginada por offset — reiniciar da 1ª página evita pular
      // empresas quando as cadastradas saem da fila. KPIs/ranking só invalidam.
      await qc.resetQueries({ queryKey: ['radar', 'lista'] });
      qc.invalidateQueries({ queryKey: ['radar', 'kpis'] });
      qc.invalidateQueries({ queryKey: ['radar', 'contagem-municipios'] });
      qc.invalidateQueries({ queryKey: ['radar', 'contatos'] });
      abortRef.current = null;
      execucoesEmVoo.delete(uid);
      setRodando(false);
    },
    [uid, garantirSnapshots, atualizarItem, qc],
  );

  const temPendencias = !!lote && itensPendentes(lote).length > 0;

  /**
   * Inicia um lote NOVO. Recusa (false) se há lote rodando ou com pendências — o anterior
   * guarda códigos Omie já confirmados que uma substituição silenciosa perderia.
   */
  const iniciar = useCallback(
    (empresas: RadarEmpresa[]): boolean => {
      if (!uid || rodando || empresas.length === 0 || temPendencias) return false;
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

  /** Retoma o que não está ok (aguardando, falha, não iniciado) — sempre relendo o vínculo. */
  const retomar = useCallback(() => {
    const atual = loteRef.current;
    if (!atual || rodando) return;
    void executar(itensPendentes(atual), true);
  }, [rodando, executar]);

  /** Para novos disparos; o item em voo termina (não há como desfazer a chamada ao Omie). */
  const parar = useCallback(() => abortRef.current?.abort(), []);

  const esquecer = useCallback(() => {
    if (rodando) return;
    gravar(null);
    snapshots.current = new Map();
  }, [rodando, gravar]);

  const progresso = useMemo(() => {
    if (!lote) return null;
    const total = lote.itens.length;
    const aguardando = lote.itens.filter((i) => i.estado.status === 'aguardando').length;
    const ok = lote.itens.filter((i) => i.estado.status === 'ok').length;
    const falhas = lote.itens.filter((i) => i.estado.status === 'falha').length;
    const naoIniciados = lote.itens.filter((i) => i.estado.status === 'nao_iniciado').length;
    return { total, feitos: total - aguardando, ok, falhas, naoIniciados, aguardando, pendentes: total - ok };
  }, [lote]);

  return { lote, rodando, progresso, temPendencias, iniciar, retomar, parar, esquecer };
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
