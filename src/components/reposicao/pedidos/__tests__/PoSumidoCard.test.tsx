import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PoSumidoCard } from '../PoSumidoCard';
import type { PoCandidato } from '../po-sumido';

// Os estados em que a UI pode MENTIR — os quatro achados P1 do review adversarial. Cada teste aqui
// existe porque a versão anterior do card errava exatamente nesse ponto.

const base: PoCandidato = {
  pedido_id: 1,
  omie_codigo_pedido: '1073',
  data_ciclo: '2026-05-27',
  idade_dias: 50,
  na_janela_7d: false,
  valor_total: 100,
  visto_status: 'sem_registro_last_seen',
  fornecedor_nome: 'Sayerlack',
  canal_usado: 'portal_sayerlack',
  portal_protocolo: null,
  status_envio_portal: null,
  algum_sinal_de_canal: false,
};
const c = (over: Partial<PoCandidato> = {}): PoCandidato => ({ ...base, ...over });

describe('PoSumidoCard — os estados em que dá para mentir', () => {
  it('lista vazia APURADA não renderiza nada (aí "não há" é verdade)', () => {
    const { container } = render(<PoSumidoCard candidatos={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('apurando: aparece "apurando", NUNCA silêncio — "ainda não sei" ≠ "não há"', () => {
    render(<PoSumidoCard candidatos={[]} apurando />);
    expect(screen.getByText(/apurando/i)).toBeInTheDocument();
  });

  it('falha de apuração: grita que NÃO sabe, em vez de sumir', () => {
    render(<PoSumidoCard candidatos={[]} falhaApuracao />);
    expect(screen.getByText(/não foi possível apurar/i)).toBeInTheDocument();
    expect(screen.getByText(/significa que não sabemos/i)).toBeInTheDocument();
  });

  it('TODOS sem valor: diz "não apurado" e NUNCA imprime R$ 0,00', () => {
    // O furo mais grave do review: [].reduce(soma, 0) === 0 fazia o card anunciar "Total conhecido
    // R$ 0,00" quando nenhum valor havia sido apurado — fabricar zero é fabricar um fato.
    render(<PoSumidoCard candidatos={[c({ pedido_id: 1, valor_total: null }), c({ pedido_id: 2, valor_total: null })]} />);
    expect(screen.getByText(/não apurado/i)).toBeInTheDocument();
    expect(screen.queryByText(/R\$\s*0,00/)).not.toBeInTheDocument();
  });

  it('misto: apresenta SUBTOTAL declarado, não "total"', () => {
    render(<PoSumidoCard candidatos={[c({ pedido_id: 1, valor_total: 100 }), c({ pedido_id: 2, valor_total: null })]} />);
    expect(screen.getByText(/subtotal de 1 de 2 pedidos/i)).toBeInTheDocument();
  });

  it('título é NEUTRO: não afirma ausência de PO (há linha em que nem deu para comparar)', () => {
    render(<PoSumidoCard candidatos={[c({ visto_status: 'identidade_nao_interpretavel' })]} />);
    expect(screen.getByText(/a reconciliar no Omie/i)).toBeInTheDocument();
    // "Pedidos sem PO" seria uma afirmação que a evidência não sustenta para identidade ilegível.
    expect(screen.queryByText(/pedidos sem PO/i)).not.toBeInTheDocument();
  });

  it('o card recolhido nunca instrui cancelar — avisa para NÃO cancelar sem conferir', () => {
    render(<PoSumidoCard candidatos={[c()]} />);
    expect(screen.getByText(/não cancele sem conferir/i)).toBeInTheDocument();
  });

  it('a copy recolhida NÃO afirma ausência: diz "não foi confirmado", não "não foi encontrado"', () => {
    // Neutralizar só o título era meia-correção — o parágrafo logo abaixo continuava afirmando que o
    // PO "não foi encontrado", falso para as linhas em que nem foi possível comparar.
    render(<PoSumidoCard candidatos={[c()]} />);
    expect(screen.getByText(/não foi confirmado na última varredura/i)).toBeInTheDocument();
    expect(screen.queryByText(/não foi encontrado/i)).not.toBeInTheDocument();
  });

  it('havendo linha ilegível, o card recolhido DIZ que ali não deu para comparar', () => {
    render(<PoSumidoCard candidatos={[
      c({ pedido_id: 1, visto_status: 'identidade_nao_interpretavel' }),
      c({ pedido_id: 2 }),
    ]} />);
    expect(screen.getByText(/não foi possível comparar/i)).toBeInTheDocument();
    expect(screen.getByText(/1 desse pedido/i)).toBeInTheDocument();
  });

  it('sem linha ilegível, não inventa a ressalva', () => {
    render(<PoSumidoCard candidatos={[c()]} />);
    expect(screen.queryByText(/não foi possível comparar/i)).not.toBeInTheDocument();
  });

  it('falha transitória COM lista anterior: mantém os dados e marca como desatualizado', () => {
    // Apagar pedido/protocolo/valor legítimos por um erro de rede seria trocar uma mentira por uma
    // perda. A lista é do próprio usuário (a chave da query é escopada pelo principal).
    render(<PoSumidoCard candidatos={[c({ fornecedor_nome: 'Sayerlack' })]} falhaApuracao />);
    // O aviso aparece em DOIS lugares de propósito (badge no título + parágrafo), por isso texto exato
    // em cada um: uma regex frouxa casaria os dois e o getByText exige elemento único.
    expect(screen.getByText('pode estar desatualizado')).toBeInTheDocument();
    expect(screen.getByText(/a última verificação falhou/i)).toBeInTheDocument();
    expect(screen.getByText(/a reconciliar no Omie/i)).toBeInTheDocument();
  });

  it('DESATUALIZADO não instrui recriar o PO — instrução sobre estado velho gera PO duplicado', () => {
    // O caminho que isso fecha: apuração encontra o candidato → o PO é recriado → o poll seguinte
    // falha → o card continua mandando "recrie o PO no Omie" → o comprador recria de novo.
    // Manter a EVIDÊNCIA é útil; manter a AÇÃO é o mesmo dano que este PR combate, pelo outro lado.
    const cand = c({ algum_sinal_de_canal: true, portal_protocolo: '2097501' });
    const { container } = render(<PoSumidoCard candidatos={[cand]} falhaApuracao />);
    // EXPANDIR é obrigatório: o card nasce recolhido e a coluna "O que fazer" só existe aberta — sem
    // o clique este teste passaria por estar fechado, não por a instrução ter sido suprimida.
    fireEvent.click(screen.getByText(/a reconciliar no Omie/i));
    const texto = container.textContent ?? '';
    expect(texto).toMatch(/2097501/); // a EVIDÊNCIA continua lá
    expect(texto).not.toMatch(/recrie o PO/i); // a INSTRUÇÃO não
    expect(texto).toMatch(/apuração está desatualizada/i);
  });

  it('o guarda acima tem dente: com apuração OK, expandido, a instrução APARECE', () => {
    const cand = c({ algum_sinal_de_canal: true, portal_protocolo: '2097501' });
    const { container } = render(<PoSumidoCard candidatos={[cand]} />);
    fireEvent.click(screen.getByText(/a reconciliar no Omie/i));
    expect(container.textContent ?? '').toMatch(/recrie o PO/i);
  });

  it('DESATUALIZADO põe os fatos no passado — sem afirmar estado atual', () => {
    const { container } = render(<PoSumidoCard candidatos={[c({ na_janela_7d: true })]} falhaApuracao />);
    const texto = container.textContent ?? '';
    expect(texto).toMatch(/na última apuração/i);
    // "está disparado ... infla o estoque" afirma o AGORA, e o agora não foi verificado.
    expect(texto).not.toMatch(/isso infla o estoque/i);
    expect(texto).not.toMatch(/na janela de 7 dias/i);
  });

  it('DESATUALIZADO não ESCONDE a urgência: diz que estava na janela', () => {
    // Suprimir o badge era o pior dos dois lados — escondia dano que de fato havia na última apuração.
    // O fato fica visível, no tempo verbal certo.
    render(<PoSumidoCard candidatos={[c({ na_janela_7d: true })]} falhaApuracao />);
    expect(screen.getByText(/1 estava na janela na última apuração/i)).toBeInTheDocument();
  });

  it('DESATUALIZADO, EXPANDIDO: a linha também não afirma "na janela" no presente', () => {
    // O teste anterior não pegava isto porque a tabela nem é montada com o card recolhido — mesmo erro
    // que já tinha me escapado uma vez.
    const { container } = render(<PoSumidoCard candidatos={[c({ na_janela_7d: true })]} falhaApuracao />);
    fireEvent.click(screen.getByText(/a reconciliar no Omie/i));
    const texto = container.textContent ?? '';
    expect(texto).toMatch(/estava na janela/i);
    expect(texto).not.toMatch(/· na janela(?! na última)/i);
  });

  it('apuração OK volta a afirmar o presente e a instruir', () => {
    // Espelho: sem isto, suprimir tudo sempre também passaria.
    const { container } = render(
      <PoSumidoCard candidatos={[c({ na_janela_7d: true, algum_sinal_de_canal: true, portal_protocolo: '2097501' })]} />,
    );
    fireEvent.click(screen.getByText(/a reconciliar no Omie/i));
    const texto = container.textContent ?? '';
    expect(texto).toMatch(/isso infla o estoque/i);
    expect(texto).toMatch(/na janela de 7 dias/i);
    expect(texto).not.toMatch(/na última apuração/i);
    expect(texto).not.toMatch(/estava na janela/i);
  });

  it('apuração OK exige reconferir QUALQUER PO ativo — não o número antigo mostrado na linha', () => {
    // O caminho que isso fecha: A recria a compra sob um PO NOVO; B olha esta tabela, que mostra o
    // número ANTIGO, confirma que o antigo continua ausente (é verdade) e cria um segundo PO.
    const { container } = render(
      <PoSumidoCard candidatos={[c({ algum_sinal_de_canal: true, portal_protocolo: '2097501' })]} />,
    );
    fireEvent.click(screen.getByText(/a reconciliar no Omie/i));
    const texto = container.textContent ?? '';
    expect(texto).toMatch(/não existe nenhum pedido de compra ativo/i);
    expect(texto).toMatch(/busque por fornecedor e protocolo/i);
    expect(texto).toMatch(/não pelo número antigo/i);
    expect(texto).toMatch(/recrie o PO/i);
  });
});
