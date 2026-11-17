# MINUTA — Termo do Promoter da TICK (para revisão do advogado)

> **Não é versão definitiva e não está publicado.** Rascunho técnico que
> descreve as regras que o sistema aplica hoje (regras 3 a 9 e decisão B de
> `docs/trimundi/decisoes-comerciais-2026-11-14.md`). Tudo entre
> [colchetes] é dado que falta ou decisão aberta (P-1 a P-10 do desenho de
> Promoters, seção 5). Nenhum dado jurídico, fiscal ou cadastral foi
> inventado: a identificação da operadora é a dos Termos v1.3 publicados.

## 1. Quem são as partes
- **Operadora da plataforma:** [nome empresarial e CNPJ, como nos Termos
  v1.3], com sede em [endereço completo — pendente, B4].
- **Promoter:** a pessoa titular da conta TICK que pediu para ser promoter e
  foi aprovada pela organização.

## 2. O que é ser promoter
1. O promoter divulga os eventos da TICK pelo **link pessoal** da sua conta.
2. A permissão de promoter é concedida pela organização e pode ser suspensa
   ou encerrada [motivos — definir]. Ela **não** dá acesso à portaria
   (validação de ingressos).
3. [Se o promoter também for operador de portaria: as duas permissões são
   independentes (P-10).]

## 3. O que conta como venda
1. Cada ingresso **pago** comprado por outra pessoa pelo link do promoter
   conta uma venda. Cortesias não contam.
2. A compra feita com a própria conta (ou o mesmo CPF) não conta.
3. Só contam as vendas confirmadas **depois** da aprovação do promoter (sem
   efeito retroativo).
4. A contagem é **por edição** do evento e recomeça em cada edição.
5. Ingresso reembolsado ou cancelado deixa de contar.

## 4. Comissão
1. **Base:** o valor efetivamente pago pelo ingresso, já com descontos e
   combos, **sem as taxas** de pagamento.
2. **Percentual**, pela ordem da venda na edição:

   | Vendas na edição | 1–19 | 20–29 | 30–39 | 40–49 | 50–59 | 60+ |
   |---|---|---|---|---|---|---|
   | Comissão | 10% | 11% | 12% | 13% | 14% | 15% (teto) |

3. O novo percentual vale para a venda que atingiu a faixa e para as
   seguintes. **Não há efeito retroativo** sobre vendas anteriores.
4. Reembolso desconta a venda da contagem; as vendas seguintes seguem a
   contagem atualizada [confirmar — P-3].
5. **Abaixo de 10 vendas** na edição, a comissão é **provisória**.
   [Se a edição terminar sem 10 vendas, a comissão provisória é cancelada —
   esta cláusula só vale se estiver neste termo aceito (regra 8).]
6. Arredondamento ao centavo, meio centavo para cima.

## 5. Pagamento
1. O pagamento é **manual**, feito pela organização, e registrado na
   plataforma com data, meio e referência. O promoter acompanha a situação
   de cada venda na sua conta.
2. A comissão fica disponível para pagamento [quando — P-1; recomendação:
   depois do fim da edição e 7 dias depois da compra].
3. [Reembolso depois do pagamento: compensação no próximo pagamento — P-2.]
4. [Dados necessários para pagar (CPF, chave Pix), recibo/RPA e retenção de
   tributos — P-9, com o contador.]

## 6. Recrutamento de novos promoters
1. O promoter pode convidar outras pessoas pelo seu link de recrutamento.
   Cada pessoa tem **um único** recrutador.
2. Quando o recrutado atinge **10 vendas na mesma edição**, o recrutador
   ganha **1 ingresso em crédito**, emitido pela organização como cortesia
   nominal, **uma vez por recrutado**.
3. Se o recrutado voltar abaixo de 10 vendas antes da emissão, o crédito é
   revogado. Depois de emitido, não é revogado.
4. **Não há ganho em cadeia:** só o recrutador direto ganha.

## 7. Metas e reconhecimento
1. Selos de reconhecimento em 10, 20, 40 e 60 vendas na edição.
2. [Benefícios por meta — P-6, a confirmar: 10 → 1 ingresso; 20 → +1
   acompanhante; 40 → VIP e +1; 60 → pulseira preta e open bar conforme
   regulamento.] After-fest e sorteios ficam fora até revisão jurídica.
3. [Cortesias são nominais e não podem ser revendidas — P-7.]

## 8. Conduta
[Regras de divulgação: proibição de spam, de publicidade enganosa, de uso
indevido da marca, de preço diferente do oficial etc. — definir com o
advogado.]

## 9. Dados pessoais
[Remissão à Política de Privacidade da TICK, com a finalidade "programa de
promoters" e os dados usados: nome, link, vendas atribuídas (sem dados dos
compradores), comissões e pagamentos.]

## 10. Vigência, alteração e encerramento
[Prazo, forma de alteração (nova versão, novo aceite), encerramento a pedido
de qualquer parte e o que acontece com comissões pendentes.]

---

### Checklist do advogado
- [ ] Natureza da relação (sem vínculo empregatício) e enquadramento fiscal.
- [ ] Cláusula da regra 8 (cancelamento da provisória) e a sua validade.
- [ ] Prazo de liberação (P-1) e compensação de reembolso pago (P-2).
- [ ] Dados para pagamento e retenções (P-9).
- [ ] Benefícios por meta (P-6) e proibição de revenda (P-7).
- [ ] Regras de conduta e uso da marca.
- [ ] Versão e data do aceite ficam gravadas na conta (`promoters.termo_versao`).
