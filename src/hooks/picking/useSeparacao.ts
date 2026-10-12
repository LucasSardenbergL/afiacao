// Separação v2 de UMA tarefa: leitor → previsão local → fila durável (motor da aba) → servidor
// (autoridade). Contratos (Codex Fase 1):
//   - o som de acerto só sai DEPOIS do commit da leitura no IndexedDB;
//   - a captura para quando a tarefa não autoriza trabalho (status, atribuição, revisão, ausente),
//     sob a lente "Ver como", durante as barreiras de concluir/falta e depois de qualquer resposta
//     do servidor que retire a autorização;
//   - concluir e marcar falta: barreira (captura parada + trava da tarefa entre abas) → drena a
//     fila → RELÊ o armazém → RPC. Leitura não recebida nunca fica de fora do concluir;
//   - a barreira AVANÇA a época da tarefa (motor-fila): captura de outra aba que esperou a trava
//     atravessando a barreira é recusada, e a aba que vê a época mudar só volta a capturar depois
//     de reler a tarefa — a mesma regra vale no mount (retrato do localStorage não autoriza nada).
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useImpersonation } from "@/contexts/ImpersonationContext";
import { track } from "@/lib/analytics";
import { criarTocador, feedbackDoMotivo, type TipoFeedback } from "@/lib/picking/feedback";
import { supabase } from "@/integrations/supabase/client";
import { isLensActive } from "@/lib/impersonation/lens-write-guard";
import { quantidadeRepresentavel } from "@/lib/picking/decimal";
import { type AtribuicaoLocal, bloqueioDaTarefa } from "@/lib/picking/autorizacao";
import { abrirBarreira, comTrava, criarMotor, ehChaveEpoca, fecharBarreira, lerEpoca, type Motor, travaDaTarefa } from "@/lib/picking/motor-fila";
import { linhaAtual, progressoLocal, tudoSeparado } from "@/lib/picking/progresso-local";
import { abrirArmazemIndexedDB, type ItemFila, leiturasDaAtribuicao, MOTIVOS_PERDA_DE_AUTORIZACAO } from "@/lib/picking/scanner/fila";
import type { Saida } from "@/lib/picking/scanner/protocolo";
import { type CodigoCadastrado, preverBipe, preverManual, type Previsao } from "@/lib/picking/validacao-local";
import {
  concluirTarefa,
  enviarLeitura,
  lerCodigos,
  lerLeituras,
  lerLinhas,
  lerTarefa,
  marcarFalta,
  type TarefaV2,
} from "@/lib/picking/v2-api";
import { useScanner } from "./useScanner";

/** Um tocador por aba: o AudioContext precisa de um gesto para destravar e não deve se repetir. */
const tocador = criarTocador();
export const destravarSom = () => tocador.destravar();

let motorDaAba: Motor | null = null;
/** O motor da fila desta aba (criado no 1º uso; vive enquanto a aba vive). */
function motor(): Motor {
  if (motorDaAba) return motorDaAba;
  motorDaAba = criarMotor(enviarLeitura, abrirArmazemIndexedDB, (resolvidos) => {
    for (const it of resolvidos) {
      track("picking.leitura", {
        tipo: it.comando.tipo,
        aceita: it.estado === "aceita",
        motivo: it.motivo ?? "nenhum",
        previsao_divergiu: it.divergente_nao_visto,
        tentativas: it.tentativas,
      });
    }
    if (resolvidos.some((i) => i.divergente_nao_visto)) tocador.tocar("divergencia");
  }, {
    // Identidade e lente lidas NA HORA do envio — não dependem de página montada (Codex r2).
    sessao: async () => (await supabase.auth.getSession()).data.session?.user.id ?? null,
    lente: isLensActive,
  });
  const m = motorDaAba;
  supabase.auth.onAuthStateChange(() => m.cutucar());
  return m;
}

/** Estado do motor (fila inteira da aba), reativo. Mudar usuário/lente só CUTUCA: o motor relê sozinho. */
export function useMotorFila() {
  const { user } = useAuth();
  const { isImpersonating } = useImpersonation();
  const m = motor();
  useEffect(() => {
    m.cutucar();
  }, [m, user?.id, isImpersonating]);
  const estado = useSyncExternalStore(m.assinar, m.estado);
  return { m, estado, operador: user?.id ?? null, lente: isImpersonating };
}

export type Atribuicao = AtribuicaoLocal;

export interface UltimoFeedback {
  tipo: TipoFeedback;
  texto: string;
  em: number;
}

export function useSeparacao(tarefaInicial: TarefaV2, atribuicao: Atribuicao) {
  const qc = useQueryClient();
  const { m, estado, operador, lente } = useMotorFila();
  const tarefaId = tarefaInicial.id;

  // Época da tarefa entre abas: a vista agora e a da última releitura feita DEPOIS deste mount
  // (`isFetchedAfterMount` vale também para a consulta em voo herdada de um mount anterior). Só
  // captura com as duas iguais — o retrato do localStorage/lista nunca autoriza sozinho (Codex r2/r3).
  const [epocaAtual, setEpocaAtual] = useState(() => lerEpoca(tarefaId));
  const tarefaQ = useQuery({
    queryKey: ["picking-v2", "tarefa", tarefaId],
    queryFn: async () => {
      const iniciadaEm = Date.now();
      const epoca = lerEpoca(tarefaId).n;
      return { tarefa: await lerTarefa(tarefaId), epoca, iniciadaEm };
    },
    staleTime: 0,
    refetchOnMount: "always",
    refetchInterval: 30_000,
  });
  const tarefa = tarefaQ.data?.tarefa ?? tarefaInicial;
  const [montadoEm] = useState(() => Date.now());
  const epocaLida = tarefaQ.data?.epoca ?? null;
  const leituraIniciadaEm = tarefaQ.data?.iniciadaEm ?? null;
  // A cada releitura, a época vista é refeita: uma barreira aberta por aba que morreu expira
  // (BARREIRA_MAX_MS) sem precisar de evento novo.
  useEffect(() => {
    setEpocaAtual(lerEpoca(tarefaId));
  }, [tarefaQ.dataUpdatedAt, tarefaId]);
  useEffect(() => {
    const aoMudar = (e: StorageEvent) => {
      if (!ehChaveEpoca(e.key, tarefaId)) return;
      setEpocaAtual(lerEpoca(tarefaId));
      void qc.invalidateQueries({ queryKey: ["picking-v2", "tarefa", tarefaId] });
    };
    window.addEventListener("storage", aoMudar);
    return () => window.removeEventListener("storage", aoMudar);
  }, [qc, tarefaId]);
  // Áudio: depois de um reload a tela abre direto em "Separando", sem o toque de "Entrar" que
  // destrava o AudioContext — qualquer toque ou tecla (inclusive o gatilho do leitor) destrava.
  useEffect(() => {
    const destravar = () => tocador.destravar();
    window.addEventListener("pointerdown", destravar, { capture: true });
    window.addEventListener("keydown", destravar, { capture: true });
    return () => {
      window.removeEventListener("pointerdown", destravar, { capture: true });
      window.removeEventListener("keydown", destravar, { capture: true });
    };
  }, []);
  const linhasQ = useQuery({ queryKey: ["picking-v2", "linhas", tarefaId], queryFn: () => lerLinhas(tarefaId) });
  const leiturasQ = useQuery({ queryKey: ["picking-v2", "leituras", tarefaId], queryFn: () => lerLeituras(tarefaId) });
  const produtos = useMemo(() => [...new Set((linhasQ.data ?? []).map((l) => l.omie_codigo_produto))], [linhasQ.data]);
  const codigosQ = useQuery({
    queryKey: ["picking-v2", "codigos", tarefa.account, produtos],
    queryFn: () => lerCodigos(tarefa.account, produtos),
    enabled: produtos.length > 0,
  });

  const fila = useMemo(() => estado.itens.filter((i) => i.comando.tarefa_id === tarefaId), [estado.itens, tarefaId]);
  const linhas = useMemo(() => progressoLocal(linhasQ.data ?? [], leiturasQ.data ?? [], fila), [linhasQ.data, leiturasQ.data, fila]);
  const codigos = useMemo(() => new Map((codigosQ.data ?? []).map((c) => [c.codigo, c])), [codigosQ.data]);

  const [ultimo, setUltimo] = useState<UltimoFeedback | null>(null);
  const [barreira, setBarreira] = useState(false);
  const [perdeu, setPerdeu] = useState<string | null>(null);
  const sinalizar = useCallback((tipo: TipoFeedback, texto: string) => {
    tocador.tocar(tipo);
    setUltimo({ tipo, texto, em: Date.now() });
  }, []);

  // Resposta do servidor que retira a autorização → a captura para e o contexto é relido.
  // `ausente_do_omie` é TEMPORÁRIO (o pedido pode voltar à etapa): não trava a atribuição — só
  // força a releitura, e `autoriza()` decide com `ausente_rodadas` atual (Codex r2).
  const ausenciasVistas = useRef(new Set<string>());
  const [ausenteEm, setAusenteEm] = useState<number | null>(null);
  useEffect(() => {
    const daAtribuicao = fila.filter((i) => i.estado === "rejeitada" && i.comando.atribuicao_id === atribuicao.atribuicao_id);
    const novasAusencias = daAtribuicao.filter((i) => i.motivo === "ausente_do_omie" && !ausenciasVistas.current.has(i.comando.leitura_id));
    novasAusencias.forEach((i) => ausenciasVistas.current.add(i.comando.leitura_id));
    if (novasAusencias.length > 0) setAusenteEm(Date.now());
    const perda = daAtribuicao.find((i) => i.motivo && MOTIVOS_PERDA_DE_AUTORIZACAO.has(i.motivo));
    if (perda && perdeu === null) setPerdeu(perda.motivo);
    if ((perda && perdeu === null) || novasAusencias.length > 0) void qc.invalidateQueries({ queryKey: ["picking-v2", "tarefa", tarefaId] });
  }, [fila, atribuicao.atribuicao_id, perdeu, qc, tarefaId]);
  // Vivacidade: consulta deduplicada com uma que começou ANTES do mount/da negativa não prova
  // nada — quando ela termina e nada está buscando, dispara uma nova (sem esperar os 30 s).
  const leituraVelha =
    leituraIniciadaEm !== null && (leituraIniciadaEm < montadoEm || (ausenteEm !== null && leituraIniciadaEm <= ausenteEm));
  const { fetchStatus: buscaTarefa, refetch: reler } = tarefaQ;
  useEffect(() => {
    if (leituraVelha && buscaTarefa === "idle") void reler();
  }, [leituraVelha, buscaTarefa, reler]);
  // Leituras resolvidas: o progresso do servidor muda.
  const resolvidas = fila.filter((i) => i.estado !== "pendente").length;
  useEffect(() => {
    void qc.invalidateQueries({ queryKey: ["picking-v2", "leituras", tarefaId] });
  }, [resolvidas, qc, tarefaId]);

  const bloqueio = !estado.pronto
    ? estado.erroArmazem
      ? "armazenamento_indisponivel"
      : "carregando_fila"
    : lente
      ? "lente_ver_como"
      : perdeu ?? bloqueioDaTarefa({ tarefa, atribuicao, operador, epocaLida, epocaAtual, leituraIniciadaEm, montadoEm, ausenteEm });
  const capturando = bloqueio === null && !barreira && !linhasQ.isLoading && !leiturasQ.isLoading;

  const registrar = useCallback(
    async (tipo: "bipe" | "manual", previsao: Previsao, extra: { codigo_lido?: string; linha_id?: string; quantidade?: number }) => {
      const a = m.armazem();
      if (!a || !operador) return false;
      const epoca = epocaAtual.n;
      let atravessou = false;
      try {
        await comTrava(travaDaTarefa(tarefaId), async () => {
          // Esperou a trava enquanto outra aba concluía/marcava falta: a captura é de antes.
          const agora = lerEpoca(tarefaId);
          if (agora.n !== epoca || agora.aberta) {
            atravessou = true;
            return;
          }
          await a.enfileirar({
            comando: {
              leitura_id: crypto.randomUUID(),
              account: tarefa.account,
              tarefa_id: tarefaId,
              atribuicao_id: atribuicao.atribuicao_id,
              tarefa_revisao: atribuicao.tarefa_revisao,
              tipo,
              lido_em: new Date().toISOString(),
              ...extra,
            },
            operador_id: operador,
            estado: "pendente",
            tentativas: 0,
            motivo: null,
            linha_id: null,
            unidades: null,
            previsto: previsao.ok ? { linha_id: previsao.linha_id, unidades: previsao.unidades } : null,
            divergente_nao_visto: false,
          });
        });
      } catch {
        sinalizar("divergencia", "Leitura NÃO gravada no aparelho — bipe de novo");
        return false;
      }
      if (atravessou) {
        setEpocaAtual(lerEpoca(tarefaId));
        sinalizar("divergencia", "A tarefa mudou em outro aparelho/aba — leitura NÃO gravada");
        return false;
      }
      await m.recarregar();
      m.cutucar();
      return true;
    },
    [m, operador, epocaAtual, tarefa.account, tarefaId, atribuicao, sinalizar],
  );

  const feedbackAcerto = useCallback(
    (linhaId: string, unidades: number) => {
      const depois = linhas.map((l) => (l.id === linhaId ? { ...l, separada: l.separada + unidades } : l));
      const l = depois.find((x) => x.id === linhaId);
      if (tudoSeparado(depois)) sinalizar("pedido_completo", "Pedido completo — conclua");
      else if (l && l.separada >= l.quantidade) sinalizar("linha_completa", `${l.codigo_item}: linha completa`);
      else sinalizar("correta", l ? `${l.separada}/${l.quantidade}` : "OK");
    },
    [linhas, sinalizar],
  );

  const aoSaida = useCallback(
    (s: Saida) => {
      if (s.tipo === "duplicata") {
        sinalizar("duplicata", "Leitura repetida ignorada");
        track("picking.leitura_duplicata", {});
        return;
      }
      if (s.tipo === "truncada" || s.tipo === "invalida") {
        sinalizar("truncada", "Leitura falhou — bipe de novo");
        track("picking.leitura_falhou", { tipo: s.tipo });
        return;
      }
      const previsao = preverBipe(s.codigo, linhas, codigos.get(s.codigo) ?? null);
      void registrar("bipe", previsao, { codigo_lido: s.codigo }).then((gravou) => {
        if (!gravou) return;
        // Som só depois do commit: verde = está no aparelho e vai chegar ao servidor.
        if (previsao.ok) feedbackAcerto(previsao.linha_id, previsao.unidades);
        else sinalizar(feedbackDoMotivo(previsao.motivo), rotuloMotivo(previsao.motivo));
        track("picking.leitura_capturada", { latencia_ms: Math.round(performance.now() - s.t0), previsao_ok: previsao.ok });
      });
    },
    [linhas, codigos, sinalizar, feedbackAcerto, registrar],
  );

  useScanner(capturando, aoSaida);

  const manual = useCallback(
    (linhaId: string, quantidade: number) => {
      if (!capturando) return;
      const linha = linhas.find((l) => l.id === linhaId);
      if (!linha) return;
      if (!quantidadeRepresentavel(quantidade)) {
        sinalizar("divergencia", "Quantidade inválida — use no máximo 6 casas decimais");
        return;
      }
      const aprovados: CodigoCadastrado[] = (codigosQ.data ?? []).filter((c) => c.omie_codigo_produto === linha.omie_codigo_produto);
      const previsao = preverManual(linha, quantidade, aprovados);
      void registrar("manual", previsao, { linha_id: linhaId, quantidade }).then((gravou) => {
        if (!gravou) return;
        if (previsao.ok) feedbackAcerto(linha.id, quantidade);
        else sinalizar(feedbackDoMotivo(previsao.motivo), rotuloMotivo(previsao.motivo));
      });
    },
    [capturando, linhas, codigosQ.data, feedbackAcerto, sinalizar, registrar],
  );

  /** Barreira: para a captura, trava a tarefa entre abas, drena a fila e roda `acao` com a fila RELIDA. */
  const comBarreira = useCallback(
    async <T,>(acao: (filaRelida: ItemFila[]) => Promise<T>): Promise<T | "nao_drenou"> => {
      setBarreira(true);
      try {
        return await comTrava(travaDaTarefa(tarefaId), async () => {
          // Dentro da trava: abre a barreira (outras abas param de capturar) e só a FECHA depois
          // da RPC — quem esperava a trava com uma captura de antes vê a época nova e é recusado.
          setEpocaAtual(abrirBarreira(tarefaId));
          try {
            if (!(await m.drenar(tarefaId))) return "nao_drenou" as const;
            const relida = (await m.recarregar()).filter((i) => i.comando.tarefa_id === tarefaId);
            return await acao(relida);
          } finally {
            setEpocaAtual(fecharBarreira(tarefaId));
          }
        });
      } finally {
        setBarreira(false);
        void qc.invalidateQueries({ queryKey: ["picking-v2", "tarefa", tarefaId] });
      }
    },
    [m, qc, tarefaId],
  );

  const concluir = useCallback(async (): Promise<{ ok: boolean; motivo?: string }> => {
    const r = await comBarreira(async (relida) => {
      const l = leiturasDaAtribuicao(relida, atribuicao.atribuicao_id);
      if (!l.prontas) return { ok: false, motivo: "leituras_com_falha" };
      return concluirTarefa(tarefa, atribuicao.atribuicao_id, atribuicao.tarefa_revisao, l.ids);
    });
    if (r === "nao_drenou") return { ok: false, motivo: "leituras_nao_enviadas" };
    if (r.ok) track("picking.separado", { conta: tarefa.account, linhas: linhas.length });
    return { ok: r.ok, motivo: r.motivo };
  }, [comBarreira, atribuicao, tarefa, linhas.length]);

  const falta = useCallback(
    async (linhaId: string): Promise<{ ok: boolean; motivo?: string }> => {
      // As leituras já no volume chegam ANTES da falta (senão viram rejeição por estado).
      const r = await comBarreira(() => marcarFalta(tarefa, atribuicao.atribuicao_id, linhaId));
      if (r === "nao_drenou") return { ok: false, motivo: "leituras_nao_enviadas" };
      if (r.ok) track("picking.falta", { conta: tarefa.account });
      return { ok: r.ok, motivo: r.motivo };
    },
    [comBarreira, tarefa, atribuicao.atribuicao_id],
  );

  /** O operador viu as divergências (some o alerta). */
  const reconhecer = useCallback(async () => {
    const a = m.armazem();
    if (!a) return;
    for (const it of fila.filter((i) => i.divergente_nao_visto)) await a.gravar({ ...it, divergente_nao_visto: false });
    await m.recarregar();
  }, [m, fila]);

  const conclusao = leiturasDaAtribuicao(fila, atribuicao.atribuicao_id);

  return {
    tarefa,
    carregando: linhasQ.isLoading || leiturasQ.isLoading,
    erro: linhasQ.error ?? leiturasQ.error ?? null,
    linhas,
    atual: linhaAtual(linhas),
    completo: tudoSeparado(linhas),
    pendentes: fila.filter((i) => i.estado === "pendente").length,
    divergentes: fila.filter((i) => i.divergente_nao_visto),
    podeConcluir: capturando && tudoSeparado(linhas) && conclusao.prontas,
    bloqueio,
    capturando,
    ultimo,
    manual,
    concluir,
    falta,
    reconhecer,
    sinalizar,
  };
}

const ROTULOS: Record<string, string> = {
  codigo_fora_do_pedido: "Produto fora do pedido",
  unidade_incompativel: "Unidade diferente da pedida",
  excesso: "Já completo — excesso",
  codigo_desconhecido: "Código desconhecido",
  codigo_pendente_aprovacao: "Código aguardando aprovação",
  codigo_ambiguo: "Código ambíguo — use o manual",
  linha_fracionaria_exige_manual: "Item fracionado — informe a quantidade",
  linha_inativa: "Linha removida do pedido",
  manual_nao_permitido: "Este item tem código — bipe",
  quantidade_nao_inteira: "Quantidade precisa ser inteira",
  tarefa_fora_de_separacao: "Tarefa não está em separação",
  ausente_do_omie: "Pedido sumiu da etapa 10 no Omie",
  atribuicao_antiga: "Outro separador assumiu esta tarefa",
  revisao_antiga: "Pedido alterado — reconferir",
  estado_mudou: "A tarefa mudou — atualize a fila",
  exige_reconciliacao_fisica: "Confirme a conferência física",
  leituras_pendentes: "Aguardando leituras chegarem ao servidor",
  linhas_incompletas: "Ainda há itens incompletos",
  leituras_nao_enviadas: "Sem conexão: leituras ainda não chegaram ao servidor",
  leituras_com_falha: "Há leitura recusada — chame o supervisor",
  lente_ver_como: "Lente 'Ver como' ativa — separação pausada",
  armazenamento_indisponivel: "Aparelho sem armazenamento — não dá para separar",
  carregando_fila: "Carregando a fila do aparelho…",
  conferindo_tarefa: "Conferindo a tarefa no servidor…",
  barreira_em_andamento: "Concluindo/registrando falta — aguarde",
  sem_dono_versao_anterior: "Leitura de versão anterior do app — chame o supervisor",
};

export function rotuloMotivo(motivo: string): string {
  return ROTULOS[motivo] ?? motivo.replace(/_/g, " ");
}
