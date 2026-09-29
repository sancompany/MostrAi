const express = require('express');
const multer = require('multer');
const os = require('node:os');
const fs = require('node:fs');
const router = express.Router();
const midiasRepo = require('./repository');
const { metricasDasMidias } = require('./metricas');
const anunciantesRepo = require('../anunciantes/repository');
const planosRepo = require('../financeiro/planos-repository');
const criativosRepo = require('../anunciantes/criativos-repository');
const ffmpeg = require('../lib/ffmpeg');
const sse = require('../lib/sse');
const qrInstitucional = require('./qr-institucional');

// Mesmo limite/destino de src/anunciantes/routes.js — sem duplicar o
// multer inteiro por module, mas sem depender do outro arquivo também
// (rota admin própria, sem sessão de anunciante).
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 95 * 1024 * 1024 } });

// Processa o arquivo (mesmo ffmpeg de src/anunciantes/routes.js#subirCriativo
// — cópia local pequena de propósito: aquela função escreve a resposta
// HTTP ela mesma, e aqui ainda falta criar a linha de midias_proprias por
// cima, então não dava pra reaproveitar sem reescrever as duas). Devolve o
// criativo pronto, sem sujeira em /tmp nos dois caminhos (sucesso ou erro).
async function processarArquivo(req, contaId, duracaoMaxima = null) {
  if (!req.file) throw Object.assign(new Error('arquivo obrigatório'), { status: 400 });
  try {
    const midia = await ffmpeg.probeMidia(req.file.path).catch(() => null);
    if (!midia) {
      throw Object.assign(new Error('não foi possível ler esse arquivo — confira se é um vídeo ou imagem válido'), {
        status: 400,
      });
    }
    if (!midia.ehImagem && (midia.duracao_segundos > 60 || midia.duracao_segundos < 3)) {
      throw Object.assign(new Error(`esse vídeo tem ${midia.duracao_segundos}s — a tela aceita de 3 a 60 segundos`), {
        status: 400,
      });
    }
    // Mesmo teto do plano que o upload do anunciante aplica
    // (src/anunciantes/routes.js#subirCriativo): trocar o arquivo pelo admin
    // não pode entregar uma peça mais longa do que o plano vende.
    if (!midia.ehImagem && duracaoMaxima && midia.duracao_segundos > duracaoMaxima) {
      throw Object.assign(
        new Error(
          `esse vídeo tem ${midia.duracao_segundos}s e o plano dessa conta aceita peça de até ${duracaoMaxima}s`,
        ),
        { status: 400 },
      );
    }
    const criativoTemp = await criativosRepo.criar({
      anunciante_id: contaId,
      arquivo_original_url: req.file.originalname,
      arquivo_normalizado_url: null,
      thumbnail_url: null,
      duracao_segundos: null,
    });
    try {
      const normalizado = await ffmpeg.normalizar(req.file.path, criativoTemp.id, duracaoMaxima);
      return await criativosRepo.atualizar(criativoTemp.id, {
        ...normalizado,
        editado_pelo_operador: true,
        // Nova mídia entra já aprovada — mesma convenção de qualquer upload
        // feito pelo operador (src/anunciantes/routes.js): quem aprovaria é
        // quem acabou de subir. Só a SUBSTITUIÇÃO (Parte 29) força revisão.
        status: 'aprovado',
      });
    } catch (err) {
      await criativosRepo.deletar(criativoTemp.id);
      throw err;
    }
  } finally {
    fs.unlink(req.file.path, () => {});
  }
}

function erroDeUpload(res, err) {
  if (err.status) return res.status(err.status).json({ erro: err.message });
  console.error('falha ao processar mídia própria', err);
  return res
    .status(400)
    .json({ erro: 'não foi possível processar esse arquivo — confira se é um vídeo ou imagem válido' });
}

function lerPontosIds(body) {
  const bruto = body.pontos_ids;
  if (!bruto) return [];
  const lista = Array.isArray(bruto) ? bruto : String(bruto).split(',');
  return lista.map(Number).filter(Number.isInteger);
}

// Cada mídia vem com as métricas de exibição (src/midias/metricas.js): só
// proof-of-play confirmado conta. A lista leva o resumo do card; a ficha,
// o detalhe por ponto e por tela.
router.get('/admin/midias-proprias', async (_req, res) => {
  const midias = await midiasRepo.listar();
  const metricas = await metricasDasMidias(midias);
  res.json(midias.map((m) => ({ ...m, metricas: metricas.get(m.id) })));
});

router.get('/admin/midias-proprias/:id', async (req, res) => {
  const midia = await midiasRepo.buscarPorId(req.params.id);
  if (!midia) return res.status(404).json({ erro: 'mídia não encontrada' });
  const metricas = await metricasDasMidias([midia], { detalhe: true });
  res.json({ ...midia, metricas: metricas.get(midia.id) });
});

// Nunca permite publicar/ativar uma configuração cuja ocupação passe de
// 100% em algum ponto coberto (Parte 10/12) — reaproveita a mesma
// `previewOcupacao` que a tela usa pra mostrar "atual x depois" ao vivo,
// então o bloqueio no servidor nunca diverge do que o admin viu antes de
// salvar.
async function pontosQueExcedem({ coberturaTipo, pontosIds, frequenciaHora, duracaoSegundos, excluirMidiaId }) {
  const pontosAlvo = coberturaTipo === 'pontos' ? pontosIds : null;
  const linhas = await midiasRepo.previewOcupacao({ pontosAlvo, frequenciaHora, duracaoSegundos, excluirMidiaId });
  return linhas.filter((l) => !l.comporta);
}

router.post('/admin/midias-proprias', upload.single('arquivo'), async (req, res) => {
  const { nome_interno, frequencia_hora, cobertura_tipo, periodo_inicio, periodo_fim } = req.body;
  if (!nome_interno || !frequencia_hora || !cobertura_tipo) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ erro: 'nome, frequência e cobertura são obrigatórios' });
  }
  const pontosIds = lerPontosIds(req.body);
  if (cobertura_tipo === 'pontos' && !pontosIds.length) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ erro: 'escolha pelo menos um ponto, ou marque "toda a rede"' });
  }
  const situacao = req.body.situacao === 'pausada' ? 'pausada' : 'ativa';
  try {
    const conta = await anunciantesRepo.ensureContaMostrai();
    const criativo = await processarArquivo(req, conta.id);
    // Só valida capacidade se a mídia já nasce ativa — pausada não consome
    // nada enquanto não for retomada (a validação roda de novo lá).
    if (situacao === 'ativa') {
      const excedentes = await pontosQueExcedem({
        coberturaTipo: cobertura_tipo,
        pontosIds,
        frequenciaHora: Number(frequencia_hora),
        duracaoSegundos: criativo.duracao_segundos,
        excluirMidiaId: null,
      });
      if (excedentes.length) {
        await criativosRepo.deletar(criativo.id);
        return res.status(400).json({
          erro: `essa frequência excede 100% da capacidade em ${excedentes.length} ponto(s) — reduza a frequência ou a cobertura`,
          pontosExcedentes: excedentes,
        });
      }
    }
    const midia = await midiasRepo.criar({
      criativoId: criativo.id,
      nomeInterno: nome_interno,
      frequenciaHora: Number(frequencia_hora),
      coberturaTipo: cobertura_tipo,
      pontosIds,
      periodoInicio: periodo_inicio || null,
      periodoFim: periodo_fim || null,
    });
    if (situacao === 'pausada') await midiasRepo.definirSituacao(midia.id, 'pausada');
    res.status(201).json(await midiasRepo.buscarPorId(midia.id));
  } catch (err) {
    erroDeUpload(res, err);
  }
});

// Excluída (migration 107) não muda mais: nem nome, nem veiculação, nem estado.
const MIDIA_EXCLUIDA = 'mídia excluída não muda mais';

router.patch('/admin/midias-proprias/:id', async (req, res) => {
  const midia = await midiasRepo.buscarPorId(req.params.id);
  if (!midia) return res.status(404).json({ erro: 'mídia não encontrada' });
  if (midia.situacao === 'excluida') return res.status(409).json({ erro: MIDIA_EXCLUIDA });
  const dados = {
    nome_interno: req.body.nome_interno,
    frequencia_hora: req.body.frequencia_hora != null ? Number(req.body.frequencia_hora) : undefined,
    periodo_inicio: req.body.periodo_inicio,
    periodo_fim: req.body.periodo_fim,
  };
  Object.keys(dados).forEach((k) => {
    if (dados[k] === undefined) delete dados[k];
  });
  // O CHECK do banco (migration 071: frequencia_hora > 0) recusaria com 500;
  // aqui vira 400 com o motivo, como qualquer entrada inválida.
  if (dados.frequencia_hora != null && (!Number.isInteger(dados.frequencia_hora) || dados.frequencia_hora < 1)) {
    return res.status(400).json({ erro: 'frequência por hora precisa ser um número inteiro maior que zero' });
  }
  const coberturaTipo = req.body.cobertura_tipo || midia.cobertura_tipo;
  if (req.body.cobertura_tipo) {
    dados.coberturaTipo = req.body.cobertura_tipo;
    dados.pontosIds = lerPontosIds(req.body);
    if (dados.coberturaTipo === 'pontos' && !dados.pontosIds.length) {
      return res.status(400).json({ erro: 'escolha pelo menos um ponto, ou marque "toda a rede"' });
    }
  }
  const mexeNoQueVeicula =
    dados.frequencia_hora != null || !!req.body.cobertura_tipo || 'periodo_inicio' in dados || 'periodo_fim' in dados;
  // Retirada do ar não volta — nem por Editar (PR #89, 28/09/2026): com o
  // período vencido, estender o fim trazia a mídia de volta ao ar sem
  // revalidar capacidade, porque a derivada no momento do PATCH era
  // 'encerrada'. Só o nome muda.
  if (midia.situacaoDerivada === 'encerrada' && mexeNoQueVeicula) {
    return res.status(409).json({ erro: 'mídia retirada do ar não volta — pra rodar de novo, crie outra' });
  }
  // Revalida capacidade quando a mídia consome ou vai consumir sozinha:
  // persistida 'ativa' cobre a derivada 'ativa' e a 'agendada' (entra no ar
  // sem ninguém clicar); pausada revalida no Retomar.
  if (midia.situacao === 'ativa' && mexeNoQueVeicula) {
    const excedentes = await pontosQueExcedem({
      coberturaTipo,
      pontosIds: dados.pontosIds || midia.pontosIds,
      frequenciaHora: dados.frequencia_hora ?? midia.frequencia_hora,
      duracaoSegundos: midia.duracao_segundos,
      excluirMidiaId: midia.id,
    });
    if (excedentes.length) {
      return res.status(400).json({
        erro: `essa frequência excede 100% da capacidade em ${excedentes.length} ponto(s) — reduza a frequência ou a cobertura`,
        pontosExcedentes: excedentes,
      });
    }
  }
  try {
    res.json(await midiasRepo.atualizar(req.params.id, dados));
  } catch (err) {
    // Data inválida no período (src/lib/fuso-comercial.js) é erro de quem
    // digitou, não nosso.
    if (err.status) return res.status(err.status).json({ erro: err.message });
    throw err;
  }
});

// Transições de estado: a régua mora em midiasRepo.transicionar (PR #89) —
// conferida contra a situação derivada; retirada do ar não volta, excluída
// não muda.
const responderTransicao = (res, r) => (r.ok ? res.json({ ok: true }) : res.status(r.status).json({ erro: r.erro }));

router.post('/admin/midias-proprias/:id/pausar', async (req, res) => {
  responderTransicao(res, await midiasRepo.transicionar(req.params.id, 'pausada'));
});

router.post('/admin/midias-proprias/:id/retomar', async (req, res) => {
  const midia = await midiasRepo.buscarPorId(req.params.id);
  if (!midia) return res.status(404).json({ erro: 'mídia não encontrada' });
  if (midia.situacao === 'excluida') return res.status(409).json({ erro: MIDIA_EXCLUIDA });
  // Derivada, a mesma régua de `transicionar`: pausada com período vencido é
  // 'encerrada' e não volta (PR #89). Antes da conta de capacidade.
  if (midia.situacaoDerivada !== 'pausada') {
    return res
      .status(409)
      .json({ erro: 'só uma mídia pausada pode ser retomada — mídia retirada do ar não volta, crie outra' });
  }
  // A rede pode ter mudado enquanto estava pausada — revalida antes de
  // voltar a consumir capacidade (mesma regra de nunca passar de 100%).
  const excedentes = await pontosQueExcedem({
    coberturaTipo: midia.cobertura_tipo,
    pontosIds: midia.pontosIds,
    frequenciaHora: midia.frequencia_hora,
    duracaoSegundos: midia.duracao_segundos,
    excluirMidiaId: midia.id,
  });
  if (excedentes.length) {
    return res.status(400).json({
      erro: `não dá pra retomar: excede 100% da capacidade em ${excedentes.length} ponto(s) agora — ajuste a frequência ou a cobertura primeiro`,
      pontosExcedentes: excedentes,
    });
  }
  responderTransicao(res, await midiasRepo.transicionar(req.params.id, 'ativa'));
});

router.post('/admin/midias-proprias/:id/encerrar', async (req, res) => {
  responderTransicao(res, await midiasRepo.transicionar(req.params.id, 'encerrada'));
});

// Exclusão LÓGICA (migration 107): só de mídia pausada ou encerrada. A mídia
// sai das listas e da programação; a linha, as exibições confirmadas e o
// histórico de estados ficam como comprovante. Sem volta. Se o arquivo ainda
// estava em análise, sai da fila de Aprovação no mesmo commit, e as outras
// abas do admin ficam sabendo pelo evento.
router.delete('/admin/midias-proprias/:id', async (req, res) => {
  const r = await midiasRepo.excluir(req.params.id);
  if (!r.ok) return res.status(r.status).json({ erro: r.erro });
  if (r.criativoReprovado) sse.emitirParaAdmin('creative.updated', { id: r.midia.criativo_id });
  res.json({ ok: true });
});

// Ajustar mídia > Substituir arquivo (Parte 25-29) — genérico, serve
// qualquer criativo da fila de Aprovação (de anunciante pagante ou de
// mídia própria, a origem não importa aqui): mesmo criativo lógico, mesma
// conta, mesmos vínculos — só troca o arquivo. Volta pra "em análise"
// sempre (Parte 29: nunca aprova sozinho um arquivo recém-trocado, mesmo
// sendo o próprio operador quem trocou).
router.post('/admin/criativos/:id/substituir', upload.single('arquivo'), async (req, res) => {
  const criativoAtual = await criativosRepo.buscarPorId(req.params.id);
  if (!criativoAtual) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(404).json({ erro: 'criativo não encontrado' });
  }
  // Mesma guarda do PATCH de criativo em src/admin/routes.js: trocar o
  // arquivo o mandaria de volta pra fila. Conferida de novo, com a mídia
  // travada, na hora de gravar (a exclusão pode chegar durante o FFmpeg).
  const ERRO_EXCLUIDA = 'esse arquivo é de uma mídia excluída — não muda mais';
  if ((await midiasRepo.situacaoPorCriativo(req.params.id)) === 'excluida') {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(409).json({ erro: ERRO_EXCLUIDA });
  }
  try {
    // `processarArquivo` cria uma linha TEMPORÁRIA pra rodar o ffmpeg (mesmo
    // padrão de subirCriativo) — o criativo de verdade continua sendo o
    // ORIGINAL, a temporária só empresta os dados prontos e é descartada.
    const conta = await anunciantesRepo.buscarPorId(criativoAtual.anunciante_id);
    const planoId = conta && !conta.conta_propria ? anunciantesRepo.planoVigenteId(conta) : null;
    const plano = planoId ? await planosRepo.buscarPorId(planoId) : null;
    const temp = await processarArquivo(req, criativoAtual.anunciante_id, plano?.duracao_maxima_segundos || null);
    const atualizado = await midiasRepo.gravarSeMidiaNaoExcluida(req.params.id, (db) =>
      criativosRepo.atualizar(
        req.params.id,
        {
          arquivo_original_url: temp.arquivo_original_url,
          arquivo_normalizado_url: temp.arquivo_normalizado_url,
          thumbnail_url: temp.thumbnail_url,
          duracao_segundos: temp.duracao_segundos,
          conteudo_sha256: temp.conteudo_sha256,
          conteudo_bytes: temp.conteudo_bytes,
          status: 'pendente',
          motivo_reprovacao: null,
        },
        db,
      ),
    );
    await criativosRepo.deletar(temp.id);
    if (!atualizado) return res.status(409).json({ erro: ERRO_EXCLUIDA });
    res.json(atualizado);
  } catch (err) {
    erroDeUpload(res, err);
  }
});

// Preview de capacidade (Parte 11/12) — ao vivo, enquanto o admin ajusta
// frequência/cobertura, antes de salvar. `pontos_ids` vazio + cobertura
// 'rede' calcula em todos os pontos em operação.
router.get('/admin/midias-proprias-preview-ocupacao', async (req, res) => {
  const coberturaTipo = req.query.cobertura_tipo === 'pontos' ? 'pontos' : 'rede';
  const pontosIds = lerPontosIds(req.query);
  if (coberturaTipo === 'pontos' && !pontosIds.length) return res.json([]);
  const pontosAlvo = coberturaTipo === 'pontos' ? pontosIds : null;
  const linhas = await midiasRepo.previewOcupacao({
    pontosAlvo,
    frequenciaHora: Number(req.query.frequencia_hora) || 0,
    duracaoSegundos: Number(req.query.duracao_segundos) || 0,
    excluirMidiaId: req.query.excluir_midia_id ? Number(req.query.excluir_midia_id) : null,
  });
  res.json(linhas);
});

// Capacidade da rede (Parte 16) — mesma tabela serve o picker de pontos
// (Parte 9) e a visão consolidada dentro de Mídia Mostraí. `?escopo=rede`
// (rodada de integridade, 23/09/2026) devolve todos os pontos, não só os em
// operação: é o que a tabela "Ocupação da rede" da Visão geral usa, pra que
// as duas telas leiam a MESMA régua 80/20 (src/lib/capacidade.js).
router.get('/admin/capacidade-rede', async (req, res) => {
  const status = req.query.escopo === 'rede' ? null : ['em_operacao'];
  res.json(await midiasRepo.ocupacaoPorPonto(null, null, status));
});

router.get('/admin/capacidade-rede/:pontoId/midias', async (req, res) => {
  res.json(await midiasRepo.midiasNoPonto(req.params.pontoId));
});

// ---------- QR Code institucional (27/09/2026) ----------
// Regra em ./qr-institucional.js; aqui só HTTP.

// PÚBLICA — é o endereço que vai dentro do QR impresso. 302 + no-store, nunca
// 301: redirecionamento permanente fica guardado no navegador e na
// Cloudflare, e trocar o destino deixaria de valer pra quem já escaneou uma
// vez. Se a leitura falhar, leva à página de planos: o QR impresso nunca
// mostra tela de erro (e a falha fica no log).
router.get(qrInstitucional.CAMINHO_PERMANENTE, async (_req, res) => {
  let destino;
  try {
    destino = (await qrInstitucional.lerEstado()).destino;
  } catch (err) {
    console.error('qr institucional: falha ao ler o destino, levando à página de planos', err);
    destino = qrInstitucional.destinoPadrao();
  }
  res.set('Cache-Control', 'no-store');
  res.redirect(302, destino);
});

// Sem SITE_URL não há QR: o link dentro dele precisa do endereço público.
function linkOu503(res) {
  const link = qrInstitucional.linkPermanente();
  if (!link) res.status(503).json({ erro: 'SITE_URL não configurada — o QR precisa do endereço público do site' });
  return link;
}

router.get('/admin/qr-institucional', async (_req, res) => {
  if (!linkOu503(res)) return;
  res.json(await qrInstitucional.lerEstado());
});

router.put('/admin/qr-institucional', async (req, res) => {
  if (!linkOu503(res)) return;
  const { destino, erro } = qrInstitucional.validarDestino(req.body?.destino);
  if (erro) return res.status(400).json({ erro });
  await qrInstitucional.definirDestino(destino, req.session.adminUsuario);
  res.json(await qrInstitucional.lerEstado());
});

// Preview (inline) e download (`?baixar=1`, anexo com nome de arquivo) pela
// mesma rota. `no-store`: .png/.svg a Cloudflare guardaria por extensão.
function entregarImagem(req, res, { tipo, arquivo, conteudo }) {
  res.set('Content-Type', tipo);
  res.set('Cache-Control', 'private, no-store');
  if (req.query.baixar === '1') res.set('Content-Disposition', `attachment; filename="${arquivo}"`);
  res.send(conteudo);
}

router.get('/admin/qr-institucional/svg', async (req, res) => {
  const link = linkOu503(res);
  if (!link) return;
  entregarImagem(req, res, {
    tipo: 'image/svg+xml; charset=utf-8',
    arquivo: 'mostrai-qr-anuncie.svg',
    conteudo: await qrInstitucional.gerarSvg(link),
  });
});

router.get('/admin/qr-institucional/png', async (req, res) => {
  const link = linkOu503(res);
  if (!link) return;
  const lado = req.query.tamanho ? Number(req.query.tamanho) : qrInstitucional.TAMANHOS_PNG[0];
  if (!qrInstitucional.TAMANHOS_PNG.includes(lado)) {
    return res.status(400).json({ erro: `tamanho aceito: ${qrInstitucional.TAMANHOS_PNG.join(' ou ')} px` });
  }
  entregarImagem(req, res, {
    tipo: 'image/png',
    arquivo: `mostrai-qr-anuncie-${lado}px.png`,
    conteudo: await qrInstitucional.gerarPng(link, lado),
  });
});

module.exports = router;
