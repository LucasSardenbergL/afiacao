// /credito/limites — propostas de limite de crédito por GRUPO (crédito-IA PR 4).
// A IA propõe; só o Lucas (credito_sou_aprovador) aprova — em lote, por faixa de risco × tamanho.
import { useMemo, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { PageSkeleton } from "@/components/ui/page-skeleton";
import { EmptyState } from "@/components/EmptyState";
import { UltimaExecucao } from "@/components/execucoes/UltimaExecucao";
import { useUrlState } from "@/hooks/useUrlState";
import { mensagemDeErro } from "@/lib/erro-mensagem";
import {
  agruparPorFaixa, brl, motivoFalha, ROTULO_RISCO, TAMANHOS, valorCitado,
  type PropostaFila, type ResultadoLote,
} from "@/lib/credito/limites";
import {
  ACAO_AVALIAR, useAprovarLote, useAvaliarAgora, useFilaPropostas, useProgresso, useRecusar,
  useSouAprovador, type StatusFila,
} from "@/lib/credito/useLimitesCredito";

const STATUS: Array<{ id: StatusFila; rotulo: string }> = [
  { id: "pendente", rotulo: "Pendentes" },
  { id: "aprovada", rotulo: "Aprovadas" },
  { id: "recusada", rotulo: "Recusadas" },
  { id: "expirada", rotulo: "Expiradas" },
];

const COR_RISCO: Record<string, string> = {
  baixo: "text-status-success",
  medio: "text-status-warning",
  alto: "text-status-error",
  sem_evidencia: "text-status-info",
};

function LinhaProposta({ p, selecionada, onSelecionar, podeDecidir, falha, onRecusar }: {
  p: PropostaFila; selecionada: boolean; onSelecionar: (v: boolean) => void; podeDecidir: boolean;
  falha?: ResultadoLote; onRecusar: () => void;
}) {
  const ia = p.saida_ia;
  const motivos = ia?.motivos ?? [];
  const travas = p.travas ?? [];
  return (
    <div className="border-t border-border py-3 first:border-t-0">
      <div className="flex flex-wrap items-start gap-3">
        {podeDecidir && p.status === "pendente" && (
          <Checkbox checked={selecionada} onCheckedChange={(v) => onSelecionar(v === true)} aria-label={`Selecionar ${p.nome ?? p.grupo_user_id}`} />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-medium">{p.nome ?? "Cliente sem cadastro"}</span>
            {p.documento && <span className="text-xs text-muted-foreground">{p.documento}</span>}
            <span className={`text-xs ${COR_RISCO[p.risco] ?? ""}`}>{ROTULO_RISCO[p.risco] ?? p.risco}</span>
            {p.confianca !== null && <span className="text-xs text-muted-foreground">confiança {Math.round(p.confianca * 100)}%</span>}
          </div>
          <div className="mt-1 text-sm">
            <span className="font-semibold">{brl(p.limite_sugerido_brl)}</span> · até {p.prazo_max_dias} d
            {typeof ia?.limite_brl === "number" && ia.limite_brl !== p.limite_sugerido_brl && (
              <span className="text-muted-foreground"> (IA propôs {brl(ia.limite_brl)})</span>
            )}
            <span className="text-muted-foreground">
              {" "}· em aberto {valorCitado(p.ficha, "em_aberto_brl")} · compra média {valorCitado(p.ficha, "compra_media_mensal_brl")}/mês
              {p.limite_vigente_brl !== null && <> · vigente {brl(p.limite_vigente_brl)}</>}
            </span>
          </div>
          {motivos.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-xs">
              {motivos.map((m, i) => (
                <li key={i}>
                  <span className="text-muted-foreground">{m.campo} = </span>
                  <span className="font-medium">{valorCitado(p.ficha, m.campo)}</span>
                  <span className="text-muted-foreground"> — IA: </span>{m.leitura}
                </li>
              ))}
            </ul>
          )}
          {travas.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {travas.map((t, i) => (
                <Badge key={i} variant="outline" className="text-[11px] font-normal">
                  trava {t.trava}: {String(t.antes)} → {String(t.depois)}
                </Badge>
              ))}
            </div>
          )}
          {falha && !falha.ok && <p className="mt-1 text-xs text-status-error">Não aprovada: {motivoFalha(falha)}</p>}
        </div>
        {podeDecidir && p.status === "pendente" && (
          <Button variant="ghost" size="sm" onClick={onRecusar}>Recusar</Button>
        )}
      </div>
    </div>
  );
}

export default function CreditoLimites() {
  const [filtro, setFiltro] = useUrlState({ status: "pendente" });
  const status: StatusFila = STATUS.some((s) => s.id === filtro.status) ? filtro.status as StatusFila : "pendente";
  const setStatus = (s: StatusFila) => setFiltro({ status: s });
  const fila = useFilaPropostas(status);
  const aprovador = useSouAprovador();
  const progresso = useProgresso();
  const aprovar = useAprovarLote();
  const recusar = useRecusar();
  const avaliar = useAvaliarAgora();
  const [selecao, setSelecao] = useState<Set<string>>(new Set());
  const [falhas, setFalhas] = useState<Map<string, ResultadoLote>>(new Map());
  const [recusando, setRecusando] = useState<PropostaFila | null>(null);
  const [motivo, setMotivo] = useState("");

  const faixas = useMemo(() => agruparPorFaixa(fila.data ?? []), [fila.data]);
  const podeDecidir = aprovador.data === true;

  const alternar = (ids: string[], v: boolean) => setSelecao((s) => {
    const n = new Set(s);
    for (const id of ids) { if (v) n.add(id); else n.delete(id); }
    return n;
  });

  const aprovarSelecao = () => {
    const ids = [...selecao];
    aprovar.mutate(ids, {
      onSuccess: (res) => {
        setFalhas(new Map(res.filter((r) => !r.ok).map((r) => [r.id, r])));
        setSelecao(new Set());
      },
    });
  };

  if (fila.isLoading) return <PageSkeleton variant="list" />;
  const erroFila = fila.error ? mensagemDeErro(fila.error) ?? "" : "";
  if (fila.isError && erroFila.includes("só gestor")) {
    return <EmptyState icon={ShieldCheck} title="Sem acesso" description="Os limites de crédito são visíveis só para gestor e master." />;
  }

  const pg = progresso.data;
  return (
    <div className="mx-auto max-w-5xl space-y-4 px-4 py-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl">Limites de crédito</h1>
          <p className="text-sm text-muted-foreground">
            A IA propõe limite e prazo por grupo; nada vira vigente sem a sua aprovação.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Button variant="outline" size="sm" onClick={() => avaliar.mutate()} disabled={avaliar.isPending}>
            {avaliar.isPending ? "Avaliando…" : "Avaliar agora"}
          </Button>
          <UltimaExecucao acao={ACAO_AVALIAR} />
        </div>
      </div>

      {pg && (
        <Card>
          <CardContent className="flex flex-wrap gap-x-6 gap-y-1 py-3 text-sm">
            <span>Carteira ativa: <b>{pg.carteira}</b> grupos</span>
            <span>Vigentes: <b>{pg.vigentes}</b></span>
            <span>Pendentes: <b>{pg.pendentes}</b></span>
            <span>Ainda não avaliados: <b>{pg.nunca_avaliadas}</b></span>
            {pg.em_retry > 0 && <span className="text-status-warning">Em nova tentativa: <b>{pg.em_retry}</b></span>}
          </CardContent>
        </Card>
      )}

      <Tabs value={status} onValueChange={(v) => { setStatus(v as StatusFila); setSelecao(new Set()); }}>
        <TabsList>{STATUS.map((s) => <TabsTrigger key={s.id} value={s.id}>{s.rotulo}</TabsTrigger>)}</TabsList>
      </Tabs>

      {fila.isError && (
        <p className="text-sm text-status-error">Não consegui ler as propostas: {erroFila || "erro desconhecido"}</p>
      )}
      {!fila.isError && faixas.length === 0 && (
        <EmptyState tone="operational" icon={ShieldCheck} title="Nenhuma proposta aqui"
          description={status === "pendente" ? "A avaliação roda a cada 15 minutos; use “Avaliar agora” para adiantar." : "Nada neste status ainda."} />
      )}

      {faixas.map((f) => {
        const ids = f.propostas.map((p) => p.id);
        const todas = ids.every((id) => selecao.has(id));
        const tam = TAMANHOS.find((t) => t.id === f.tamanho)?.rotulo ?? f.tamanho;
        return (
          <Card key={f.chave}>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 py-3">
              <CardTitle className="text-base">
                <span className={COR_RISCO[f.risco]}>{ROTULO_RISCO[f.risco]}</span> · {tam}
                <span className="ml-2 text-sm font-normal text-muted-foreground">{f.propostas.length} grupo(s) · {brl(f.total_brl)}</span>
              </CardTitle>
              {podeDecidir && status === "pendente" && (
                <Button variant="ghost" size="sm" onClick={() => alternar(ids, !todas)}>
                  {todas ? "Desmarcar faixa" : "Selecionar faixa"}
                </Button>
              )}
            </CardHeader>
            <CardContent className="pt-0">
              {f.propostas.map((p) => (
                <LinhaProposta key={p.id} p={p} podeDecidir={podeDecidir} selecionada={selecao.has(p.id)}
                  onSelecionar={(v) => alternar([p.id], v)} falha={falhas.get(p.id)}
                  onRecusar={() => { setRecusando(p); setMotivo(""); }} />
              ))}
            </CardContent>
          </Card>
        );
      })}

      {podeDecidir && selecao.size > 0 && (
        <div className="sticky bottom-4 flex justify-end">
          <Button onClick={aprovarSelecao} disabled={aprovar.isPending}>
            {aprovar.isPending ? "Aprovando…" : `Aprovar ${selecao.size} selecionada(s)`}
          </Button>
        </div>
      )}

      <Dialog open={recusando !== null} onOpenChange={(v) => { if (!v) setRecusando(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Recusar a proposta de {recusando?.nome ?? "cliente"}</DialogTitle></DialogHeader>
          <Textarea value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Motivo (mínimo 3 caracteres)" />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRecusando(null)}>Cancelar</Button>
            <Button disabled={motivo.trim().length < 3 || recusar.isPending}
              onClick={() => recusando && recusar.mutate({ id: recusando.id, motivo: motivo.trim() }, { onSuccess: () => setRecusando(null) })}>
              Recusar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
