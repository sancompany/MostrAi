# Sessões em memória do processo

**Sintoma.** `express-session` com o `MemoryStore` padrão. Todo deploy
deslogava todo mundo (anunciante, vendedor e admin), e a memória do processo
crescia sem limite.

**Causa raiz.** Padrão da biblioteca aceito sem decisão. Em desenvolvimento
ninguém percebe.

**Correção.** `connect-pg-simple` com tabela `session` no mesmo Postgres.

**Guarda.** Reiniciar o serviço e conferir que a sessão do admin continua.

**Como evitar na origem.** Antes de subir para produção, listar tudo que vive
em memória do processo (lição de ecossistema nº 4) e decidir o destino de
cada item.

**Ecossistema:** sim — é a lição nº 4 aparecendo em outro projeto.
