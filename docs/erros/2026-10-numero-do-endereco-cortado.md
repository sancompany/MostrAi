# A rua caía no campo Número e era cortada em 20 caracteres

**Sintoma.** Um cliente real ficou com o endereço "Avenida Francisco
Mastropietro, Av Francisco Mastrop - Barbearia - Vila Cardim, Matão/SP": o
Logradouro certo (veio da ViaCEP), e no Número um pedaço da própria rua —
exatamente 20 caracteres. O número de verdade do imóvel se perdeu.

**Causa raiz** (reproduzida no navegador, celular, 01/10/2026). Duas coisas
juntas:

1. `ligarCep` (então em `public/formulario.js`) movia o foco para o Número
   quando a resposta da ViaCEP preenchia o campo em que a pessoa estava. Quem
   digitou o CEP e foi com Tab (ou "próximo" do teclado do celular) pro
   Logradouro, ainda vazio, via a resposta chegar, o Logradouro se preencher
   e o foco pular pro Número — no meio da digitação da rua. O resto da rua
   caía no Número.
2. O Número tinha `maxlength="20"` em todos os formulários (cadastro,
   convite, perfil, candidatura de ponto). O navegador corta em silêncio:
   "Av Francisco Mastropietro…" virou "Av Francisco Mastrop", sem aviso.

E nada pegava depois: o Número não tinha placeholder nem dica, o servidor não
conferia tamanho nem formato de parte nenhuma do endereço (o banco é `text`
sem limite) e não havia leitura de "isso parece endereço, não número".

**Correção** (estação de endereços):

- O foco só vai pro Número se a pessoa ainda está no CEP. Se ela já foi pra
  outro campo, fica lá — e o texto que a consulta acabou de pôr no campo em
  que ela está fica selecionado, então o que ela digitar substitui em vez de
  colar no fim. A consulta só roda quando o CEP mudou, e uma resposta vazia
  (CEP geral) nunca apaga o que está no campo.
- Uma regra só pros dois lados (`public/endereco-regras.js`, lido pelo
  navegador e pelo servidor): Número até 30, alfanumérico (123, 12A, T10,
  45-B, S/N); logradouro e complemento até 255; bairro e cidade até 150; UF 2;
  CEP 8 dígitos. O servidor recusa o resto, em toda porta de entrada.
- Número com placeholder ("Ex.: 123, 12A, T10 ou S/N") e dica embaixo. Número
  que parece endereço ganha o aviso "Confira este campo…" — segura o primeiro
  envio, não o segundo; nunca corrige sozinho.
- O servidor abre a pendência ENDERECO_SUSPEITO (painel + sino, uma vez) pra
  quem já está gravado assim — inclusive o cliente real, pela varredura
  diária — e ela some quando o Número é corrigido.

**Regra que fica.** `maxlength` menor que o dado real é perda silenciosa: o
limite de um campo de texto nasce da regra do dado (e do servidor), nunca de
um palpite de layout, e o servidor confere o mesmo limite. E código que muda
o foco sozinho só pode fazer isso quando a pessoa ainda não saiu do lugar.
Teste: `tests/enderecos.test.js` e `tests/e2e/42-enderecos.mjs` (refaz o caso
real no celular).
