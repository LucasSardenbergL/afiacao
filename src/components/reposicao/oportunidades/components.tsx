import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { TrendingUp, Sparkles, ExternalLink, ArrowRight, Scale } from "lucide-react";
import { OportunidadeComDecisao, AumentoRef } from "./types";
import {
  cenarioIcon, cenarioLabel, formatBRL, formatNumber, formatDate,
  recomendacaoBadgeClass, RECOMENDACAO_LABEL,
} from "./shared";

export function EstadoVazio({ navigate }: { navigate: ReturnType<typeof useNavigate> }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <TrendingUp className="h-16 w-16 text-muted-foreground/40 mb-4" />
      <h3 className="text-xl font-semibold">Nenhuma oportunidade ativa</h3>
      <p className="text-sm text-muted-foreground mt-2 max-w-md">
        Não há promoções ou aumentos ativos que afetem seus SKUs no momento.
        Cadastre promoções ou aumentos para começar.
      </p>
      <div className="flex gap-2 mt-6">
        <Button
          variant="outline"
          onClick={() => navigate("/admin/reposicao/promocoes")}
        >
          Ver promoções
        </Button>
        <Button
          variant="outline"
          onClick={() => navigate("/admin/reposicao/aumentos")}
        >
          Ver aumentos
        </Button>
      </div>
    </div>
  );
}

export function DrawerConteudo({
  o,
  navigate,
}: {
  o: OportunidadeComDecisao;
  navigate: ReturnType<typeof useNavigate>;
}) {
  const incluiPromo = o.cenario.startsWith("promo");
  const incluiAumento =
    o.cenario === "aumento_apenas" || o.cenario === "promo_e_aumento";
  const aumentos = (o.aumentos_json ?? []) as AumentoRef[];
  const d = o.decisao;

  return (
    <>
      <SheetHeader>
        <div className="flex items-center gap-2">
          {cenarioIcon(o.cenario)}
          <Badge variant="outline">{cenarioLabel(o.cenario)}</Badge>
        </div>
        <SheetTitle className="text-left">
          {o.sku_descricao ?? "Sem descrição"}
        </SheetTitle>
        <SheetDescription className="text-left tabular-nums">
          SKU {o.sku_codigo_omie} · {o.fornecedor_nome ?? "—"}
        </SheetDescription>
      </SheetHeader>

      <div className="mt-6 space-y-5">
        {/* Parâmetros */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Parâmetros operacionais</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Linha label="Demanda diária" value={formatNumber(o.demanda_diaria, 2)} />
            <Linha label="Preço EOQ" value={formatBRL(o.preco_item_eoq)} />
            <Linha
              label="Custo de capital"
              value={`${formatNumber(o.custo_capital_efetivo_perc, 2)}%`}
            />
            <Linha label="Quantidade base (EOQ)" value={formatNumber(o.qtde_base, 0)} />
            <Linha
              label="Quantidade sugerida"
              value={formatNumber(o.qtde_oportunidade, 0)}
              highlight
            />
          </CardContent>
        </Card>

        {/* Promoção */}
        {incluiPromo && o.campanha_id && (
          <Card className="border-status-warning/30 bg-status-warning/5">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-status-warning" />
                Promoção ativa
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="font-medium">{o.campanha_nome}</div>
              <Linha
                label="Modo"
                value={o.modo_promo === "volume" ? "Volume" : "Flat"}
              />
              <Linha
                label="Desconto base"
                value={`${formatNumber(o.desconto_promo_perc, 2)}%`}
              />
              {o.tem_negociacao_extra && (
                <Linha label="Negociação extra" value="Sim" />
              )}
              <Linha
                label="Corte do pedido"
                value={formatDate(o.promo_data_corte_pedido)}
              />
              <Linha
                label="Corte do faturamento"
                value={formatDate(o.promo_data_corte_faturamento)}
              />
              <Button
                variant="outline"
                size="sm"
                className="w-full mt-2"
                onClick={() => navigate(`/admin/reposicao/promocoes/${o.campanha_id}`)}
              >
                <ExternalLink className="h-3 w-3 mr-2" />
                Ver campanha
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Aumentos */}
        {incluiAumento && aumentos.length > 0 && (
          <Card className="border-status-error/30 bg-status-error/5">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-status-error" />
                {aumentos.length === 1
                  ? "Aumento afetando este SKU"
                  : `${aumentos.length} aumentos afetando este SKU`}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {aumentos.map((a, i) => (
                <div
                  key={`${a.aumento_id}-${i}`}
                  className="space-y-1.5 pb-3 border-b last:border-0 last:pb-0 text-sm"
                >
                  <div className="font-medium">{a.aumento_nome ?? "Aumento"}</div>
                  {a.categoria && (
                    <div className="text-xs text-muted-foreground">
                      Categoria: {a.categoria}
                    </div>
                  )}
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Vigência</span>
                    <span className="tabular-nums">{formatDate(a.data_vigencia)}</span>
                  </div>
                  {typeof a.aumento_perc === "number" && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">% aumento</span>
                      <span className="font-medium tabular-nums text-status-error">
                        +{formatNumber(a.aumento_perc, 2)}%
                      </span>
                    </div>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full mt-1"
                    onClick={() => navigate(`/admin/reposicao/aumentos/${a.aumento_id}`)}
                  >
                    <ExternalLink className="h-3 w-3 mr-2" />
                    Ver aumento
                  </Button>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {/* Cálculo */}
        <Card className="border-status-success/30 bg-status-success/5">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Cálculo da economia</CardTitle>
          </CardHeader>
          <CardContent className="text-sm leading-relaxed">
            Comprando{" "}
            <strong>{formatNumber(o.qtde_oportunidade, 0)} unidades</strong> nos
            próximos{" "}
            <strong>
              {o.dias_ate_limite ?? "—"}{" "}
              {o.dias_ate_limite === 1 ? "dia" : "dias"}
            </strong>{" "}
            você captura{" "}
            <strong>{formatNumber(o.desconto_total_perc, 2)}%</strong> de
            benefício total, economizando{" "}
            <strong className="text-status-success">
              {formatBRL(o.economia_bruta_estimada)}
            </strong>{" "}
            bruto.
          </CardContent>
        </Card>

        {/* Decisão net-R$ marginal */}
        <Card className="border-status-info/30 bg-status-info/5">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Scale className="h-4 w-4 text-status-info" />
              Decisão: comprar mais?
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <Badge
                variant="outline"
                className={recomendacaoBadgeClass(d.recomendacao)}
              >
                {RECOMENDACAO_LABEL[d.recomendacao]}
              </Badge>
              <span className="tabular-nums font-medium">
                {formatNumber(d.q_base, 0)} → {formatNumber(d.q_candidata, 0)}
              </span>
            </div>

            <div className="space-y-1.5 border-t pt-3">
              <LinhaRs label="+ Desconto" value={d.desconto_rs} />
              <LinhaRs label="+ Aumento evitado" value={d.aumento_evitado_rs} />
              <LinhaRs label="+ Ruptura evitada" value={d.ruptura_evitada_rs} />
              <LinhaRs label="− Capital extra" value={-d.capital_extra_rs} />
              <LinhaRs label="− Prazo" value={-d.impacto_prazo_rs} />
              <LinhaRs label="− Frete" value={-d.frete_incremental_rs} />
              <div className="flex justify-between border-t pt-2 mt-1">
                <span className="font-semibold">Net R$</span>
                <span
                  className={`tabular-nums font-bold ${
                    d.beneficio_liquido_rs > 0
                      ? "text-status-success"
                      : d.beneficio_liquido_rs < 0
                        ? "text-status-error"
                        : "text-muted-foreground"
                  }`}
                >
                  {formatBRL(d.beneficio_liquido_rs)}
                </span>
              </div>
            </div>

            {d.flags.length > 0 && (
              <ul className="border-t pt-3 space-y-1 text-xs text-muted-foreground list-disc pl-4">
                {d.flags.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Button
          className="w-full"
          onClick={() => navigate(`/admin/reposicao/skus/${o.sku_codigo_omie}`)}
        >
          <ArrowRight className="h-4 w-4 mr-2" />
          Ir para SKU em reposição
        </Button>
      </div>
    </>
  );
}

function LinhaRs({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={`tabular-nums ${
          value > 0
            ? "text-status-success"
            : value < 0
              ? "text-status-error"
              : "text-muted-foreground"
        }`}
      >
        {formatBRL(value)}
      </span>
    </div>
  );
}

function Linha({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className={`tabular-nums ${highlight ? "font-semibold" : ""}`}>
        {value}
      </span>
    </div>
  );
}
