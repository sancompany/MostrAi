// Falha (código 1) quando uma dependência DIRETA de produção, na versão
// travada no package-lock.json, está marcada como deprecated no registro do
// npm. Roda toda semana em .github/workflows/seguranca-semanal.yml.
//
// Por que não basta o `npm audit` (AUD-018, auditoria 10/2026): o multer
// 1.4.5-lts.2 ficou meses em produção com o aviso "Multer 1.x is impacted by
// a number of vulnerabilities, which have been patched in 2.x" — e o audit
// nunca o listou, porque os avisos de segurança do multer cobrem as versões
// `<2.0.0` e a versão `-lts` é pré-lançamento no semver, fora da faixa. O
// aviso de deprecated é o que o próprio mantenedor publica; este script lê
// esse aviso. Sem dado nenhum do projeto: só nomes e versões de pacote.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const raiz = path.join(__dirname, '..');
const { dependencies } = require(path.join(raiz, 'package.json'));
const { packages } = require(path.join(raiz, 'package-lock.json'));

const deprecadas = [];
for (const nome of Object.keys(dependencies)) {
  const versao = packages[`node_modules/${nome}`]?.version;
  if (!versao) {
    console.error(`${nome} está no package.json mas não no package-lock.json — rode npm install e commite o lock`);
    process.exit(1);
  }
  const aviso = execFileSync('npm', ['view', `${nome}@${versao}`, 'deprecated'], { encoding: 'utf8' }).trim();
  if (aviso) deprecadas.push(`${nome}@${versao}: ${aviso}`);
}

if (deprecadas.length) {
  console.error(`dependência de produção marcada como deprecated:\n${deprecadas.map((d) => `  - ${d}`).join('\n')}`);
  process.exit(1);
}
console.log(`nenhuma das ${Object.keys(dependencies).length} dependências de produção está deprecated`);
