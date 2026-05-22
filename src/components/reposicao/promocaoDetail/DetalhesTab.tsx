// Tab "Detalhes" — painel de extração Vision + formulário de dados da campanha.
// Extraída de src/pages/AdminReposicaoPromocaoDetail.tsx (god-component split).
import {
  Loader2,
  Save,
  FileText,
  ExternalLink,
  Mail,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { TabsContent } from "@/components/ui/tabs";
import {
  confiancaBadge,
  formatDateTimeBR,
} from "@/components/reposicao/promocaoDetail/helpers";
import { type Campanha } from "@/components/reposicao/promocaoDetail/types";

type DetalhesTabProps = {
  campanha: Campanha | null | undefined;
  signedUrl: string | null;
  formNome: string;
  setFormNome: (value: string) => void;
  formInicio: string;
  setFormInicio: (value: string) => void;
  formFim: string;
  setFormFim: (value: string) => void;
  formObs: string;
  setFormObs: (value: string) => void;
  tipoOrigem: string | undefined;
  isNew: boolean;
  onSave: () => void;
  saving: boolean;
};

export function DetalhesTab({
  campanha,
  signedUrl,
  formNome,
  setFormNome,
  formInicio,
  setFormInicio,
  formFim,
  setFormFim,
  formObs,
  setFormObs,
  tipoOrigem,
  isNew,
  onSave,
  saving,
}: DetalhesTabProps) {
  return (
    <TabsContent value="detalhes" className="space-y-4">
      {/* Painel de extração Vision */}
      {campanha?.origem_arquivo_url && (
        <Card className="border-primary/30 bg-primary/5">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              Extração via IA
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              {confiancaBadge(campanha.extracao_confianca)}
              {campanha.extraido_em && (
                <span className="text-xs text-muted-foreground">
                  {formatDateTimeBR(campanha.extraido_em)}
                </span>
              )}
            </div>
            {campanha.extracao_observacoes && (
              <p className="text-sm italic text-muted-foreground">
                {campanha.extracao_observacoes}
              </p>
            )}
            {campanha.origem_email_remetente && (
              <div className="flex items-start gap-2 text-xs text-muted-foreground">
                <Mail className="h-3 w-3 mt-0.5 shrink-0" />
                <div>
                  De: {campanha.origem_email_remetente}
                  {campanha.origem_email_assunto && (
                    <>
                      {" "}
                      · Assunto:{" "}
                      <span className="italic">
                        {campanha.origem_email_assunto}
                      </span>
                    </>
                  )}
                </div>
              </div>
            )}
            {signedUrl && (
              <Button variant="outline" size="sm" asChild>
                <a href={signedUrl} target="_blank" rel="noopener noreferrer">
                  <FileText className="h-4 w-4" /> Ver arquivo original
                  <ExternalLink className="h-3 w-3" />
                </a>
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {/* Formulário */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Dados da campanha</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>Nome</Label>
            <Input
              value={formNome}
              onChange={(e) => setFormNome(e.target.value)}
              placeholder="Ex: DES Promo Abril 2ª Quinzena 2026"
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label>Fornecedor</Label>
              <Input
                value="Renner Sayerlack S/A"
                disabled
                className="bg-muted"
              />
            </div>
            <div>
              <Label>Tipo de origem</Label>
              <div className="h-10 flex items-center">
                {tipoOrigem === "negociacao_cliente" ? (
                  <Badge
                    variant="outline"
                    className="bg-status-info/15 text-status-info border-status-info/30"
                  >
                    Negociação
                  </Badge>
                ) : (
                  <Badge variant="outline">Fornecedor</Badge>
                )}
              </div>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label>Data início</Label>
              <Input
                type="date"
                value={formInicio}
                onChange={(e) => setFormInicio(e.target.value)}
              />
            </div>
            <div>
              <Label>Data fim</Label>
              <Input
                type="date"
                value={formFim}
                onChange={(e) => setFormFim(e.target.value)}
              />
            </div>
          </div>
          <div>
            <Label>Observações</Label>
            <Textarea
              value={formObs}
              onChange={(e) => setFormObs(e.target.value)}
              rows={3}
            />
          </div>
          <Button onClick={onSave} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            <Save className="h-4 w-4" />{" "}
            {isNew ? "Criar campanha" : "Salvar alterações"}
          </Button>
        </CardContent>
      </Card>
    </TabsContent>
  );
}
