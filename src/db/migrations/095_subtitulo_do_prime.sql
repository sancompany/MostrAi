-- Subtítulo do Prime na página de Planos (26/09/2026, pedido do dono): "A
-- experiência completa, sem limitações." era impreciso — o Prime tem limite
-- de horas, pontos, duração e quantidade de anúncios. Só texto de vitrine
-- (`rotulo`, CAMPOS_VITRINE): não toca preço, benefício nem assinatura, e por
-- isso muda a linha no lugar, como a 052 fez, em vez de criar versão nova.
UPDATE planos
   SET rotulo = 'A experiência mais completa da Mostraí.'
 WHERE tier = 'maximo'
   AND rotulo = 'A experiência completa, sem limitações.';
