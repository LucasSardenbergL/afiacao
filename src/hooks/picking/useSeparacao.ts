// Motor da separação v2 de UMA tarefa: leitor → previsão local → fila durável → envio em ordem →
// resposta do servidor (autoridade). Feedback sai na PREVISÃO (<50 ms); se o servidor discordar,
// toca `divergencia` e a tela se corrige pelo progresso (servidor + fila).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { track } from "@/lib/analytics";
import { criarTocador, feedbackDoMotivo, type TipoFeedback } from "@/lib/picking/feedback";
import { linhaAtual, progressoLocal, tudoSeparado } from "@/lib/picking/progresso-local";
import {
  abrirArmazemIndexedDB,
  armazemMemoria,
  type ArmazemFila,
  backoffMs,
  enfileirar,
  enviarRodada,
  type ItemFila,
  leiturasDaAtribuicao,
} from "@/lib/picking/scanner/fila";
import type { Saida } from "@/lib/picking/scanner/protocolo";
import { type CodigoCadastrado, preverBipe, preverManual, type Previsao } from "@/lib/picking/validacao-local";
import { enviarLeitura, lerCodigos, lerLeituras, lerLinhas, type TarefaV2 } from "@/lib/picking/v2-api";
import { useScanner } from "./useScanner";

/** Um tocador por aba: o AudioContext precisa de um gesto para destravar e não deve se repetir. */
const tocador = criarTocador();
export const destravarSom = () => tocador.destravar();

let armazemCompartilhado: Promise<ArmazemFila> | null = null;
function armazem(): Promise<ArmazemFila> {
  armazemCompartilhado ??= abrirArmazemIndexedDB().catch(() => armazemMemoria());
  return armazemCompartilhado;
}

export interface Atribuicao {
  atribuicao_id: string;
  tarefa_revisao: number;
}

export interface UltimoFeedback {
  tipo: TipoFeedback;
  texto: string;
  em: number;
}

export function useSeparacao(tarefa: TarefaV2 | null, atribuicao: Atribuicao | null) {
  const qc = useQueryClient();
  const ativa = tarefa !== null && atribuicao !== null;
  const tarefaId = tarefa?.id ?? null;

  const linhasQ = useQuery({ queryKey: ["picking-v2", "linhas", tarefaId], queryFn: () => lerLinhas(tarefaId as string), enabled: ativa });
  const leiturasQ = useQuery({
    queryKey: ["picking-v2", "leituras", tarefaId],
    queryFn: () => lerLeituras(tarefaId as string),
    enabled: ativa,
  });
  const produtos = useMemo(() => [...new Set((linhasQ.data ?? []).map((l) => l.omie_codigo_produto))], [linhasQ.data]);
  const codigosQ = useQuery({
    queryKey: ["picking-v2", "codigos", tarefa?.account, produtos],
    queryFn: () => lerCodigos(tarefa?.account ?? "oben", produtos),
    enabled: ativa && produtos.length > 0,
  });

  const [fila, setFila] = useState<ItemFila[]>([]);
  const [ultimo, setUltimo] = useState<UltimoFeedback | null>(null);
  const recarregarFila = useCallback(async () => {
    const todos = await (await armazem()).todos();
    setFila(tarefaId ? todos.filter((i) => i.comando.tarefa_id === tarefaId) : []);
  }, [tarefaId]);
  useEffect(() => {
    void recarregarFila();
  }, [recarregarFila]);

  const linhas = useMemo(
    () => progressoLocal(linhasQ.data ?? [], leiturasQ.data ?? [], fila),
    [linhasQ.data, leiturasQ.data, fila],
  );
  const codigos = useMemo(() => new Map((codigosQ.data ?? []).map((c) => [c.codigo, c])), [codigosQ.data]);

  const sinalizar = useCallback((tipo: TipoFeedback, texto: string) => {
    tocador.tocar(tipo);
    setUltimo({ tipo, texto, em: Date.now() });
  }, []);

  // ── laço de envio: em ordem por tarefa; backoff em erro transitório ──
  const enviando = useRef(false);
  const espera = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previsoes = useRef(new Map<string, Previsao>());
  const enviar = useCallback(async () => {
    if (enviando.current) return;
    enviando.current = true;
    try {
      for (;;) {
        const a = await armazem();
        const r = await enviarRodada(a, enviarLeitura);
        for (const it of r.resolvidos) {
          const prev = previsoes.current.get(it.comando.leitura_id);
          previsoes.current.delete(it.comando.leitura_id);
          const aceitaServidor = it.estado === "aceita";
          track("picking.leitura", {
            tipo: it.comando.tipo,
            aceita: aceitaServidor,
            motivo: it.motivo ?? "nenhum",
            previsao_divergiu: prev ? prev.ok !== aceitaServidor : false,
            tentativas: it.tentativas,
          });
          if (prev && prev.ok !== aceitaServidor) {
            sinalizar("divergencia", aceitaServidor ? "Servidor aceitou a leitura" : `Servidor recusou: ${it.motivo ?? "erro"}`);
          }
        }
        await recarregarFila();
        if (r.resolvidos.length > 0) void qc.invalidateQueries({ queryKey: ["picking-v2", "leituras", tarefaId] });
        if (r.transitorio) {
          espera.current = setTimeout(() => void enviar(), backoffMs(r.maxTentativas));
          return;
        }
        if (r.resolvidos.length === 0) return;
      }
    } finally {
      enviando.current = false;
    }
  }, [qc, recarregarFila, sinalizar, tarefaId]);
  useEffect(() => {
    void enviar();
    const aoVoltar = () => void enviar();
    window.addEventListener("online", aoVoltar);
    return () => {
      window.removeEventListener("online", aoVoltar);
      if (espera.current) clearTimeout(espera.current);
    };
  }, [enviar]);

  const registrar = useCallback(
    async (tipo: "bipe" | "manual", previsao: Previsao, extra: { codigo_lido?: string; linha_id?: string; quantidade?: number }) => {
      if (!tarefa || !atribuicao) return;
      const leitura_id = crypto.randomUUID();
      previsoes.current.set(leitura_id, previsao);
      await enfileirar(
        await armazem(),
        {
          leitura_id,
          account: tarefa.account,
          tarefa_id: tarefa.id,
          atribuicao_id: atribuicao.atribuicao_id,
          tarefa_revisao: atribuicao.tarefa_revisao,
          tipo,
          lido_em: new Date().toISOString(),
          ...extra,
        },
        previsao.ok ? { linha_id: previsao.linha_id, unidades: previsao.unidades } : null,
      );
      await recarregarFila();
      void enviar();
    },
    [tarefa, atribuicao, recarregarFila, enviar],
  );

  /** Feedback do acerto: linha completa / pedido completo / unidade. */
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
      if (previsao.ok) feedbackAcerto(previsao.linha_id, previsao.unidades);
      else sinalizar(feedbackDoMotivo(previsao.motivo), rotuloMotivo(previsao.motivo));
      track("picking.leitura_capturada", { latencia_ms: Math.round(performance.now() - s.t0), previsao_ok: previsao.ok });
      void registrar("bipe", previsao, { codigo_lido: s.codigo });
    },
    [linhas, codigos, sinalizar, feedbackAcerto, registrar],
  );

  useScanner(ativa, aoSaida);

  const manual = useCallback(
    (linhaId: string, quantidade: number) => {
      const linha = linhas.find((l) => l.id === linhaId);
      if (!linha) return;
      const aprovados: CodigoCadastrado[] = (codigosQ.data ?? []).filter((c) => c.omie_codigo_produto === linha.omie_codigo_produto);
      const previsao = preverManual(linha, quantidade, aprovados);
      if (previsao.ok) feedbackAcerto(linha.id, quantidade);
      else sinalizar(feedbackDoMotivo(previsao.motivo), rotuloMotivo(previsao.motivo));
      void registrar("manual", previsao, { linha_id: linhaId, quantidade });
    },
    [linhas, codigosQ.data, feedbackAcerto, sinalizar, registrar],
  );

  const pendentes = fila.filter((i) => i.estado === "pendente").length;
  const concluivel = atribuicao ? leiturasDaAtribuicao(fila, atribuicao.atribuicao_id) : { ids: [], prontas: true };

  return {
    carregando: linhasQ.isLoading || leiturasQ.isLoading,
    erro: linhasQ.error ?? leiturasQ.error ?? null,
    linhas,
    atual: linhaAtual(linhas),
    completo: tudoSeparado(linhas),
    pendentes,
    falhas: fila.filter((i) => i.estado === "falhou"),
    leiturasDaAtribuicao: concluivel,
    ultimo,
    manual,
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
};

export function rotuloMotivo(motivo: string): string {
  return ROTULOS[motivo] ?? motivo.replace(/_/g, " ");
}
