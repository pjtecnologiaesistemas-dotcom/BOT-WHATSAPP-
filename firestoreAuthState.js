/**
 * firestoreAuthState.js
 * ---------------------------------------------------------------
 * Substitui o useMultiFileAuthState (que grava em arquivos no disco
 * local) por uma versão que grava a sessão do WhatsApp no Firestore.
 *
 * Por quê: em servidores como Railway/Render o disco é EFÊMERO — a
 * cada novo deploy (cada vez que você atualiza o código) o container
 * é recriado do zero e a pasta "auth_info" é apagada junto, fazendo
 * o bot perder a sessão e pedir pareamento de novo.
 *
 * Guardando a sessão no Firestore (que já é usado pelo bot para os
 * lançamentos), ela passa a sobreviver a qualquer deploy/reinício,
 * porque não depende do disco do container.
 *
 * Uso (dentro do bot-lancamentos.js):
 *   const { useFirestoreAuthState } = require('./firestoreAuthState');
 *   const { state, saveCreds } = await useFirestoreAuthState(db, 'bot-lancamentos');
 * ---------------------------------------------------------------
 */

const { BufferJSON, initAuthCreds, proto } = require('@whiskeysockets/baileys');

// Firestore não aceita "/" em ID de documento — sanitiza qualquer
// caractere problemático que possa aparecer em ids de chave/sessão.
function idSeguro(str) {
  return String(str).replace(/[/\\]/g, '_');
}

async function useFirestoreAuthState(db, sessionId = 'bot') {
  const credsRef = db.collection('whatsapp_auth').doc(idSeguro(sessionId) + '_creds');
  const keysCollection = db.collection('whatsapp_auth_keys');

  const chaveDoc = (type, id) =>
    keysCollection.doc(`${idSeguro(sessionId)}__${idSeguro(type)}__${idSeguro(id)}`);

  async function gravar(ref, dados) {
    const json = JSON.stringify(dados, BufferJSON.replacer);
    await ref.set({ json, atualizadoEm: Date.now() });
  }

  async function ler(ref) {
    const snap = await ref.get();
    if (!snap.exists) return null;
    const { json } = snap.data();
    if (!json) return null;
    return JSON.parse(json, BufferJSON.reviver);
  }

  const credsExistentes = await ler(credsRef);
  const creds = credsExistentes || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const dados = {};
          await Promise.all(ids.map(async (id) => {
            let valor = await ler(chaveDoc(type, id));
            if (valor && type === 'app-state-sync-key') {
              valor = proto.Message.AppStateSyncKeyData.fromObject(valor);
            }
            dados[id] = valor;
          }));
          return dados;
        },
        set: async (dados) => {
          const tarefas = [];
          for (const type in dados) {
            for (const id in dados[type]) {
              const valor = dados[type][id];
              const ref = chaveDoc(type, id);
              tarefas.push(
                valor ? gravar(ref, valor) : ref.delete().catch(() => {})
              );
            }
          }
          await Promise.all(tarefas);
        }
      }
    },
    saveCreds: async () => {
      await gravar(credsRef, creds);
    },
    // Útil caso um dia você precise forçar novo pareamento manualmente
    limparSessao: async () => {
      await credsRef.delete().catch(() => {});
      const snap = await keysCollection
        .where('__name__', '>=', idSeguro(sessionId) + '__')
        .where('__name__', '<', idSeguro(sessionId) + '__\uf8ff')
        .get();
      const batch = db.batch();
      snap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
  };
}

module.exports = { useFirestoreAuthState };
