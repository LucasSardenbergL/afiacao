// Sheet de drill-down (contexto, dados do SKU, histórico, impacto, decisão) dos Alertas de Outlier.
// Extraído de src/pages/AdminReposicaoAlertas.tsx (god-component split). Componente controlado.
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, XCircle, EyeOff, Loader2 } from "lucide-react";
import {
  ResponsiveContainer, BarChart, Bar, ScatterChart, Scatter,
  XAxis, YAxis, CartesianGrid, Tooltip as ReTooltip, ReferenceLine, Cell,
} from "recharts";
import { sevBadge, statusBadge } from "./badges";
import { tipoLabel, fmt, type EventoOutlier, type SkuInfo, type ImpactoData, type GrupoRow } from "./types";

export function AlertaDrillSheet({
  drillEvento, onClose, isSemGrupo, skuInfo, historico, impacto, gruposFornecedor,
  grupoEscolhido, setGrupoEscolhido, atribuirGrupoPending, onAtribuirGrupo,
  justificativa, setJustificativa, onAcao,
}: {
  drillEvento: EventoOutlier | null;
  onClose: () => void;
  isSemGrupo: boolean;
  skuInfo?: SkuInfo | null;
  historico: unknown;
  impacto?: ImpactoData;
  gruposFornecedor?: GrupoRow[];
  grupoEscolhido: string;
  setGrupoEscolhido: (s: string) => void;
  atribuirGrupoPending: boolean;
  onAtribuirGrupo: () => void;
  justificativa: string;
  setJustificativa: (s: string) => void;
  onAcao: (tipo: "aceitar" | "excluir" | "ignorar") => void;
}) {
  return (
    <Sheet open={!!drillEvento} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-2xl overflow-y-auto">
        {drillEvento && (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2">
                {sevBadge(drillEvento.severidade)}
                <span>{tipoLabel(drillEvento.tipo)} — SKU {drillEvento.sku_codigo_omie}</span>
              </SheetTitle>
            </SheetHeader>

            <div className="space-y-5 mt-4">
              {/* Seção 1 */}
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm">1. Contexto</CardTitle></CardHeader>
                <CardContent className="space-y-1 text-sm">
                  <div><span className="text-muted-foreground">Data:</span> {new Date(drillEvento.data_evento).toLocaleDateString("pt-BR")}</div>
                  <div><span className="text-muted-foreground">Detectado:</span> {drillEvento.detectado_em ? new Date(drillEvento.detectado_em).toLocaleString("pt-BR") : "—"}</div>
                  <div className="pt-2 p-2 bg-muted/50 rounded text-xs">{drillEvento.detalhes?.mensagem ?? "Sem mensagem"}</div>
                </CardContent>
              </Card>

              {/* Seção 2 */}
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm">2. Dados do SKU</CardTitle></CardHeader>
                <CardContent className="space-y-1 text-sm">
                  <div><span className="text-muted-foreground">Descrição:</span> {drillEvento.sku_descricao ?? "—"}</div>
                  <div><span className="text-muted-foreground">Classe:</span> {skuInfo?.classe_consolidada ?? "—"}</div>
                  <div><span className="text-muted-foreground">D (média/dia):</span> {fmt(skuInfo?.demanda_media_diaria, 2)}</div>
                  <div><span className="text-muted-foreground">σ atual:</span> {fmt(skuInfo?.demanda_sigma_diario, 2)}</div>
                  <div><span className="text-muted-foreground">LT médio:</span> {fmt(skuInfo?.lt_medio_dias_uteis, 1)} dias</div>
                  <div><span className="text-muted-foreground">Preço compra:</span> R$ {fmt(skuInfo?.preco_compra_real, 2)}</div>
                </CardContent>
              </Card>

              {/* Seção 3 - Gráfico (não aplicável a sku_sem_grupo) */}
              {!isSemGrupo && (
                <Card>
                  <CardHeader className="pb-2"><CardTitle className="text-sm">3. Histórico</CardTitle></CardHeader>
                  <CardContent>
                    <div className="h-[220px]">
                      <ResponsiveContainer width="100%" height="100%">
                        {drillEvento.tipo === "venda_atipica" ? (
                          <BarChart data={(historico as Array<{ dia: string; qtde: number; isOutlier: boolean }> | null) ?? []}>
                            <CartesianGrid strokeDasharray="3 3" />
                            <XAxis dataKey="dia" tick={{ fontSize: 10 }} />
                            <YAxis tick={{ fontSize: 10 }} />
                            <ReTooltip />
                            <Bar dataKey="qtde">
                              {((historico as Array<{ isOutlier: boolean }> | null) ?? []).map((d, i) => (
                                <Cell key={i} fill={d.isOutlier ? "hsl(var(--destructive))" : "hsl(var(--primary))"} />
                              ))}
                            </Bar>
                          </BarChart>
                        ) : (
                          <ScatterChart>
                            <CartesianGrid strokeDasharray="3 3" />
                            <XAxis dataKey="idx" tick={{ fontSize: 10 }} name="#" />
                            <YAxis dataKey="lt" tick={{ fontSize: 10 }} name="LT (dias)" />
                            <ReTooltip />
                            {impacto?.media_atual != null && (
                              <ReferenceLine y={impacto.media_atual} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" />
                            )}
                            <Scatter data={(historico as Array<{ idx: number; lt: number; isOutlier: boolean }> | null) ?? []}>
                              {((historico as Array<{ isOutlier: boolean }> | null) ?? []).map((d, i) => (
                                <Cell key={i} fill={d.isOutlier ? "hsl(var(--destructive))" : "hsl(var(--primary))"} />
                              ))}
                            </Scatter>
                          </ScatterChart>
                        )}
                      </ResponsiveContainer>
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Seção 4 - Impacto (não aplicável a sku_sem_grupo) */}
              {!isSemGrupo && (
                <Card>
                  <CardHeader className="pb-2"><CardTitle className="text-sm">4. Impacto se excluir</CardTitle></CardHeader>
                  <CardContent className="text-sm space-y-1">
                    {impacto && !impacto.error ? (
                      <>
                        <div>σ atual: <span className="font-mono">{fmt(impacto.sigma_atual)}</span> → sem outlier: <span className="font-mono">{fmt(impacto.sigma_sem)}</span></div>
                        <div>Média atual: <span className="font-mono">{fmt(impacto.media_atual)}</span> → sem: <span className="font-mono">{fmt(impacto.media_sem)}</span></div>
                        {impacto.em_atual !== undefined && impacto.delta_em !== undefined && (
                          <div className="pt-2 p-2 bg-muted/50 rounded">
                            Estoque mínimo sugerido: <span className="font-mono">{impacto.em_atual}</span> → <span className="font-mono">{impacto.em_sem}</span>{" "}
                            <Badge variant={impacto.delta_em < 0 ? "success" : "warning"}>
                              {impacto.delta_em > 0 ? "+" : ""}{impacto.delta_em} un
                            </Badge>
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="text-muted-foreground">Calculando…</div>
                    )}
                  </CardContent>
                </Card>
              )}

              {/* Seção 3 alternativa: atribuir grupo (sku_sem_grupo) */}
              {isSemGrupo && drillEvento.status === "pendente" && (
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">3. Atribuir grupo de produção</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="text-sm">
                      <span className="text-muted-foreground">Fornecedor:</span>{" "}
                      <span className="font-medium">{drillEvento.detalhes?.fornecedor ?? "—"}</span>
                    </div>
                    <div>
                      <Label className="text-xs">Grupo de produção</Label>
                      <Select value={grupoEscolhido} onValueChange={setGrupoEscolhido}>
                        <SelectTrigger>
                          <SelectValue placeholder="Selecione o grupo" />
                        </SelectTrigger>
                        <SelectContent>
                          {(gruposFornecedor ?? []).map((g) => (
                            // SelectItem espera string, mas a lógica original passava o number — preservar via cast
                            <SelectItem key={g.id} value={g.id as unknown as string}>
                              {g.codigo_grupo} — {g.descricao} (LT {g.lt_producao_dias}d)
                            </SelectItem>
                          ))}
                          {(gruposFornecedor ?? []).length === 0 && (
                            <div className="px-2 py-1.5 text-xs text-muted-foreground">
                              Nenhum grupo cadastrado para este fornecedor
                            </div>
                          )}
                        </SelectContent>
                      </Select>
                    </div>
                    <Button
                      className="w-full"
                      disabled={!grupoEscolhido || atribuirGrupoPending}
                      onClick={onAtribuirGrupo}
                    >
                      {atribuirGrupoPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
                      <CheckCircle2 className="h-4 w-4 mr-1" /> Atribuir e marcar como aceito
                    </Button>
                    <p className="text-xs text-muted-foreground">
                      Ao atribuir, o SKU é classificado, o alerta é fechado e os parâmetros de reposição
                      são recalculados com o novo LT de produção.
                    </p>
                  </CardContent>
                </Card>
              )}

              {/* Seção 5 - Decisão padrão (oculta para sku_sem_grupo) */}
              {!isSemGrupo && drillEvento.status === "pendente" && (
                <Card>
                  <CardHeader className="pb-2"><CardTitle className="text-sm">5. Decisão</CardTitle></CardHeader>
                  <CardContent className="space-y-3">
                    <div>
                      <Label className="text-xs">Justificativa (opcional)</Label>
                      <Textarea
                        rows={2}
                        value={justificativa}
                        onChange={(e) => setJustificativa(e.target.value)}
                        placeholder="Ex: pedido excepcional cliente X, não se repete"
                      />
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <Button variant="default" className="bg-success hover:bg-success/90 text-success-foreground" onClick={() => onAcao("aceitar")}>
                        <CheckCircle2 className="h-4 w-4 mr-1" /> Aceitar
                      </Button>
                      <Button variant="destructive" onClick={() => onAcao("excluir")}>
                        <XCircle className="h-4 w-4 mr-1" /> Excluir
                      </Button>
                      <Button variant="secondary" onClick={() => onAcao("ignorar")}>
                        <EyeOff className="h-4 w-4 mr-1" /> Ignorar
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      <strong>Aceitar:</strong> evento real, mantém no cálculo. <strong>Excluir:</strong> one-off, remove da estatística. <strong>Ignorar:</strong> não mexe no dado.
                    </p>
                  </CardContent>
                </Card>
              )}

              {drillEvento.status !== "pendente" && (
                <Card>
                  <CardContent className="pt-4 text-sm space-y-1">
                    <div>Status: {statusBadge(drillEvento.status)}</div>
                    <div className="text-muted-foreground">Por: {drillEvento.decidido_por ?? "—"} em {drillEvento.decidido_em ? new Date(drillEvento.decidido_em).toLocaleString("pt-BR") : "—"}</div>
                    {drillEvento.justificativa_decisao && (
                      <div className="p-2 bg-muted/50 rounded text-xs">{drillEvento.justificativa_decisao}</div>
                    )}
                  </CardContent>
                </Card>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
