// Sheet de decisão do Raio-X (fase B, PR 3). Money-path: "tirar do motor" grava em sku_parametros via
// `raio_x_decidir`. Regras que espelham o SQL ficam em `@/lib/reposicao/raio-x/decisao` (testadas lá).
import { useEffect, useState } from 'react';
import { useReposicaoEmpresa } from '@/contexts/ReposicaoEmpresaContext';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { DESTINOS, ROTULOS } from '@/lib/reposicao/raio-x/classificar';
import {
  argsEstadoSalvo,
  empresaDoRaioX,
  estadoMotor,
  lerNumero,
  MSG_NUMERO_INVALIDO,
  seloFaseA,
  sugestaoInicial,
} from '@/lib/reposicao/raio-x/decisao';
import type { Categoria, DecisaoRow, Destino, Empresa, ItemRaioX } from '@/lib/reposicao/raio-x/tipos';
import { useRaioXMutacoes } from './useRaioXMutacoes';
import { fmtValor } from './formato';

const ROTULO_CATEGORIA: Record<Categoria, string> = {
  mercadoria: 'Mercadoria',
  uso_consumo: 'Uso e consumo / insumo',
  nao_mercadoria: 'Não-mercadoria',
};

const TEXTO_MOTOR = {
  colacor: 'sem motor de reposição — nada a desligar',
  sem_parametro: 'sem parâmetro de reposição — nada a desligar',
  ja_fora: 'já fora do motor',
} as const;

interface Props {
  /** Empresa do ITEM aberto (capturada ao abrir). Se o seletor mudar, o Sheet fecha. */
  empresa: Empresa;
  item: ItemRaioX;
  decisao: DecisaoRow | undefined;
  onClose: () => void;
}

export function DecisaoSheet({ empresa, item, decisao, onClose }: Props) {
  const { empresa: empresaCtx } = useReposicaoEmpresa();
  const empresaDoSeletor = empresaDoRaioX(empresaCtx);

  // Trocar a empresa no seletor com o Sheet aberto fecha: o item é de outra empresa (Review Focus 4).
  useEffect(() => {
    if (empresaDoSeletor !== empresa) onClose();
  }, [empresaDoSeletor, empresa, onClose]);

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{item.descricao ?? item.codigo}</SheetTitle>
          <SheetDescription>
            <span className="font-mono">{item.codigo}</span> · {ROTULO_CATEGORIA[item.categoria]} · {fmtValor(item.valor)}
          </SheetDescription>
        </SheetHeader>
        {/* remonta ao trocar de item: estado local (sujo, campos) nunca vaza entre SKUs */}
        <FormDecisao key={`${empresa}-${item.sku_codigo_omie}`} empresa={empresa} item={item} decisao={decisao} onClose={onClose} />
      </SheetContent>
    </Sheet>
  );
}

function FormDecisao({ empresa, item, decisao, onClose }: Props) {
  const m = useRaioXMutacoes(empresa);
  const sugerido = sugestaoInicial(item);
  const [destino, setDestino] = useState<Destino | null>(decisao?.destino ?? sugerido);
  const [tirar, setTirar] = useState(true);
  const [observacao, setObservacao] = useState(decisao?.observacao ?? '');
  const [fornecedor, setFornecedor] = useState(decisao?.fornecedor_informado ?? '');
  const [credito, setCredito] = useState(
    decisao?.credito_troca != null ? String(decisao.credito_troca).replace('.', ',') : '',
  );
  const [erroCredito, setErroCredito] = useState(false);
  // "Salvar" só depois de um toque: a pré-seleção sozinha não é decisão.
  const [sujo, setSujo] = useState(false);

  const motor = estadoMotor(empresa, item, destino);
  const fase = seloFaseA(decisao);
  const podeTirarAgora = fase && estadoMotor(empresa, item, decisao?.destino) === 'pode_tirar';

  const tocar = () => setSujo(true);

  const escolherDestino = (d: Destino) => {
    tocar();
    if (d !== destino) setTirar(true); // pré-marcado de novo a cada destino-alvo
    setDestino(d);
  };

  const salvar = async () => {
    if (!destino) return;
    let creditoTroca: number | null = null;
    if (destino === 'trocar') {
      const r = lerNumero(credito);
      if (r.erro) {
        setErroCredito(true);
        return;
      }
      creditoTroca = r.valor;
    }
    setErroCredito(false);
    const ok = await m.decidir({
      sku: item.sku_codigo_omie,
      destino,
      categoria: item.categoria,
      observacao: observacao.trim() || null,
      // Fornecedor só é editável quando o cadastro não tem; senão preserva o já informado (S2).
      fornecedor: !item.fornecedor ? fornecedor.trim() || null : (decisao?.fornecedor_informado ?? null),
      creditoTroca,
      tirarDoMotor: motor === 'pode_tirar' && tirar,
      restaurarMotor: false,
    });
    if (ok) onClose();
  };

  const restaurar = async () => {
    if (await m.decidir(argsEstadoSalvo(item, decisao, { restaurarMotor: true }), 'restaurar')) onClose();
  };

  const tirarAgora = async () => {
    if (await m.decidir(argsEstadoSalvo(item, decisao, { tirarDoMotor: true }), 'tirar_agora')) onClose();
  };

  return (
    <div className="mt-4 space-y-5 text-sm">
      {fase && (
        <div className="space-y-2 rounded-md border border-status-warning/40 bg-status-warning/5 p-3">
          <p className="text-status-warning">decidido na fase A — motor não foi tocado</p>
          {podeTirarAgora && (
            <Button size="touch" variant="outline" disabled={m.pendente} onClick={tirarAgora}>
              tirar do motor agora
            </Button>
          )}
        </div>
      )}

      <section className="space-y-2">
        <h3 className="font-medium">Destino</h3>
        {item.destino_sugerido && (
          <p className="text-xs text-muted-foreground">
            sugerido: {ROTULOS[item.destino_sugerido] ?? item.destino_sugerido}
            {item.motivo_destino ? ` — ${item.motivo_destino}` : ''}
          </p>
        )}
        <div role="group" aria-label="Destino" className="grid grid-cols-2 gap-2">
          {DESTINOS.map((d) => (
            <Button
              key={d}
              type="button"
              size="touch"
              variant={destino === d ? 'default' : 'outline'}
              aria-pressed={destino === d}
              onClick={() => escolherDestino(d)}
            >
              {ROTULOS[d]}
            </Button>
          ))}
        </div>
      </section>

      {motor && (
        <section>
          {motor === 'pode_tirar' ? (
            <label className="flex min-h-11 items-center gap-2">
              <input
                type="checkbox"
                checked={tirar}
                onChange={(e) => {
                  tocar();
                  setTirar(e.target.checked);
                }}
              />
              tirar do motor
            </label>
          ) : (
            <p className="text-muted-foreground">{TEXTO_MOTOR[motor]}</p>
          )}
        </section>
      )}

      {destino === 'trocar' && (
        <section className="space-y-1">
          <label htmlFor="rx-credito" className="font-medium">Crédito de troca (R$)</label>
          <Input
            id="rx-credito"
            inputMode="decimal"
            value={credito}
            aria-invalid={erroCredito}
            onChange={(e) => {
              tocar();
              setErroCredito(false);
              setCredito(e.target.value);
            }}
          />
          {erroCredito && <p className="text-xs text-status-error">{MSG_NUMERO_INVALIDO}</p>}
        </section>
      )}

      <section className="space-y-1">
        {!item.fornecedor ? (
          <>
            <label htmlFor="rx-fornecedor" className="font-medium">Fornecedor</label>
            <Input
              id="rx-fornecedor"
              value={fornecedor}
              placeholder="sem fornecedor no cadastro"
              onChange={(e) => {
                tocar();
                setFornecedor(e.target.value);
              }}
            />
          </>
        ) : (
          <p><span className="text-muted-foreground">Fornecedor:</span> {decisao?.fornecedor_informado || item.fornecedor}</p>
        )}
      </section>

      <section className="space-y-1">
        <label htmlFor="rx-obs" className="font-medium">Observação</label>
        <Textarea
          id="rx-obs"
          value={observacao}
          onChange={(e) => {
            tocar();
            setObservacao(e.target.value);
          }}
        />
      </section>

      <Button size="touch" className="w-full" disabled={!sujo || !destino || m.pendente} onClick={salvar}>
        Salvar decisão
      </Button>

      {decisao?.motor_antes != null && (
        <section className="space-y-2 border-t pt-4">
          <p className="text-xs text-status-warning">
            repõe exatamente o estado anterior; ajustes manuais feitos depois serão desfeitos
          </p>
          <Button size="touch" variant="outline" disabled={m.pendente} onClick={restaurar}>
            Restaurar motor ao estado anterior
          </Button>
        </section>
      )}

      <Reclassificar item={item} pendente={m.pendente} onSalvar={async (c, motivo) => {
        if (await m.classificar(item.sku_codigo_omie, c, motivo)) onClose();
      }} />
    </div>
  );
}

function Reclassificar({ item, pendente, onSalvar }: {
  item: ItemRaioX;
  pendente: boolean;
  onSalvar: (c: Categoria, motivo: string) => void;
}) {
  const [aberto, setAberto] = useState(false);
  const [categoria, setCategoria] = useState<Categoria>(item.categoria);
  const [motivo, setMotivo] = useState('');

  if (!aberto) {
    return (
      <div className="border-t pt-4">
        <button type="button" className="min-h-11 text-xs underline underline-offset-2" onClick={() => setAberto(true)}>
          reclassificar
        </button>
      </div>
    );
  }
  return (
    <section className="space-y-2 border-t pt-4">
      <h3 className="font-medium">Reclassificar</h3>
      <p className="text-xs text-muted-foreground">Regra atual: {item.motivo_categoria || ROTULO_CATEGORIA[item.categoria]}</p>
      <label htmlFor="rx-cat" className="block text-xs">Nova categoria</label>
      <select
        id="rx-cat"
        className="h-11 w-full rounded-md border bg-background px-2"
        value={categoria}
        onChange={(e) => setCategoria(e.target.value as Categoria)}
      >
        {(Object.keys(ROTULO_CATEGORIA) as Categoria[]).map((c) => (
          <option key={c} value={c}>{ROTULO_CATEGORIA[c]}</option>
        ))}
      </select>
      <label htmlFor="rx-motivo" className="block text-xs">Motivo</label>
      <Input id="rx-motivo" value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="obrigatório" />
      <Button size="touch" variant="outline" disabled={!motivo.trim() || pendente} onClick={() => onSalvar(categoria, motivo)}>
        Salvar classificação
      </Button>
    </section>
  );
}
