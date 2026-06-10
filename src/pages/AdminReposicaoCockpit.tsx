import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { format } from "date-fns";
import { toast } from "sonner";
import {
  Download,
  Keyboard,
  Loader2,
  Printer,
  RotateCw,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useRegisterShortcuts } from "@/components/shell/ShortcutsRegistry";
import {
  REPOSICAO_EMPRESA,
  useCurrentStep,
  useItensDoDia,
} from "@/hooks/useReposicaoSessao";
import { downloadCsv, formatBRL, formatDate, logAudit } from "@/lib/reposicao";
import { ContinuarBanner } from "@/components/reposicao/ContinuarBanner";
import { EtapasGrid } from "@/components/reposicao/EtapasGrid";
import { SmartAlertsSection } from "@/components/reposicao/SmartAlertsSection";
import { MetricsStrip } from "@/components/reposicao/MetricsStrip";
import { AuditLogSection } from "@/components/reposicao/AuditLogSection";
import { DataHealthBanner } from "@/components/dataHealth/DataHealthBanner";

export default function AdminReposicaoCockpit() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const tabParam = params.get("tab");
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const { data: currentStep = 3 } = useCurrentStep();
  const { data: itensDia = [] } = useItensDoDia();

  // Legacy ?tab= deep-links → canonical /sessao/* routes
  useEffect(() => {
    if (!tabParam) return;
    const map: Record<string, string> = {
      ciclohoje: "/admin/reposicao/sessao/pedidos",
      aplicaromie: "/admin/reposicao/sessao/aplicacao",
      confirmacao: "/admin/reposicao/sessao/confirmacao",
      anteriores: "/admin/reposicao/sessao/historico",
      oportunidades: "/admin/reposicao/oportunidades",
    };
    const dest = map[tabParam];
    if (dest) navigate(dest, { replace: true });
  }, [tabParam, navigate]);

  // Realtime invalidation — com throttle leading+trailing. A geração do ciclo
  // (cron 9h15) e o auto-apply mexem nessas tabelas EM LOTE: cada linha era um
  // evento postgres_changes que disparava 6 invalidations + 1 toast → com o
  // cockpit aberto na hora do cron virava tempestade de refetch e spam de
  // toast. Agora o 1º evento invalida na hora e a rajada colapsa em 1
  // revalidação por janela de 2,5s.
  useEffect(() => {
    let timer: number | undefined;
    let last = 0;
    const THROTTLE_MS = 2500;
    const invalidateCockpit = () => {
      last = Date.now();
      queryClient.invalidateQueries({ queryKey: ["cockpit-current-step"] });
      queryClient.invalidateQueries({ queryKey: ["cockpit-itens-dia"] });
      queryClient.invalidateQueries({ queryKey: ["cockpit-historico-chart"] });
      queryClient.invalidateQueries({ queryKey: ["reposicao-pedidos"] });
      queryClient.invalidateQueries({ queryKey: ["reposicao-aplicacao"] });
      queryClient.invalidateQueries({ queryKey: ["reposicao-historico"] });
      toast("Dados atualizados automaticamente", { duration: 1800 });
    };
    const onEvent = () => {
      const elapsed = Date.now() - last;
      if (elapsed >= THROTTLE_MS) {
        invalidateCockpit();
        return;
      }
      if (timer !== undefined) return; // trailing já agendado — colapsa a rajada
      timer = window.setTimeout(() => {
        timer = undefined;
        invalidateCockpit();
      }, THROTTLE_MS - elapsed);
    };
    const channel = supabase
      .channel("cockpit-reposicao-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "pedido_compra_sugerido" },
        onEvent,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "sku_parametros" },
        onEvent,
      )
      .subscribe();

    return () => {
      // cancel (não flush): tela desmontada não precisa invalidar — o próximo
      // mount refaz as queries de qualquer forma.
      if (timer !== undefined) window.clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [queryClient]);

  // ---- Actions ------------------------------------------------------------
  const [isExporting, setIsExporting] = useState(false);
  const handleExportCsv = async () => {
    if (isExporting) return;
    setIsExporting(true);
    const today = format(new Date(), "yyyy-MM-dd");
    const filename = `cockpit-ciclohoje-${today}.csv`;
    try {
      const rows = itensDia.map((r) => [
        r.grupo_codigo ?? "",
        r.fornecedor_nome ?? "",
        r.fornecedor_nome ?? "",
        r.num_skus ?? 0,
        r.aprovado_em ? r.num_skus ?? 0 : 0,
        r.status ?? "",
      ]);
      downloadCsv(
        filename,
        ["SKU", "Descrição", "Fornecedor", "Qtd sugerida", "Qtd aprovada", "Status"],
        rows,
      );
      await logAudit({
        userId: user?.id ?? null,
        action: "CSV exportado",
        result: "Sucesso",
        metadata: { scope: "ciclohoje", filename },
      });
      toast.success("CSV exportado");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logAudit({
        userId: user?.id ?? null,
        action: "CSV exportado",
        result: `Erro: ${msg}`,
      });
      toast.error("Falha ao exportar CSV");
    } finally {
      setIsExporting(false);
    }
  };

  const [isGenerating, setIsGenerating] = useState(false);
  const handleGenerate = async () => {
    if (isGenerating) return;
    setIsGenerating(true);
    try {
      const { error } = await supabase.functions.invoke("gerar-pedidos-diario", {
        body: { empresa: REPOSICAO_EMPRESA, manual: true },
      });
      if (error) throw error;
      await logAudit({
        userId: user?.id ?? null,
        action: "Geração manual",
        result: "Sucesso",
      });
      toast.success("Geração disparada");
      queryClient.invalidateQueries({ queryKey: ["cockpit-itens-dia"] });
      queryClient.invalidateQueries({ queryKey: ["cockpit-current-step"] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logAudit({
        userId: user?.id ?? null,
        action: "Geração manual",
        result: `Erro: ${msg}`,
      });
      toast.error("Falha na geração manual");
    } finally {
      setIsGenerating(false);
    }
  };

  const handleRefetchAll = () => {
    queryClient.invalidateQueries({ queryKey: ["cockpit-itens-dia"] });
    queryClient.invalidateQueries({ queryKey: ["cockpit-current-step"] });
    queryClient.invalidateQueries({ queryKey: ["cockpit-historico-chart"] });
    queryClient.invalidateQueries({ queryKey: ["reposicao-pedidos"] });
    queryClient.invalidateQueries({ queryKey: ["reposicao-aplicacao"] });
    queryClient.invalidateQueries({ queryKey: ["reposicao-historico"] });
    toast("Atualizando...", { duration: 1200 });
  };

  const handlePrintPdf = () => {
    const today = format(new Date(), "yyyy-MM-dd");
    const styleId = "__cockpit_print_style__";
    let style = document.getElementById(styleId) as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement("style");
      style.id = styleId;
      style.media = "print";
      document.head.appendChild(style);
    }
    style.innerHTML = `
      @page { margin: 16mm; }
      body * { visibility: hidden !important; }
      #cockpit-print-area, #cockpit-print-area * { visibility: visible !important; }
      #cockpit-print-area {
        position: absolute !important;
        left: 0; top: 0; width: 100%;
        background: white; color: black;
        padding: 12px 20px;
        font-family: Inter, system-ui, sans-serif;
        font-size: 12px;
      }
      #cockpit-print-area h1 { font-size: 18px; margin: 0 0 4px; }
      #cockpit-print-area .meta { color: #555; font-size: 11px; margin-bottom: 12px; }
      #cockpit-print-area table { width: 100%; border-collapse: collapse; }
      #cockpit-print-area th, #cockpit-print-area td {
        border: 1px solid #ccc; padding: 4px 6px; text-align: left;
      }
      #cockpit-print-area th { background: #f3f4f6; font-weight: 600; }
      #cockpit-print-area .right { text-align: right; }
      #cockpit-print-area .footer { margin-top: 12px; font-size: 10px; color: #777; text-align: right; }
    `;

    const existing = document.getElementById("cockpit-print-area");
    if (existing) existing.remove();
    const area = document.createElement("div");
    area.id = "cockpit-print-area";
    const rowsHtml = itensDia
      .map(
        (r) => `<tr>
        <td>${r.grupo_codigo ?? "—"}</td>
        <td>${r.fornecedor_nome ?? "—"}</td>
        <td class="right">${r.num_skus ?? 0}</td>
        <td class="right">${r.aprovado_em ? (r.num_skus ?? 0) : ""}</td>
        <td class="right">${formatBRL(r.valor_total)}</td>
        <td>${r.status ?? "—"}</td>
      </tr>`,
      )
      .join("");
    area.innerHTML = `
      <h1>COLACOR — Cockpit de Reposição</h1>
      <div class="meta">Ciclo: ${formatDate(today)} · ${itensDia.length} pedido(s)</div>
      <table>
        <thead>
          <tr>
            <th>SKU/Grupo</th><th>Fornecedor</th>
            <th class="right">Qtd sugerida</th><th class="right">Qtd aprovada</th>
            <th class="right">Valor</th><th>Status</th>
          </tr>
        </thead>
        <tbody>${rowsHtml || `<tr><td colspan="6" style="text-align:center;color:#777">Sem itens</td></tr>`}</tbody>
      </table>
      <div class="footer">Gerado em ${new Date().toLocaleString("pt-BR")}</div>
    `;
    document.body.appendChild(area);

    const cleanup = () => {
      area.remove();
      window.removeEventListener("afterprint", cleanup);
    };
    window.addEventListener("afterprint", cleanup);
    setTimeout(() => window.print(), 50);

    logAudit({
      userId: user?.id ?? null,
      action: "PDF gerado",
      result: "Sucesso",
      metadata: { count: itensDia.length },
    });
  };

  // ---- Keyboard shortcuts (registrados no ShortcutsRegistry global) -------
  useRegisterShortcuts(
    useMemo(
      () => [
        { keys: "g", label: "Gerar pedidos do dia", group: "Reposição", handler: () => handleGenerate() },
        { keys: "e", label: "Exportar CSV do ciclo", group: "Reposição", handler: () => handleExportCsv() },
        { keys: "r", label: "Atualizar dados", group: "Reposição", handler: () => handleRefetchAll() },
        { keys: "1", label: "Etapa 1: Mercado", group: "Reposição", handler: () => navigate("/admin/reposicao/sessao/mercado") },
        { keys: "2", label: "Etapa 2: Parâmetros", group: "Reposição", handler: () => navigate("/admin/reposicao/sessao/parametros") },
        { keys: "3", label: "Etapa 3: Pedidos", group: "Reposição", handler: () => navigate("/admin/reposicao/sessao/pedidos") },
        { keys: "4", label: "Etapa 4: Aplicação Omie", group: "Reposição", handler: () => navigate("/admin/reposicao/sessao/aplicacao") },
        { keys: "5", label: "Etapa 5: Confirmação", group: "Reposição", handler: () => navigate("/admin/reposicao/sessao/confirmacao") },
      ],
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [navigate],
    ),
  );

  return (
    <div className="space-y-6">
      <header className="relative bg-cockpit-hero noise rounded-lg border border-border px-6 py-7 flex items-center justify-between gap-3 flex-wrap overflow-hidden">
        <div className="relative flex items-center gap-3">
          <Sparkles className="h-6 w-6 text-foreground/70" />
          <div>
            <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground font-medium mb-1">
              Reposição · Cockpit de compras
            </p>
            <h1
              className="font-display"
              style={{ fontSize: "2rem", fontWeight: 500, letterSpacing: "-0.04em", lineHeight: 1.1 }}
            >
              Ciclo diário
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Todo o pipeline de compras em uma única tela.
            </p>
          </div>
        </div>
        <div className="relative flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => window.dispatchEvent(new Event("open-shortcuts-dialog"))}
            title="Atalhos de teclado (?)"
          >
            <Keyboard className="h-4 w-4" />
          </Button>
          <Button size="sm" variant="outline" onClick={handleRefetchAll} title="Atualizar (R)">
            <RotateCw className="h-4 w-4 mr-1.5" /> Atualizar
          </Button>
          <Button size="sm" onClick={handleGenerate} disabled={isGenerating} title="Gerar (G)">
            {isGenerating ? (
              <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4 mr-1.5" />
            )}
            Gerar agora
          </Button>
        </div>
      </header>

      <ContinuarBanner currentStep={currentStep} />

      <DataHealthBanner source="reposicao_sugestoes" />
      <DataHealthBanner source="estoque_inventario" />

      <SmartAlertsSection />

      <MetricsStrip items={itensDia} />

      <EtapasGrid />

      <div className="flex items-center gap-2 flex-wrap">
        <Button size="sm" variant="outline" onClick={handleExportCsv} disabled={isExporting}>
          {isExporting ? (
            <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
          ) : (
            <Download className="h-4 w-4 mr-1.5" />
          )}
          Exportar CSV do ciclo
        </Button>
        <Button size="sm" variant="outline" onClick={handlePrintPdf}>
          <Printer className="h-4 w-4 mr-1.5" /> PDF do ciclo
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => navigate("/admin/reposicao/sessao/historico")}
        >
          Ver histórico
        </Button>
      </div>

      <AuditLogSection />
    </div>
  );
}
