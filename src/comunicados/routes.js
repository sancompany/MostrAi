const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const email = require('../financeiro/email');
const outbox = require('../email/outbox');
const { limiteTentativas } = require('../lib/limite-tentativas');
const publicos = require('./publicos');
const conteudo = require('./conteudo');
const repo = require('./repository');

// Comunicados por e-mail (Admin → Visão geral, 29/09/2026). Tudo aqui mora
// sob /admin — o `requireAdminSession` de src/server.js barra quem não tem
// sessão de admin (conta de cliente logada também: a sessão dela é outra,
// src/lib/sessao.js). O navegador só fala com estas rotas; quem fala com o
// provedor de e-mail é o servidor, e credencial de SMTP não aparece em
// resposta nenhuma — nem em erro (sanitizado pela outbox).

const adminDe = (req) => String(req.session?.adminUsuario || 'admin');

// Mesma régua do cadastro (emailValido em src/anunciantes/routes.js), sem
// separador de lista (",", ";", "<", ">", '"') — o teste é pra UM endereço.
const emailDeTesteValido = (e) => /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/.test(e) && e.length <= 254;

// Para onde vai o teste: o endereço que o admin digitou ou, vazio, a caixa
// da equipe (MOSTRAI_EMAIL_CONTATO). Nunca uma conta de cliente — o teste
// não pode virar um envio real para um usuário.
async function destinoDoTeste(bruto) {
  const informado = String(bruto ?? '')
    .trim()
    .toLowerCase();
  const destino = informado || String(outbox.remetenteInterno() || '').toLowerCase();
  if (!destino) {
    return { erro: 'não há e-mail da equipe configurado — informe um endereço para o teste', campo: 'testePara' };
  }
  if (!emailDeTesteValido(destino)) return { erro: 'e-mail de teste inválido', campo: 'testePara' };
  const { rows } = await pool.query(
    `SELECT 1 FROM anunciantes
      WHERE NOT conta_propria
        AND (lower(trim(contato_email)) = $1 OR lower(trim(COALESCE(responsavel_email, ''))) = $1)
      LIMIT 1`,
    [destino],
  );
  if (rows[0]) {
    return {
      erro: 'esse e-mail é de uma conta de cliente — o teste vai só para a caixa da equipe',
      campo: 'testePara',
    };
  }
  return { destino };
}

// Histórico + o que a tela precisa pra montar o formulário.
router.get('/admin/comunicados', async (_req, res) => {
  const equipe = outbox.remetenteInterno();
  res.json({
    publicos: publicos.lista(),
    limites: conteudo.LIMITES,
    testePadrao: equipe ? outbox.mascararEmail(equipe) : null,
    comunicados: await repo.historico(),
  });
});

// "Destinatários: N contas" — o tamanho da MESMA lista que o envio usa.
// Nunca devolve endereço; o "fora do envio" são só números por motivo.
router.get('/admin/comunicados/destinatarios', async (req, res) => {
  const publico = String(req.query.publico || '');
  if (!publicos.existe(publico)) return res.status(400).json({ erro: 'escolha um público válido', campo: 'publico' });
  const [lista, foraDoEnvio] = await Promise.all([
    publicos.listarDestinatarios(publico),
    publicos.contarForaDoEnvio(publico),
  ]);
  res.json({ publico, destinatarios: lista.length, foraDoEnvio });
});

// Prévia: o e-mail que sai, montado pelo mesmo `montar` do envio.
router.post('/admin/comunicados/previa', (req, res) => {
  const v = conteudo.validar(req.body || {});
  if (v.erro) return res.status(400).json(v);
  const m = conteudo.montar(v.conteudo);
  res.json({ assunto: m.assunto, html: m.html, texto: m.text });
});

// Teste: sai NA HORA (o admin espera a resposta pra saber se o SMTP está
// de pé), pelo mesmo transporte e o mesmo template, marcado como teste no
// assunto e no corpo. Não grava comunicado, não conta no histórico.
// `limiteTentativas`: 10 por 15 min — teste não vira canal de disparo.
router.post('/admin/comunicados/teste', limiteTentativas, async (req, res) => {
  const v = conteudo.validar(req.body || {});
  if (v.erro) return res.status(400).json(v);
  const alvo = await destinoDoTeste(req.body?.para);
  if (alvo.erro) return res.status(400).json(alvo);
  try {
    await email.enviarComunicado(alvo.destino, conteudo.montar(v.conteudo, { teste: true }));
  } catch (err) {
    console.error(`teste de comunicado não saiu: ${outbox.sanitizar(err)}`);
    return res.status(502).json({ erro: `o teste não saiu: ${outbox.sanitizar(err)}` });
  }
  console.log(`teste de comunicado enviado por ${adminDe(req)} para ${outbox.mascararEmail(alvo.destino)}`);
  res.json({ ok: true, para: outbox.mascararEmail(alvo.destino) });
});

// Envio de verdade. `Idempotency-Key` (o navegador gera uma por
// confirmação) + o número de destinatários que o admin confirmou.
router.post('/admin/comunicados', async (req, res) => {
  const chave = String(req.get('Idempotency-Key') || '').trim();
  if (!/^[A-Za-z0-9-]{16,100}$/.test(chave)) {
    return res.status(400).json({ erro: 'envio sem chave de confirmação — recarregue a página e tente de novo' });
  }
  const publico = String(req.body?.publico || '');
  if (!publicos.existe(publico)) return res.status(400).json({ erro: 'escolha um público válido', campo: 'publico' });
  const v = conteudo.validar(req.body || {});
  if (v.erro) return res.status(400).json(v);
  const confirmados = Number(req.body?.destinatariosConfirmados);
  if (!Number.isInteger(confirmados) || confirmados < 1) {
    return res.status(400).json({ erro: 'confirme o número de destinatários antes de enviar' });
  }
  try {
    const r = await repo.criar({ chave, publico, conteudo: v.conteudo, confirmados, adminUsuario: adminDe(req) });
    if (!r.repetido) {
      console.log(
        `comunicado #${r.comunicado.id} criado por ${adminDe(req)} para ${r.comunicado.previstos} destinatários (${publico})`,
      );
    }
    res.status(r.repetido ? 200 : 201).json(r);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ erro: err.message, ...err.detalhes });
    throw err;
  }
});

const idValido = (v) => /^\d{1,18}$/.test(String(v));

// Detalhe: texto enviado + quem não recebeu (endereço mascarado).
router.get('/admin/comunicados/:id', async (req, res) => {
  if (!idValido(req.params.id)) return res.status(404).json({ erro: 'comunicado não encontrado' });
  const d = await repo.detalhe(req.params.id);
  if (!d) return res.status(404).json({ erro: 'comunicado não encontrado' });
  res.json(d);
});

// Só quem falhou volta pra fila. `paraReenviarConfirmados`: o número que a
// confirmação mostrou.
router.post('/admin/comunicados/:id/reenviar-falhas', async (req, res) => {
  if (!idValido(req.params.id)) return res.status(404).json({ erro: 'comunicado não encontrado' });
  const confirmados = Number(req.body?.paraReenviarConfirmados);
  if (!Number.isInteger(confirmados) || confirmados < 1) {
    return res.status(400).json({ erro: 'confirme quantas falhas vão ser reenviadas' });
  }
  try {
    const r = await repo.reenviarFalhas(req.params.id, { adminUsuario: adminDe(req), confirmados });
    if (r.reenfileirados) {
      console.log(`comunicado #${req.params.id}: ${r.reenfileirados} falhas reenviadas por ${adminDe(req)}`);
    }
    res.json(r);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ erro: err.message, ...err.detalhes });
    throw err;
  }
});

module.exports = router;
