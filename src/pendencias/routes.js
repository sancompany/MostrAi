const express = require('express');
const router = express.Router();
const repo = require('./repository');
const { sincronizarContaSemFalhar } = require('./endereco');
const { exigirAnuncianteLogado } = require('../anunciantes/routes');

// Pendências (estação de endereços, 01/10/2026; ver repository.js).

// O topo do painel: "1 pendência precisa da sua atenção". Reavalia o
// endereço da conta antes de listar — é assim que o cadastro antigo, de
// antes da regra, ganha a pendência na primeira visita (sem disparar aviso
// de novo a cada carga: a pendência ativa é uma só por chave).
router.get('/anunciantes/me/pendencias', exigirAnuncianteLogado, async (req, res) => {
  const contaId = req.session.anuncianteId;
  await sincronizarContaSemFalhar(contaId, { por: 'leitura' });
  const pendencias = await repo.listarDaConta(contaId);
  res.json({ total: pendencias.length, pendencias });
});

// Admin (montado atrás de requireAdminSession em server.js): ativas, de
// tudo ou só de um ponto/conta.
const idOuNada = (v) => (/^\d{1,9}$/.test(String(v ?? '')) ? Number(v) : null);

router.get('/admin/pendencias', async (req, res) => {
  res.json(
    await repo.listarAtivas({ pontoId: idOuNada(req.query.pontoId), anuncianteId: idOuNada(req.query.anuncianteId) }),
  );
});

// "Conferido" — só pendência do admin (a do cliente some quando o dado muda).
router.post('/admin/pendencias/:id/conferir', async (req, res) => {
  const id = idOuNada(req.params.id);
  const p = id && (await repo.conferirPeloAdmin(id, req.session?.adminUsuario || 'admin'));
  if (!p) return res.status(404).json({ erro: 'pendência não encontrada ou já resolvida' });
  res.json({ ok: true });
});

module.exports = router;
