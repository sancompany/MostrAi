const express = require('express');
const multer = require('multer');
const os = require('node:os');
const fs = require('node:fs');
const router = express.Router();
const repo = require('./repository');
const notificacoesRepo = require('../creditos/notificacoes');
const sse = require('../lib/sse');
const { exigirAnuncianteLogado } = require('../anunciantes/routes');

const STATUS_TITULO = {
  recusada: 'Seu pedido de ponto não foi aprovado desta vez',
};

const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 20 * 1024 * 1024 } });

// v3 (18/09/2026): candidatura sem conta foi aposentada. Ponto e vendedor não
// têm mais porta de entrada pra quem não tem conta ainda — a conta nasce
// sempre igual (papel `anunciante`, `POST /anunciantes/cadastro`), e quem
// quer um ponto pede de dentro do painel (`POST /conta/modos/ponto/pedir`,
// `src/conta/modos.js`), já logado — o endereço e os outros dados exclusivos
// entram ali, o resto já veio da conta. Vendedor não tem pedido nenhum: o
// card do modo (e o da home) só apontam pro contato direto; quem vira
// vendedor é por convite que o dono gera à mão depois da conversa
// (`POST /admin/convites`, sem candidatura).
router.post('/candidaturas', (_req, res) => {
  res.status(410).json({
    erro:
      'esse formulário saiu do ar — crie sua conta e peça pra ser ponto de dentro do painel, ' +
      'ou fale com a gente pra ser vendedor',
  });
});

// Foto da fachada (migration 067, furo A do redesenho da Rede: a
// candidatura de ponto agora pode levar uma foto do estabelecimento, que
// segue pro ponto quando o dono libera o papel na conta — ver
// `liberarPapelNaConta`, src/conta/modos.js). Segundo passo depois de
// `POST /conta/modos/ponto/pedir` (que continua puro JSON — mesmo padrão de
// duas chamadas que a foto do próprio anunciante já usa, `POST
// /anunciantes/me/foto`), opcional: sem foto, a candidatura e o ponto
// continuam válidos, e o placeholder assume.
router.post(
  '/conta/modos/ponto/candidaturas/:id/foto',
  exigirAnuncianteLogado,
  upload.single('arquivo'),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ erro: 'arquivo obrigatório' });
    try {
      const cand = await repo.buscarPorId(req.params.id);
      if (!cand || cand.conta_id !== req.session.anuncianteId) {
        return res.status(404).json({ erro: 'candidatura não encontrada' });
      }
      const supabase = require('../lib/supabase');
      const buffer = fs.readFileSync(req.file.path);
      // Number(): o `:id` chega decodificado e ia direto pro nome do objeto
      // no bucket — mesma defesa de src/pontos/routes.js.
      const nomeArquivo = `candidaturas/fachada-${Number(req.params.id)}.jpg`;
      const bucket = process.env.SUPABASE_STORAGE_BUCKET;
      const { error } = await supabase.storage.from(bucket).upload(nomeArquivo, buffer, {
        contentType: 'image/jpeg',
        upsert: true,
      });
      if (error) return res.status(502).json({ erro: 'falha ao salvar a foto' });
      const { data } = supabase.storage.from(bucket).getPublicUrl(nomeArquivo);
      const atualizada = await repo.definirFoto(req.params.id, data.publicUrl);
      res.json({ url: atualizada.foto_fachada_url });
    } finally {
      fs.unlink(req.file.path, () => {});
    }
  },
);

// Admin
router.get('/admin/candidaturas', async (_req, res) => res.json(await repo.listar()));

// Aprovar NÃO é um status que se grava aqui (consolidação, 24/09/2026):
// aprovação é `POST /admin/candidaturas/:id/liberar` (src/conta/modos.js),
// que materializa o ponto na mesma transação. Marcar 'aprovada' pelo PATCH
// deixava a candidatura "aprovada" sem ponto nenhum — a conta via "Seu
// pedido foi aprovado" e "Meus pontos" continuava vazio.
router.patch('/admin/candidaturas/:id', async (req, res) => {
  if (req.body.status && !repo.STATUS.includes(req.body.status))
    return res.status(400).json({ erro: 'status inválido' });
  if (req.body.status === 'aprovada') {
    return res
      .status(400)
      .json({ erro: 'para aprovar, use a liberação na conta (POST /admin/candidaturas/:id/liberar)' });
  }
  const antes = await repo.buscarPorId(req.params.id);
  const c = await repo.atualizar(req.params.id, req.body);
  if (!c) return res.status(404).json({ erro: 'candidatura não encontrada' });

  if (antes && antes.status !== c.status) sse.emitirParaAdmin('application.updated', { id: c.id, status: c.status });
  // Avisa a conta dona da candidatura (Fase 3, SSE) quando o status muda de
  // verdade — "Em análise" nunca gera aviso, só a decisão. `c.conta_id`
  // sempre existe desde que a candidatura sem conta foi aposentada (v3,
  // comentário no topo do arquivo); a checagem continua por segurança
  // contra linha legada.
  if (c.conta_id && antes && antes.status !== c.status && STATUS_TITULO[c.status]) {
    await notificacoesRepo
      .registrar(c.conta_id, {
        tipo: 'ponto_recusado',
        titulo: STATUS_TITULO[c.status],
        entidadeTipo: 'candidatura',
        entidadeId: c.id,
      })
      .catch((err) => console.error('falha ao notificar candidatura', err.message));
    sse.emitirParaConta(c.conta_id, 'application.updated', { id: c.id, status: c.status });
  }
  res.json(c);
});

module.exports = router;
