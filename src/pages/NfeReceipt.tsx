import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Package, Loader2, CheckCircle2, XCircle, AlertTriangle } from "lucide-react";

interface StepResult {
  step: number;
  description: string;
  status: "success" | "error" | "warning";
  detail?: string;
}

export default function NfeReceipt() {
  const [nfNumber, setNfNumber] = useState("");
  const [loading, setLoading] = useState(false);
  const [steps, setSteps] = useState<StepResult[]>([]);
  const [finalStatus, setFinalStatus] = useState<"idle" | "success" | "error">("idle");

  const handleProcess = async () => {
    if (!nfNumber.trim()) return;
    setLoading(true);
    setSteps([]);
    setFinalStatus("idle");

    try {
      const { data, error } = await supabase.functions.invoke("process-nfe", {
        body: { nf_number: nfNumber.trim() },
      });

      if (error) {
        setSteps([{ step: 0, description: "Erro ao chamar a função", status: "error", detail: error.message }]);
        setFinalStatus("error");
        return;
      }

      setSteps(data.steps || []);
      setFinalStatus(data.success ? "success" : "error");
    } catch (e: any) {
      setSteps([{ step: 0, description: "Erro inesperado", status: "error", detail: e.message }]);
      setFinalStatus("error");
    } finally {
      setLoading(false);
    }
  };

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
          <h1 className="text-2xl font-bold tracking-tight">OBEN Recebimento NF-e</h1>
          <p className="text-sm text-muted-foreground">Processamento automático de notas fiscais de entrada</p>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="text-base">Processar Nota Fiscal</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-3">
            <Input
              type="number"
              placeholder="Número da NF"
              value={nfNumber}
              onChange={(e) => setNfNumber(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !loading && handleProcess()}
              disabled={loading}
              className="flex-1"
            />
            <Button onClick={handleProcess} disabled={loading || !nfNumber.trim()}>
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
    </div>
  );
}
