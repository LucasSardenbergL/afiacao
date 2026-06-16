// Aba de Configuração do DES: cadastra/edita a meta trimestral (des_meta_empresa).
// Master-only (gate de UI + RLS). Reusa o schema existente — sem migration.
import { Info, Lock, Save } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Props } from "./configuracao/types";
import { useConfiguracaoMeta } from "./configuracao/useConfiguracaoMeta";

export function ConfiguracaoTab({ empresa, ano: anoAtual, trimestre: trimestreAtual }: Props) {
  const {
    isMaster,
    ano,
    setAno,
    trimestre,
    setTrimestre,
    anos,
    metaInput,
    setMetaInput,
    faixaInput,
    setFaixaInput,
    observacoes,
    setObservacoes,
    metaOk,
    faixaOk,
    faixaVazia,
    periodo,
    existe,
    saving,
    isLoading,
    salvar,
  } = useConfiguracaoMeta(empresa, anoAtual, trimestreAtual);

  const editavel = isMaster && !saving;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-medium">Meta trimestral · {empresa}</CardTitle>
          <p className="text-xs text-muted-foreground">
            Meta de faturamento por trimestre. Ancora o gap, o histórico e a posição ao vivo do DES.
          </p>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Seletor de período */}
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Ano</Label>
              <Select value={String(ano)} onValueChange={(v) => setAno(Number(v))}>
                <SelectTrigger className="w-[110px] h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {anos.map((a) => (
                    <SelectItem key={a} value={String(a)}>
                      {a}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Trimestre</Label>
              <Select value={String(trimestre)} onValueChange={(v) => setTrimestre(Number(v))}>
                <SelectTrigger className="w-[110px] h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[1, 2, 3, 4].map((t) => (
                    <SelectItem key={t} value={String(t)}>
                      T{t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Aviso de período não-corrente */}
          {periodo !== "corrente" && (
            <div className="flex items-start gap-2 rounded-md border border-status-warning/30 bg-status-warning/5 p-3">
              <Info className="h-4 w-4 text-status-warning mt-0.5 shrink-0" />
              <p className="text-xs text-foreground">
                Editando um trimestre {periodo === "passado" ? "passado" : "futuro"}.
                {periodo === "passado" &&
                  " Alterar a meta muda o histórico, os gráficos e a posição derivada."}
              </p>
            </div>
          )}

          {isLoading ? (
            <Skeleton className="h-48 w-full" />
          ) : (
            <>
              {!isMaster && (
                <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-3">
                  <Lock className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                  <p className="text-xs text-muted-foreground">
                    Somente um usuário master pode cadastrar ou editar metas. Você pode visualizar.
                  </p>
                </div>
              )}

              {/* Meta de faturamento */}
              <div className="space-y-1.5">
                <Label htmlFor="meta-faturamento">Meta de faturamento (R$)</Label>
                <Input
                  id="meta-faturamento"
                  inputMode="decimal"
                  placeholder="Ex: 400.840"
                  value={metaInput}
                  onChange={(e) => setMetaInput(e.target.value)}
                  disabled={!editavel}
                  className="max-w-xs"
                />
                {metaInput.trim() !== "" && !metaOk && (
                  <p className="text-xs text-status-error">
                    Valor inválido. Use um número maior que zero.
                  </p>
                )}
              </div>

              {/* Faixa-alvo */}
              <div className="space-y-1.5">
                <Label htmlFor="faixa-alvo">
                  Faixa DES-alvo{" "}
                  <span className="font-normal text-muted-foreground">(opcional)</span>
                </Label>
                <Input
                  id="faixa-alvo"
                  inputMode="numeric"
                  placeholder="Ex: 3"
                  value={faixaInput}
                  onChange={(e) => setFaixaInput(e.target.value)}
                  disabled={!editavel}
                  className="w-[120px]"
                />
                {!faixaVazia && !faixaOk && (
                  <p className="text-xs text-status-error">
                    Use um número inteiro ≥ 1, ou deixe em branco.
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  Número da faixa que se quer atingir no trimestre.
                </p>
              </div>

              {/* Observações */}
              <div className="space-y-1.5">
                <Label htmlFor="meta-obs">
                  Observações <span className="font-normal text-muted-foreground">(opcional)</span>
                </Label>
                <Textarea
                  id="meta-obs"
                  rows={3}
                  placeholder="Contexto da meta, premissas, etc."
                  value={observacoes}
                  onChange={(e) => setObservacoes(e.target.value)}
                  disabled={!editavel}
                  className="max-w-xl"
                />
              </div>

              <div className="flex flex-wrap items-center gap-3 pt-1">
                <Button onClick={salvar} disabled={!editavel || !metaOk || !faixaOk}>
                  <Save className="h-4 w-4 mr-2" />
                  {saving ? "Salvando..." : existe ? "Atualizar meta" : "Cadastrar meta"}
                </Button>
                {existe && (
                  <span className="text-xs text-muted-foreground">
                    Já existe meta para {empresa} · {ano} · T{trimestre}.
                  </span>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
