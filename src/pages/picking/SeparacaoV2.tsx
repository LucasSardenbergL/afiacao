// Separação v2 (Fase 1 do picking v2) — tela do coletor Zebra (WT6400 / TC22 / MC3400).
// "Olhar só se der erro": cada bipe toca som + vibra e pinta a tela inteira (verde/vermelho/âmbar);
// o número grande é o progresso da linha atual. Nada modal no fluxo (o leitor entra por teclado e
// o listener do window recebe com qualquer foco). Spec: docs/superpowers/specs/2026-10-10-picking-v2-design.md §5.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PackageCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/ui/page-skeleton";
import { useAuth } from "@/contexts/AuthContext";
import { useUrlState } from "@/hooks/useUrlState";
import { track } from "@/lib/analytics";
import { cn } from "@/lib/utils";
import { PADROES } from "@/lib/picking/feedback";
import { type Conta, lerTarefa, listarFila, pegarTarefa, retomarTarefa, type TarefaV2 } from "@/lib/picking/v2-api";
import { type Atribuicao, destravarSom, rotuloMotivo, useMotorFila, useSeparacao } from "@/hooks/picking/useSeparacao";
import { useWakeLock } from "@/hooks/picking/useWakeLock";

const ROTULO_STATUS: Record<TarefaV2["status"], string> = {
  aguardando: "Aguardando",
  em_separacao: "Em separação",
  separado: "Separado",
  aguardando_ajuste: "Falta — aguardando ajuste",
  suspensa_alteracao: "Pedido alterado — reconferir",
  interrompida_externa: "Interrompida no Omie",
  bloqueado_dado: "Dado do Omie ilegível",
};

type Ativa = { tarefa: TarefaV2; atribuicao: Atribuicao; operador: string };
const CHAVE_ATIVA = "picking-v2:ativa";

/** A separação em curso sobrevive ao reload (o motor da fila também) — só para o MESMO usuário. */
function lerAtiva(operador: string | undefined): Ativa | null {
  try {
    const a = JSON.parse(localStorage.getItem(CHAVE_ATIVA) ?? "null") as Ativa | null;
    return a && operador && a.operador === operador ? a : null;
  } catch {
    return null;
  }
}
function gravarAtiva(a: Ativa | null) {
  try {
    if (a) localStorage.setItem(CHAVE_ATIVA, JSON.stringify(a));
    else localStorage.removeItem(CHAVE_ATIVA);
  } catch {
    /* sem storage: a separação só não volta sozinha depois do reload */
  }
}

export default function SeparacaoV2() {
  const { user } = useAuth();
  const [filtros, setFiltros] = useUrlState({ conta: "oben" });
  const conta: Conta = filtros.conta === "colacor" ? "colacor" : "oben";
  const qc = useQueryClient();
  // Motor da fila configurado na RAIZ: envia também com a lista aberta (Codex Fase 1 P2-13).
  const { estado: motorEstado, lente } = useMotorFila();
  const [ativa, setAtivaEstado] = useState<Ativa | null>(() => lerAtiva(user?.id));
  const setAtiva = useCallback((a: Ativa | null) => {
    gravarAtiva(a);
    setAtivaEstado(a);
  }, []);
  const pendentesDaAba = motorEstado.itens.filter((i) => i.estado === "pendente").length;

  const filaQ = useQuery({
    queryKey: ["picking-v2", "fila", conta],
    queryFn: () => listarFila(conta),
    refetchInterval: 30_000,
    enabled: ativa === null,
  });

  const entrar = useCallback(
    async (t: TarefaV2, acao: "pegar" | "assumir" | "retomar", reconciliacao = false) => {
      destravarSom(); // gesto do usuário: o navegador libera o áudio aqui
      if (lente) {
        toast.error(rotuloMotivo("lente_ver_como"));
        return;
      }
      try {
        const r = acao === "retomar"
          ? await retomarTarefa(t, reconciliacao)
          : await pegarTarefa(t, { assumir: acao === "assumir", reconciliacao });
        if (!r.ok || !r.atribuicao_id || r.tarefa_revisao === undefined) {
          toast.error(rotuloMotivo(r.motivo ?? "nao_foi_possivel"));
          void qc.invalidateQueries({ queryKey: ["picking-v2", "fila", conta] });
          return;
        }
        track("picking.task_pega", { acao, conta });
        const atual = await lerTarefa(t.id);
        if (!user?.id) return;
        setAtiva({ tarefa: atual, atribuicao: { atribuicao_id: r.atribuicao_id, tarefa_revisao: r.tarefa_revisao }, operador: user.id });
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Falha ao pegar a tarefa");
      }
    },
    [conta, qc, lente, user?.id, setAtiva],
  );

  if (ativa) {
    return (
      <Separando
        tarefa={ativa.tarefa}
        atribuicao={ativa.atribuicao}
        aoSair={() => {
          setAtiva(null);
          void qc.invalidateQueries({ queryKey: ["picking-v2", "fila", conta] });
        }}
      />
    );
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-3 p-4">
      <header className="flex items-center justify-between gap-2">
        <h1 className="font-display text-2xl">Separação</h1>
        <div className="flex gap-1">
          {(["oben", "colacor"] as const).map((c) => (
            <Button key={c} size="touch" variant={conta === c ? "default" : "outline"} onClick={() => setFiltros({ conta: c })}>
              {c === "oben" ? "Oben" : "Colacor"}
            </Button>
          ))}
        </div>
      </header>
      {motorEstado.erroArmazem && (
        <p className="text-status-error">Este aparelho não consegue guardar leituras ({motorEstado.erroArmazem}). Não separe por ele.</p>
      )}
      {pendentesDaAba > 0 && (
        <p className="text-sm text-status-warning">{pendentesDaAba} leitura(s) deste aparelho ainda não chegaram ao servidor.</p>
      )}
      {filaQ.isLoading ? (
        <PageSkeleton variant="list" />
      ) : filaQ.error ? (
        <p className="text-status-error">Não consegui ler a fila: {(filaQ.error as Error).message}</p>
      ) : (filaQ.data ?? []).length === 0 ? (
        <EmptyState icon={PackageCheck} title="Fila vazia" description="Nenhum pedido da etapa 10 para separar nesta conta." tone="operational" />
      ) : (
        (filaQ.data ?? []).map((t) => <CartaoTarefa key={t.id} tarefa={t} minha={t.operador_id === user?.id} aoEntrar={entrar} />)
      )}
    </div>
  );
}

function CartaoTarefa({
  tarefa: t,
  minha,
  aoEntrar,
}: {
  tarefa: TarefaV2;
  minha: boolean;
  aoEntrar: (t: TarefaV2, acao: "pegar" | "assumir" | "retomar", reconciliacao?: boolean) => void;
}) {
  const [reconferi, setReconferi] = useState(false);
  const ausente = t.ausente_rodadas >= 2;
  // Toda volta de tarefa já pega exige reconciliação física — inclusive depois de uma falta (o
  // volume pode ter peças que o banco não conta).
  const precisaReconciliar =
    t.status === "suspensa_alteracao" || t.status === "aguardando_ajuste" || (t.status === "em_separacao" && !minha);
  return (
    <div className="rounded-md border bg-card p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-lg font-semibold">Pedido {t.numero_pedido ?? t.omie_codigo_pedido}</div>
          {t.cliente_nome && <div className="text-sm text-muted-foreground">{t.cliente_nome}</div>}
        </div>
        <Badge variant="outline">{ROTULO_STATUS[t.status]}</Badge>
      </div>
      {ausente && <p className="mt-2 text-sm text-status-warning">Sumiu da etapa 10 no Omie — não separar até voltar.</p>}
      {t.status === "bloqueado_dado" && <p className="mt-2 text-sm text-status-error">{t.motivo_bloqueio}</p>}
      {!ausente && t.status !== "bloqueado_dado" && (
        <div className="mt-3 flex flex-col gap-2">
          {precisaReconciliar && (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={reconferi} onCheckedChange={(v) => setReconferi(v === true)} />
              Conferi fisicamente o que já está no volume
            </label>
          )}
          {t.status === "aguardando" && (
            <Button size="touch" onClick={() => aoEntrar(t, "pegar")}>
              Pegar
            </Button>
          )}
          {t.status === "em_separacao" && minha && (
            <Button size="touch" onClick={() => aoEntrar(t, "pegar")}>
              Continuar
            </Button>
          )}
          {t.status === "em_separacao" && !minha && (
            <Button size="touch" variant="outline" disabled={!reconferi} onClick={() => aoEntrar(t, "assumir", true)}>
              Assumir de outro separador
            </Button>
          )}
          {(t.status === "suspensa_alteracao" || t.status === "aguardando_ajuste") && (
            <Button size="touch" disabled={!reconferi} onClick={() => aoEntrar(t, "retomar", reconferi)}>
              Retomar
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** As linhas do progresso local carregam os campos do servidor (descrição incluída). */
function descricao(l: { codigo_item: number }): string {
  return (l as { descricao?: string | null }).descricao ?? `Item ${l.codigo_item}`;
}

const COR_FUNDO = {
  verde: "bg-status-success/25",
  vermelho: "bg-status-error/30",
  ambar: "bg-status-warning/30",
} as const;

function Separando({ tarefa, atribuicao, aoSair }: { tarefa: TarefaV2; atribuicao: Atribuicao; aoSair: () => void }) {
  const sep = useSeparacao(tarefa, atribuicao);
  useWakeLock(true);
  const [qtdManual, setQtdManual] = useState<Record<string, string>>({});
  const [agora, setAgora] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setAgora(Date.now()), 500);
    return () => clearInterval(id);
  }, []);

  const cor = sep.ultimo && agora - sep.ultimo.em < 1500 ? PADROES[sep.ultimo.tipo].cor : null;
  const atual = sep.atual;
  const ordenadas = useMemo(() => [...sep.linhas].sort((a, b) => a.codigo_item - b.codigo_item), [sep.linhas]);
  const [ocupado, setOcupado] = useState(false);

  const concluir = async () => {
    setOcupado(true);
    try {
      const r = await sep.concluir();
      if (!r.ok) {
        sep.sinalizar("divergencia", rotuloMotivo(r.motivo ?? "nao_concluiu"));
        return;
      }
      sep.sinalizar("pedido_completo", "Separado");
      aoSair();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha ao concluir");
    } finally {
      setOcupado(false);
    }
  };

  const falta = async (linhaId: string) => {
    setOcupado(true);
    try {
      const r = await sep.falta(linhaId);
      if (!r.ok) {
        toast.error(rotuloMotivo(r.motivo ?? "nao_marcou"));
        return;
      }
      aoSair();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha ao marcar falta");
    } finally {
      setOcupado(false);
    }
  };

  if (sep.carregando) return <PageSkeleton variant="list" />;
  if (sep.erro) return <p className="p-4 text-status-error">Não consegui ler o pedido: {(sep.erro as Error).message}</p>;

  return (
    <div className={cn("min-h-[100dvh] p-4 transition-colors duration-150", cor ? COR_FUNDO[cor] : "bg-background")}>
      <div className="mx-auto flex max-w-2xl flex-col gap-3">
        <header className="flex items-center justify-between">
          <div className="text-lg font-semibold">Pedido {tarefa.numero_pedido ?? tarefa.omie_codigo_pedido}</div>
          <Button size="touch" variant="ghost" onClick={aoSair}>
            Sair
          </Button>
        </header>

        {atual ? (
          <section className="rounded-md border bg-card p-4 text-center">
            <div className="text-sm text-muted-foreground">
              Item {atual.codigo_item} · {atual.unidade}
            </div>
            <div className="text-base">{descricao(atual)}</div>
            <div className="font-display text-6xl tabular-nums">
              {atual.separada}/{atual.quantidade}
            </div>
          </section>
        ) : (
          <section className="rounded-md border bg-card p-4 text-center font-display text-3xl">Tudo separado</section>
        )}

        {sep.ultimo && <p className="text-center text-base font-medium">{sep.ultimo.texto}</p>}
        {sep.pendentes > 0 && <p className="text-center text-sm text-muted-foreground">{sep.pendentes} leitura(s) enviando…</p>}
        {sep.bloqueio && (
          <p className="rounded-md border border-status-error p-3 text-center text-base font-medium text-status-error">
            Separação parada: {rotuloMotivo(sep.bloqueio)}
          </p>
        )}
        {sep.divergentes.length > 0 && (
          <div className="rounded-md border border-status-error bg-status-error/10 p-3">
            <p className="text-sm font-medium text-status-error">
              {sep.divergentes.length} leitura(s) que o aparelho deu como certas foram recusadas pelo servidor
              ({[...new Set(sep.divergentes.map((d) => rotuloMotivo(d.motivo ?? "erro")))].join(", ")}). Confira o volume.
            </p>
            <Button size="touch" variant="outline" className="mt-2" onClick={() => void sep.reconhecer()}>
              Entendi
            </Button>
          </div>
        )}

        <ul className="flex flex-col gap-2">
          {ordenadas.map((l) => (
            <li key={l.id} className={cn("rounded-md border bg-card p-3", !l.ativa && "opacity-50")}>
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{descricao(l)}</div>
                  <div className="text-xs text-muted-foreground">
                    {l.unidade}
                    {l.fracionaria ? " · fracionado" : ""}
                  </div>
                </div>
                <div className={cn("tabular-nums", l.separada >= l.quantidade ? "text-status-success" : "")}>
                  {l.separada}/{l.quantidade}
                </div>
              </div>
              {l.ativa && l.separada < l.quantidade && (
                <div className="mt-2 flex gap-2">
                  {(l.fracionaria || l.ean === null) && (
                    <>
                      <Input
                        inputMode="decimal"
                        placeholder="Qtd"
                        className="h-11 w-28"
                        value={qtdManual[l.id] ?? ""}
                        onChange={(e) => {
                          const v = e.currentTarget.value;
                          setQtdManual((m) => ({ ...m, [l.id]: v }));
                        }}
                      />
                      <Button
                        size="touch"
                        variant="outline"
                        onClick={() => {
                          const q = Number((qtdManual[l.id] ?? "").replace(",", "."));
                          if (!Number.isFinite(q) || q <= 0) return;
                          sep.manual(l.id, q);
                          setQtdManual((m) => ({ ...m, [l.id]: "" }));
                        }}
                      >
                        Lançar
                      </Button>
                    </>
                  )}
                  <Button size="touch" variant="outline" disabled={!sep.capturando || ocupado} onClick={() => void falta(l.id)}>
                    Falta
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>

        <Button size="balcao" disabled={!sep.podeConcluir || ocupado} onClick={() => void concluir()}>
          Concluir separação
        </Button>
      </div>
    </div>
  );
}
