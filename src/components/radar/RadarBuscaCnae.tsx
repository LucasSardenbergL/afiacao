import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { buscarCnaesAlvo, formatarCnae, nomeCnaeAlvo, digitosCnae, type CnaeAlvo } from '@/lib/radar/ui-helpers';
import { track } from '@/lib/analytics';
import { cn } from '@/lib/utils';

/** Texto só de código (dígitos e pontuação do formato oficial): vai direto ao filtro, como antes. */
const ehCodigo = (t: string) => /^[\d\s./-]*$/.test(t);

/**
 * Campo de CNAE que aceita o CÓDIGO (3101-2/00, ou parcial = família) ou o NOME da atividade
 * ("marmoraria", "móveis madeira"). Nome não vai ao filtro: ele sugere os CNAEs-alvo do catálogo
 * e só a escolha de um aplica o código. Assim a URL nunca guarda um texto que não filtra nada.
 */
export function RadarBuscaCnae({ valor, onChange }: { valor: string; onChange: (cnae: string) => void }) {
  const [texto, setTexto] = useState(valor);
  const [valorVisto, setValorVisto] = useState(valor);
  const [aberto, setAberto] = useState(false);
  const [ativo, setAtivo] = useState(0);

  // Valor trocado de fora (favorito aplicado, "limpar"): o campo acompanha.
  if (valor !== valorVisto) {
    setValorVisto(valor);
    setTexto(valor);
  }

  const sugestoes: CnaeAlvo[] = aberto ? buscarCnaesAlvo(texto) : [];
  const nomeEscolhido = digitosCnae(valor).length === 7 ? nomeCnaeAlvo(valor) : null;

  const escolher = (c: CnaeAlvo) => {
    const fmt = formatarCnae(c.codigo);
    track('radar.cnae_escolhido', { codigo: c.codigo, por_nome: !ehCodigo(texto) });
    setTexto(fmt);
    setValorVisto(fmt);
    setAberto(false);
    onChange(fmt);
  };

  const digitar = (t: string) => {
    setTexto(t);
    setAtivo(0);
    setAberto(true);
    if (ehCodigo(t)) { setValorVisto(t); onChange(t); }
  };

  return (
    <div className="relative w-56">
      <Input
        role="combobox"
        aria-expanded={aberto && sugestoes.length > 0}
        aria-controls="radar-cnae-sugestoes"
        aria-label="CNAE: código ou nome da atividade"
        placeholder="CNAE ou atividade (ex.: marcenaria)"
        value={texto}
        title={nomeEscolhido ?? undefined}
        onFocus={() => setAberto(true)}
        // Saiu sem escolher: o nome digitado não filtra, então o campo volta a mostrar o filtro real.
        onBlur={() => { setAberto(false); if (!ehCodigo(texto)) setTexto(valor); }}
        onChange={(e) => digitar(e.target.value)}
        onKeyDown={(e) => {
          if (!sugestoes.length) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setAtivo((i) => Math.min(i + 1, sugestoes.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setAtivo((i) => Math.max(i - 1, 0)); }
          else if (e.key === 'Enter') { e.preventDefault(); escolher(sugestoes[Math.min(ativo, sugestoes.length - 1)]); }
          else if (e.key === 'Escape') setAberto(false);
        }}
      />
      {nomeEscolhido && !aberto && (
        <div className="absolute left-0 right-0 top-full mt-0.5 truncate text-[11px] text-muted-foreground" title={nomeEscolhido}>
          {nomeEscolhido}
        </div>
      )}
      {sugestoes.length > 0 && (
        <ul
          id="radar-cnae-sugestoes"
          role="listbox"
          className="absolute z-50 left-0 mt-1 w-80 max-h-72 overflow-y-auto rounded-md border bg-popover p-1 shadow-md"
        >
          {sugestoes.map((c, i) => (
            <li
              key={c.codigo}
              role="option"
              aria-selected={i === ativo}
              // mousedown (não click): o blur do input fecharia a lista antes do click chegar.
              onMouseDown={(e) => { e.preventDefault(); escolher(c); }}
              onMouseEnter={() => setAtivo(i)}
              className={cn('cursor-pointer rounded px-2 py-1 text-sm', i === ativo && 'bg-accent')}
            >
              <div className="leading-tight">{c.nome}</div>
              <div className="text-[11px] text-muted-foreground tabular-nums">{formatarCnae(c.codigo)} · {c.grupo}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
