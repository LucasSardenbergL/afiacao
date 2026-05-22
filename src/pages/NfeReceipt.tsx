import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Package, Loader2, CheckCircle2, XCircle, AlertTriangle, RotateCw, History } from "lucide-react";

const ACCOUNT_LABELS: Record<string, string> = {
  oben: "Oben",
  colacor: "Colacor",
  afiacao: "Afiação",
};

// Histórico local das últimas processadas — fallback até existir tabela `nfe_receipt_runs` no schema.
// Quando a tabela existir, trocar este storage local por query Supabase.
// TODO(schema): criar tabela nfe_receipt_runs(id uuid, account text, nf_number int, success bool, steps jsonb, started_at timestamptz, finished_at timestamptz, user_id uuid).
const HISTORY_KEY = "nfe_receipt_history_v1";
const MAX_HISTORY = 10;

interface HistoryEntry {
  id: string;
  account: string;
  nf_number: string;
  success: boolean;
  finished_at: string;
  steps_count: number;
}

function readHistory(): HistoryEntry[] {
  if (typeof localStorage === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]") as HistoryEntry[];
  } catch {
    return [];
  }
}
function pushHistory(entry: HistoryEntry): HistoryEntry[] {
  const next = [entry, ...readHistory().filter((h) => !(h.account === entry.account && h.nf_number === entry.nf_number))].slice(0, MAX_HISTORY);
  if (typeof localStorage !== "undefined") localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  return next;
}

interface StepResult {
  step: number;
  description: string;
  status: "success" | "error" | "warning";
  detail?: string;
}

export default function NfeReceipt() {
  const [nfNumber, setNfNumber] = useState("");
  const [account, setAccount] = useState("oben");
  const [loading, setLoading] = useState(false);
  const [steps, setSteps] = useState<StepResult[]>([]);
  const [finalStatus, setFinalStatus] = useState<"idle" | "success" | "error">("idle");
  const [history, setHistory] = useState<HistoryEntry[]>(() => readHistory());

  const handleProcess = async (overrideNfNumber?: string, overrideAccount?: string) => {
    const nf = (overrideNfNumber ?? nfNumber).trim();
    const acc = overrideAccount ?? account;
    if (!nf) return;
    setNfNumber(nf);
    setAccount(acc);
    setLoading(true);
    setSteps([]);
    setFinalStatus("idle");

    try {
      const { data, error } = await supabase.functions.invoke("process-nfe", {
        body: { nf_number: nf, account: acc },
      });

      let success = false;
      let resultSteps: StepResult[];
      if (error) {
        resultSteps = [{ step: 0, description: "Erro ao chamar a função", status: "error", detail: error.message }];
        setSteps(resultSteps);
        setFinalStatus("error");
      } else {
        resultSteps = data.steps || [];
        success = !!data.success;
        setSteps(resultSteps);
        setFinalStatus(success ? "success" : "error");
      }
      setHistory(
        pushHistory({
          id:
            typeof crypto !== "undefined" && "randomUUID" in crypto
              ? crypto.randomUUID()
              : `${Date.now()}`,
          account: acc,
          nf_number: nf,
          success,
          finished_at: new Date().toISOString(),
          steps_count: resultSteps.length,
        }),
      );
    } catch (e) {
      const resultSteps = [{ step: 0, description: "Erro inesperado", status: "error" as const, detail: e instanceof Error ? e.message : String(e) }];
      setSteps(resultSteps);
      setFinalStatus("error");
      setHistory(
        pushHistory({
          id: `${Date.now()}`,
          account: acc,
          nf_number: nf,
          success: false,
          finished_at: new Date().toISOString(),
          steps_count: 1,
        }),
      );
    } finally {
      setLoading(false);
    }
  };

  // Re-sincroniza histórico se outra aba alterar
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === HISTORY_KEY) setHistory(readHistory());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const getIcon = (status: string) => {
    switch (status) {
      case "success": return <CheckCircle2 className="h-4 w-4 text-primary shrink-0" />;
      case "error": return <XCircle className="h-4 w-4 text-destructive shrink-0" />;
      case "warning": return <AlertTriangle className="h-4 w-4 text-accent-foreground shrink-0" />;
      default: return null;
    }
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Package className="h-7 w-7 text-primary" />
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            Recebimento NF-e — {ACCOUNT_LABELS[account] ?? account}
          </h1>
          <p className="text-sm text-muted-foreground">Processamento automático de notas fiscais de entrada</p>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="text-base">Processar Nota Fiscal</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-3">
            <Select value={account} onValueChange={setAccount}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="oben">Oben</SelectItem>
                <SelectItem value="colacor">Colacor</SelectItem>
                <SelectItem value="afiacao">Afiação</SelectItem>
              </SelectContent>
            </Select>
            <Input
              type="number"
              placeholder="Número da NF"
              value={nfNumber}
              onChange={(e) => setNfNumber(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !loading && handleProcess()}
              disabled={loading}
              className="flex-1"
            />
            <Button onClick={() => handleProcess()} disabled={loading || !nfNumber.trim()}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Processar NF-e
            </Button>
          </div>

          {finalStatus !== "idle" && (
            <Badge variant={finalStatus === "success" ? "default" : "destructive"} className="text-sm">
              {finalStatus === "success" ? "✅ Concluído com sucesso" : "❌ Erro no processamento"}
            </Badge>
          )}
        </CardContent>
      </Card>

      {steps.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Log de Processamento</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 font-mono text-sm bg-muted/50 rounded-lg p-4">
              {steps.map((s, i) => (
                <div key={i} className="flex items-start gap-2">
                  {getIcon(s.status)}
                  <div className="min-w-0">
                    <span className={s.status === "error" ? "text-destructive" : s.status === "warning" ? "text-accent-foreground" : "text-foreground"}>
                      {s.description}
                    </span>
                    {s.detail && (
                      <p className="text-xs text-muted-foreground mt-0.5 break-all">{s.detail}</p>
                    )}
                  </div>
                </div>
              ))}
              {loading && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Processando...</span>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {history.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <History className="h-4 w-4 text-muted-foreground" />
              Últimas processadas
              <span className="text-xs font-normal text-muted-foreground">(neste navegador)</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-border">
              {history.map((h) => (
                <li key={h.id} className="flex items-center justify-between py-2 text-sm">
                  <div className="min-w-0 flex items-center gap-2">
                    {h.success ? (
                      <CheckCircle2 className="h-4 w-4 text-status-success shrink-0" />
                    ) : (
                      <XCircle className="h-4 w-4 text-status-error shrink-0" />
                    )}
                    <span className="font-mono">NF {h.nf_number}</span>
                    <Badge variant="outline" className="text-[10px]">
                      {ACCOUNT_LABELS[h.account] ?? h.account}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {new Date(h.finished_at).toLocaleString("pt-BR")}
                    </span>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => handleProcess(h.nf_number, h.account)}
                    disabled={loading}
                    className="gap-1.5"
                  >
                    <RotateCw className="h-3.5 w-3.5" />
                    Reprocessar
                  </Button>
                </li>
              ))}
            </ul>
            <p className="text-[11px] text-muted-foreground mt-3">
              Esta tela processa uma NF-e por número. Para conferência item-a-item de NFs com lote/FEFO, use{" "}
              <a href="/recebimento" className="text-link-level hover:underline">Recebimento</a>.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
