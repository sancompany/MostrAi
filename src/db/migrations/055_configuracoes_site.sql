-- Tabela genérica de chave/valor pra configuração de site-wide que não é de
-- nenhum ponto, plano ou conta específica — a primeira é a foto de exemplo
-- do "ponto completo" em pontos.html, que o dono pediu pra poder trocar pelo
-- admin sem precisar de deploy (revisão de 18/09/2026).
CREATE TABLE configuracoes_site (
  chave text PRIMARY KEY,
  valor text
);
