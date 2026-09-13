# Margem calculada com constante fixa por ponto

**Sintoma.** `AMORTIZACAO_POR_PONTO = 42.78` no código, igual para todo
ponto. Custos fixos da operação (contador, DAS, hospedagem, gateway) não
existiam em lugar nenhum. A margem do painel era otimista por construção — e
margem é a métrica de sucesso do projeto.

**Causa raiz.** O primeiro modelo assumiu equipamento idêntico em todo ponto
e ignorou custo fixo. TV, molde e instalação variam por tela.

**Correção.** Custo de equipamento e prazo de amortização por dispositivo;
tabela `custos_fixos` lançada pelo dono; `/admin/resumo` soma os dois.

**Guarda.** Nenhuma constante monetária no código: `grep -n "= [0-9]*\.[0-9]*;"
src/` deve devolver nada em `admin/routes.js`.

**Como evitar na origem.** Todo número que o dono pode querer mudar é campo,
não constante.

**Ecossistema:** sim — vale para qualquer projeto com margem no painel.
