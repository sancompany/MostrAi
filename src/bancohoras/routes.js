const express = require('express');
const router = express.Router();
const repo = require('./repository');
const obrigacaoDoCiclo = require('./obrigacao-do-ciclo');
const { exigirAnuncianteLogado } = require('../anunciantes/routes');

// Autoatendimento: o anunciante vê o próprio saldo — nunca o de outra conta.
//
// Desde 01/10/2026 (migration 111) o saldo nasce do CICLO CONTRATADO, não da
// capacidade da rede: comprou um Pro, deve-se 84 h — com ou sem tela no ar —
// até o Proof-of-Play confirmar a entrega (src/bancohoras/obrigacao-do-ciclo.js).
//
//   contratadoSegundos — tudo o que foi contratado e ainda vale (ciclos,
//                        trocas e benefícios). Num ciclo AINDA ABERTO, sem
//                        desconto nenhum: saldo = contratado − Proof-of-Play.
//                        Só no ciclo já encerrado sai a parcela do tempo em
//                        que a campanha esteve indisponível por
//                        responsabilidade do cliente (hotfix 06/10/2026);
//   entregueSegundos   — o que o Proof-of-Play confirmou contra isso;
//   segundos           — o que falta entregar (saldo a entregar);
//   cicloAtual         — o ciclo em curso e quanto dele foi contratado;
//   saldoAnteriorSegundos — o que ainda falta de ciclos anteriores.
//
// O saldo técnico negativo de um reembolso é interno (spec R3 §41): nunca
// aparece aqui como "você deve" — o cliente vê 0 e, na próxima contratação, a
// obrigação já descontada. `exibicoesEquivalentes` é derivado — quantas vezes
// a peça que roda HOJE precisa tocar pra devolver esse tempo. `saldo`
// (exibições) e `linhas` continuam pra leitura antiga.
router.get('/anunciantes/me/banco-horas', exigirAnuncianteLogado, async (req, res) => {
  const contaId = req.session.anuncianteId;
  const s = await obrigacaoDoCiclo.saldoDaConta(contaId);
  const segundos = Math.max(0, s.saldoSegundos);
  const duracaoReferencia = segundos > 0 ? await repo.duracaoMediaDoAnunciante(contaId) : 0;
  const exibicoesEquivalentes = segundos > 0 ? Math.ceil(segundos / duracaoReferencia) : 0;
  res.json({
    segundos,
    contratadoSegundos: s.devidoSegundos,
    entregueSegundos: s.entregueSegundos,
    saldoAnteriorSegundos: s.saldoAnteriorSegundos,
    cicloAtual: s.cicloAtual,
    exibicoesEquivalentes,
    duracaoReferencia,
    saldo: exibicoesEquivalentes,
    linhas: s.lotes
      .filter((l) => l.tipo !== 'basico' && !l.reembolsado)
      .map((l) => ({
        tipo: l.tipo,
        planoId: l.planoId,
        inicio: l.inicio,
        fim: l.fim,
        motivo: l.motivo,
        segundosContratados: l.contratadoSegundos - l.indisponivelClienteSegundos - l.reduzidoSegundos,
        segundosEntregues: l.entregueSegundos,
        segundosPendentes: l.pendenteSegundos,
      })),
  });
});

// Admin: o extrato completo de uma conta — cada lançamento do livro
// (ciclo, troca, benefício, reembolso), o tempo descontado por
// indisponibilidade do cliente, o entregue por Proof-of-Play, o excedente e
// o saldo técnico negativo de reembolso ("Entrega previamente reembolsada").
router.get('/admin/contas/:id/saldo-veiculacao', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ erro: 'conta inválida' });
  res.json(await obrigacaoDoCiclo.saldoDaConta(id));
});

// Admin: o saldo de todas as contas com obrigação, numa linha por conta.
router.get('/admin/saldo-veiculacao', async (_req, res) => {
  const saldos = await obrigacaoDoCiclo.saldosDasContas();
  res.json(
    [...saldos].map(([anuncianteId, s]) => ({
      anuncianteId,
      contratadoSegundos: s.devidoSegundos,
      entregueSegundos: s.entregueSegundos,
      saldoSegundos: s.saldoSegundos,
      atrasoSegundos: s.atrasoSegundos,
      negativoTecnicoSegundos: s.negativoTecnicoSegundos,
      excedenteSegundos: s.excedenteSegundos,
    })),
  );
});

// Admin — apuração mensal da CAPACIDADE (o que as telas deixaram de
// entregar em cada mês, hora a hora). Diagnóstico da rede desde a migration
// 111 — o saldo devido ao cliente é o de `/admin/saldo-veiculacao`.
router.get('/admin/banco-horas', async (_req, res) => {
  res.json(await repo.listarTodos());
});

// Admin — fila 'aguardando_credito': HISTÓRICO da válvula de 3 meses, que
// saiu em 25/09/2026 (decisão do dono: banco de horas é obrigação de
// veiculação, sem expiração, nunca crédito em dinheiro). Nenhum código põe
// linha nova aqui; a rota fica só pra resolver alguma linha antiga.
router.get('/admin/banco-horas/aguardando-credito', async (_req, res) => {
  res.json(await repo.listarAguardandoCredito());
});

router.post('/admin/banco-horas/:id/resolver', async (req, res) => {
  const linha = await repo.resolverCredito(req.params.id);
  if (!linha) return res.status(404).json({ erro: 'linha não encontrada ou já resolvida' });
  res.json(linha);
});

module.exports = router;
