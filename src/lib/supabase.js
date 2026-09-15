const { createClient } = require('@supabase/supabase-js');

// ponytail: client criado só na primeira chamada, não no require — senão o
// server inteiro cai no boot se SUPABASE_URL ainda não estiver configurada
// (ex.: primeiro deploy, dev local sem .env completo), mesmo em rota que
// nunca usa o Supabase.
let client = null;
function getClient() {
  if (!client) client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  return client;
}

module.exports = {
  get storage() {
    return getClient().storage;
  },
};
