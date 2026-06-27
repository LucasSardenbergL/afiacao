import { useCanariaPreco } from "@/hooks/useCanariaPreco";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ShieldCheck, CheckCircle2, XCircle, AlertTriangle, HelpCircle, Loader2 } from "lucide-react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import type { StatusCanaria } from "@/lib/governanca/canaria-preco";

// Widget de Governança que chama a canária comportamental do edge de preço DEPLOYADO
// (Opção A da mitigação de reversão do Lovable). Pull: rode após um deploy/Publish ou
// quando chegar um alerta `lovable-touched-sensitive`. Estados explícitos (Codex) — erro
// HTTP e payload ausente NÃO viram "verde": só `ok` é verde.

const VISUAL: Record<StatusCanaria, { label: string; cls: string; Icon: typeof CheckCircle2 }> = {
  ok: { label: "OK", cls: "bg-status-success/10 text-status-success border-status-success/20", Icon: CheckCircle2 },
  falha: { label: "REGRESSÃO", cls: "bg-destructive/10 text-destructive border-destructive/20", Icon: XCircle },
  erro: { label: "ERRO", cls: "bg-destructive/10 text-destructive border-destructive/20", Icon: AlertTriangle },
  desconhecido: { label: "Não verificado", cls: "bg-muted text-muted-foreground border-border", Icon: HelpCircle },
};

export function CanariaPrecoCard() {
  const { verificar, verificando, resultado } = useCanariaPreco();
  const status: StatusCanaria = resultado?.status ?? "desconhecido";
  const carregandoInicial = verificando && !resultado;
  const v = VISUAL[status];
  const Icon = v.Icon;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <ShieldCheck className="w-4 h-4" /> Canária de preço (edge deployada)
          </CardTitle>
          {carregandoInicial ? (
            <Badge className="text-2xs bg-muted text-muted-foreground border-border">
              <Loader2 className="w-3 h-3 mr-1 animate-spin" /> Verificando…
            </Badge>
          ) : (
            <Badge className={`text-2xs ${v.cls}`}>
              <Icon className="w-3 h-3 mr-1" /> {v.label}
            </Badge>
          )}
        </div>
        <CardDescription className="text-xs">
          Prova que a edge <span className="font-mono">analyze-unified-order</span> SERVIDA em produção honra "preço praticado vence o Omie" (local 123 vs Omie 999). Pega reversão silenciosa do deploy do Lovable que o CI do repo não enxerga. Roda sozinha ao abrir esta página.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <Button size="sm" onClick={verificar} disabled={verificando} className="h-7 text-xs">
            {verificando ? (
              <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Verificando…</>
            ) : (
              "Verificar de novo"
            )}
          </Button>
          {resultado && (
            <span className="text-2xs text-muted-foreground">
              Última checagem: {format(new Date(resultado.em), "dd/MM HH:mm:ss", { locale: ptBR })}
            </span>
          )}
        </div>
        {resultado ? (
          <p className={`text-xs ${status === "ok" ? "text-muted-foreground" : "text-destructive font-medium"}`}>
            {resultado.detalhe}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {carregandoInicial ? (
              "Verificando a edge deployada…"
            ) : (
              <>Vermelho = restaure a edge (ver <span className="font-mono">docs/agent/deploy.md</span> → "Quando o Lovable reverte").</>
            )}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
