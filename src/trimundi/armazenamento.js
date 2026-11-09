const fs = require('node:fs/promises');
const path = require('node:path');
const config = require('./config');

// Onde ficam as imagens da edição. Produção: o Storage do projeto Supabase
// PRÓPRIO da Trimundi (nunca o bucket da Mostraí). Desenvolvimento: disco
// local, servido em /ticket/arquivos. Sem nenhum dos dois, o envio responde
// 503 "imagens não configuradas neste ambiente" (RN-T06). Os testes trocam o
// adaptador por um em memória (`substituir`).

function local(c) {
  const raiz = path.resolve(c.pasta);
  return {
    tipo: 'local',
    raiz,
    async salvar(caminho, buffer) {
      const destino = path.join(raiz, caminho);
      if (!destino.startsWith(raiz + path.sep)) throw new Error('caminho inválido');
      await fs.mkdir(path.dirname(destino), { recursive: true });
      await fs.writeFile(destino, buffer);
      return `/ticket/arquivos/${caminho}`;
    },
    async remover(caminho) {
      const destino = path.join(raiz, caminho);
      if (!destino.startsWith(raiz + path.sep)) return;
      await fs.rm(destino, { force: true });
    },
  };
}

function supabase(c) {
  let cliente = null;
  const storage = () => {
    if (!cliente) cliente = require('@supabase/supabase-js').createClient(c.url, c.chave);
    return cliente.storage.from(c.bucket);
  };
  return {
    tipo: 'supabase',
    async salvar(caminho, buffer, tipoMime) {
      const { error } = await storage().upload(caminho, buffer, { contentType: tipoMime, upsert: false });
      if (error) throw new Error(`falha ao salvar a imagem: ${error.message}`);
      return storage().getPublicUrl(caminho).data.publicUrl;
    },
    async remover(caminho) {
      await storage().remove([caminho]);
    },
  };
}

let substituto = null;

function adaptador() {
  if (substituto) return substituto;
  const c = config.armazenamento();
  if (c.tipo === 'local') return local(c);
  if (c.tipo === 'supabase') return supabase(c);
  return null;
}

// Só testes.
function substituir(novo) {
  substituto = novo;
}

module.exports = { adaptador, substituir };
