// Foto de perfil da conta no bucket público (`avatares/anunciante-<id>.jpg`,
// POST /anunciantes/me/foto). Um lugar só para o caminho do objeto e para
// apagá-lo: excluir a conta, apagar os dados opcionais (LGPD) e anonimizar
// removem o arquivo do bucket — antes só zeravam `foto_url` e a foto ficava
// pública, alcançável pela URL antiga.
const supabase = require('./supabase');

function caminhoDoAvatar(contaId) {
  return `avatares/anunciante-${Number(contaId)}.jpg`;
}

// Nunca falha o chamador: bucket fora do ar não pode impedir uma exclusão de
// conta. Só registra.
async function removerAvatar(contaId) {
  const bucket = process.env.SUPABASE_STORAGE_BUCKET;
  if (!bucket || !process.env.SUPABASE_URL) return false;
  try {
    const { error } = await supabase.storage.from(bucket).remove([caminhoDoAvatar(contaId)]);
    if (error) throw error;
    return true;
  } catch (err) {
    console.error(`avatar da conta ${contaId} não foi removido do bucket:`, err.message);
    return false;
  }
}

module.exports = { caminhoDoAvatar, removerAvatar };
