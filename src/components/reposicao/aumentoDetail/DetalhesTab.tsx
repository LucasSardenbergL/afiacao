// Tab "Detalhes" do detalhe de aumento: card de extração via Vision + form de dados.
// Extraído de src/pages/AdminReposicaoAumentoDetail.tsx (god-component split).
// Presentational: recebe o form + setter + callbacks; estado/mutações ficam na página.
import type { Dispatch, SetStateAction } from "react";
import { ExternalLink, Loader2, Mail, Save, Sparkles } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { Aumento } from "./types";
import { confiancaClass } from "./shared";

export function DetalhesTab({
  form,
  setForm,
  onOpenOriginalFile,
  onSave,
  saving,
}: {
  form: Partial<Aumento>;
  setForm: Dispatch<SetStateAction<Partial<Aumento>>>;
  onOpenOriginalFile: () => void;
  onSave: () => void;
  saving: boolean;
}) {
  return (
    <>
      {form.origem_arquivo_url && (
        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="pt-6 space-y-3">
            <div className="flex items-start gap-3">
              <Sparkles className="h-5 w-5 text-primary shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">Extraído via Vision</span>
                  {form.extracao_confianca !== null &&
                    form.extracao_confianca !== undefined && (
                      <Badge
                        variant="outline"
                        className={confiancaClass(form.extracao_confianca)}
                      >
                        Confiança {Math.round(form.extracao_confianca * 100)}%
                      </Badge>
                    )}
                  <Button variant="outline" size="sm" onClick={onOpenOriginalFile}>
                    <ExternalLink className="h-4 w-4" /> Ver arquivo original
                  </Button>
                </div>
                {form.extracao_observacoes && (
                  <p className="text-sm italic text-muted-foreground">
                    {form.extracao_observacoes}
                  </p>
                )}
                {form.origem_email_remetente && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Mail className="h-3 w-3" />
                    <span>
                      De: {form.origem_email_remetente}
                      {form.origem_email_assunto &&
                        ` · Assunto: ${form.origem_email_assunto}`}
                      {form.origem_email_data &&
                        ` · Recebido: ${new Date(form.origem_email_data).toLocaleDateString("pt-BR")}`}
                    </span>
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Dados do anúncio</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="nome">Nome *</Label>
            <Input
              id="nome"
              value={form.nome ?? ""}
              onChange={(e) => setForm({ ...form, nome: e.target.value })}
              placeholder="Ex: Reajuste de Preços Maio 2026"
            />
          </div>

          <div>
            <Label htmlFor="fornecedor">Fornecedor</Label>
            <Input
              id="fornecedor"
              value={form.fornecedor_nome ?? ""}
              readOnly={!!form.origem_arquivo_url}
              onChange={(e) => setForm({ ...form, fornecedor_nome: e.target.value })}
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="data_vigencia">Data de vigência *</Label>
              <Input
                id="data_vigencia"
                type="date"
                value={form.data_vigencia ?? ""}
                onChange={(e) => setForm({ ...form, data_vigencia: e.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="data_anuncio">Data do anúncio</Label>
              <Input
                id="data_anuncio"
                type="date"
                value={form.data_anuncio ?? ""}
                onChange={(e) =>
                  setForm({ ...form, data_anuncio: e.target.value || null })
                }
              />
            </div>
          </div>

          <div>
            <Label htmlFor="observacoes">Observações</Label>
            <Textarea
              id="observacoes"
              rows={3}
              value={form.observacoes ?? ""}
              onChange={(e) => setForm({ ...form, observacoes: e.target.value })}
            />
          </div>

          <Button onClick={onSave} disabled={saving}>
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            Salvar alterações
          </Button>
        </CardContent>
      </Card>
    </>
  );
}
