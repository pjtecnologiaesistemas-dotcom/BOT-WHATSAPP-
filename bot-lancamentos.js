/**
 * BOT DE CAPTURA — Lançamentos via WhatsApp (Grupo M.S)
 * ---------------------------------------------------------------
 * O que faz:
 *  1. Conecta no WhatsApp via QR Code (biblioteca Baileys)
 *  2. Escuta mensagens de um grupo específico
 *  3. Tenta extrair os campos com REGEX (rápido, sem custo)
 *  4. Se não bater no padrão, usa a API da Anthropic como fallback
 *  5. Grava o resultado no Firestore, na coleção "lancamentos"
 *     (mesma coleção que o painel HTML já está lendo)
 *
 * Formato esperado da mensagem (o que você já usa no grupo):
 *
 *   📌 Movimentação realizada em 02/07/2026
 *   👤 FT: Carlos Lopes
 *   ⚠️ Motivo: Extra
 *   💵 Valor R$: 160,00
 *   🕒 Horário: 18:00 as 06:00
 *   📄 Contrato: Pantanal
 *
 * ---------------------------------------------------------------
 * INSTALAÇÃO (rodar num servidor, ex: Railway/Render/VPS - não
 * funciona em GitHub Pages/Netlify pois precisa ficar 24/7 ativo):
 *
 *   npm init -y
 *   npm install @whiskeysockets/baileys firebase-admin qrcode-terminal pino @anthropic-ai/sdk
 *
 * Depois (SEM precisar de arquivo .json no repositório - tudo via
 * variável de ambiente, então pode usar repositório PÚBLICO):
 *   1. Abra o arquivo de credenciais de "Service Account" do Firebase
 *      (Configurações do projeto > Contas de serviço > Gerar nova
 *      chave privada) num editor de texto e copie TODO o conteúdo.
 *   2. No Railway: vá em Variables > New Variable, crie uma variável
 *      chamada FIREBASE_CREDENTIALS e cole o JSON inteiro como valor.
 *   3. Ajuste GROUP_NAME abaixo com o nome exato do grupo.
 *   4. Crie a variável PAIRING_PHONE no Railway com o número do
 *      WhatsApp DEDICADO ao bot, no formato internacional sem
 *      espaços/símbolos. Ex: 5511999998888 (55 = Brasil, DDD + número).
 *   5. (Opcional, só se quiser o fallback de IA) crie a variável
 *      ANTHROPIC_API_KEY no Railway também.
 *   6. Suba o código pro GitHub (pode ser público, sem risco).
 *   7. Nos logs do Railway vai aparecer um CÓDIGO DE 8 DÍGITOS
 *      (não um QR Code). No celular do número dedicado: WhatsApp >
 *      Configurações > Aparelhos conectados > Conectar um aparelho >
 *      "Conectar com número de telefone" > digita esse código.
 * ---------------------------------------------------------------
 */

// Polyfill do crypto global — necessário porque o Baileys espera o
// Web Crypto API disponível globalmente (padrão a partir do Node 20).
// Isso garante compatibilidade mesmo se o servidor rodar Node 18.
const { webcrypto } = require('crypto');
if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
}

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const admin = require('firebase-admin');
const pino = require('pino');

// ===================== CONFIGURAÇÃO =====================
const GROUP_NAME = 'Movimentações Diárias';
const COLLECTION = 'lancamentos';
const USE_AI_FALLBACK = !!process.env.ANTHROPIC_API_KEY;
// ==========================================================

const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

let anthropic = null;
if (USE_AI_FALLBACK) {
  const Anthropic = require('@anthropic-ai/sdk');
  anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

// ---------- Extração via REGEX (formato padrão do grupo) ----------
function extrairComRegex(texto) {
  const dataMatch = texto.match(/(\d{2}\/\d{2}\/\d{4})/);
  if (!dataMatch) return null;

  // Remove asteriscos (formatação de negrito do WhatsApp) para não
  // depender de saber se o padrão usado foi "*Campo:*" ou "*Campo*:"
  const limpo = texto.replace(/\*/g, '');

  // Extrai um campo, pulando linhas que claramente são a data/cabeçalho
  // duplicado por engano (contém "Movimentação" ou outra data dd/mm/aaaa)
  function extrairCampo(regexLabel) {
    const regex = new RegExp(`${regexLabel}\\s*:?\\s*([^\\n]+)`, 'gi');
    const candidatos = [...limpo.matchAll(regex)];
    for (const m of candidatos) {
      const valor = m[1].trim();
      if (!valor) continue;
      if (/movimenta[cç][aã]o/i.test(valor)) continue;
      if (/^\d{2}\/\d{2}\/\d{4}/.test(valor)) continue;
      return valor;
    }
    return '';
  }

  const colaborador = extrairCampo('(?:FT|Colaborador)');
  if (!colaborador) return null; // sem colaborador válido, não é um lançamento

  const [dia, mes, ano] = dataMatch[1].split('/');
  return {
    dataISO: `${ano}-${mes}-${dia}`,
    data: dataMatch[1],
    colaborador,
    motivo: extrairCampo('Motivo'),
    valor: (limpo.match(/Valor\s*R?\$?\s*:?\s*\*?\s*([\d.,]+)/i) || [])[1] || '',
    horario: extrairCampo('Hor[áa]rio'),
    contrato: extrairCampo('Contrato'),
    origem: 'whatsapp-regex'
  };
}

// ---------- Extração via IA (fallback para texto livre) ----------
async function extrairComIA(texto) {
  if (!anthropic) return null;

  const resp = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: `Extraia os campos da mensagem abaixo, enviada num grupo de WhatsApp de uma empresa de segurança privada. Responda APENAS com um JSON válido, sem texto adicional, no formato:
{"dataISO":"AAAA-MM-DD","data":"DD/MM/AAAA","colaborador":"","motivo":"","valor":"","horario":"","contrato":""}
Se algum campo não existir na mensagem, deixe como string vazia. Use a data de hoje (${new Date().toLocaleDateString('pt-BR')}) se nenhuma data for mencionada.

Mensagem:
"""
${texto}
"""`
    }]
  });

  try {
    const raw = resp.content.find(c => c.type === 'text')?.text || '';
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    parsed.origem = 'whatsapp-ia';
    return parsed;
  } catch (e) {
    console.error('Falha ao interpretar resposta da IA:', e);
    return null;
  }
}

// ---------- Grava no Firestore ----------
async function salvarLancamento(dados, whatsappMsgId) {
  await db.collection(COLLECTION).add({
    ...dados,
    whatsappMsgId: whatsappMsgId || null,
    criadoEm: admin.firestore.FieldValue.serverTimestamp()
  });
  console.log('✅ Lançamento salvo:', dados.colaborador, dados.data);
}

// ---------- Remove lançamento quando a mensagem original é apagada ----------
async function removerLancamentoPorMsgId(whatsappMsgId) {
  const snap = await db.collection(COLLECTION)
    .where('whatsappMsgId', '==', whatsappMsgId)
    .get();

  if (snap.empty) {
    console.log('⚠️  Mensagem apagada no WhatsApp, mas nenhum lançamento correspondente foi encontrado.');
    return;
  }

  for (const doc of snap.docs) {
    await doc.ref.delete();
    console.log('🗑️  Lançamento removido (mensagem apagada no WhatsApp):', doc.id);
  }
}

// ---------- Processa cada mensagem recebida ----------
async function processarMensagem(texto, whatsappMsgId) {
  if (!texto || texto.length < 15) return; // ignora mensagens curtas/irrelevantes

  let dados = extrairComRegex(texto);

  if (!dados && USE_AI_FALLBACK) {
    console.log('⚙️  Padrão não reconhecido, tentando IA...');
    dados = await extrairComIA(texto);
  }

  if (!dados || !dados.colaborador) {
    console.log('⏭️  Mensagem ignorada (não parece um lançamento):', texto.slice(0, 60));
    return;
  }

  await salvarLancamento(dados, whatsappMsgId);
}

// ---------- Conexão com o WhatsApp ----------
async function iniciar() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const { version } = await fetchLatestBaileysVersion();
  const usarPairingCode = !!process.env.PAIRING_PHONE && !state.creds.registered;

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
    version
  });

  if (usarPairingCode) {
    // Espera meio segundo pro socket inicializar antes de pedir o código
    setTimeout(async () => {
      try {
        const codigo = await sock.requestPairingCode(process.env.PAIRING_PHONE);
        console.log('==================================================');
        console.log(`🔑 CÓDIGO DE PAREAMENTO: ${codigo}`);
        console.log('No celular do bot: WhatsApp > Aparelhos conectados >');
        console.log('Conectar um aparelho > Conectar com número de telefone');
        console.log('==================================================');
      } catch (e) {
        console.log('Erro ao gerar código de pareamento:', e.message);
      }
    }, 3000);
  }

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr && !usarPairingCode) {
      console.log('📱 Escaneie o QR Code abaixo com o WhatsApp do número do bot:');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`Conexão encerrada. Código: ${statusCode}. Motivo: ${lastDisconnect?.error?.message || 'desconhecido'}. Reconectar? ${shouldReconnect}`);
      if (shouldReconnect) {
        setTimeout(() => iniciar(), 5000); // espera 5s antes de tentar de novo
      }
    } else if (connection === 'open') {
      console.log('✅ Bot conectado ao WhatsApp.');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message) continue;

      const chatId = msg.key.remoteJid; // grupos terminam em @g.us
      if (!chatId?.endsWith('@g.us')) continue;

      // Confere se é do grupo certo (vale tanto para lançamento novo quanto para apagamento)
      let ehGrupoCerto = false;
      try {
        const metadata = await sock.groupMetadata(chatId);
        ehGrupoCerto = metadata.subject === GROUP_NAME;
      } catch (e) {
        continue;
      }
      if (!ehGrupoCerto) continue;

      // Mensagem apagada "para todos" chega como um protocolMessage do tipo REVOKE,
      // contendo a referência (key.id) da mensagem original que foi removida.
      if (msg.message.protocolMessage?.type === 0) {
        const idApagada = msg.message.protocolMessage.key?.id;
        if (idApagada) {
          await removerLancamentoPorMsgId(idApagada);
        }
        continue;
      }

      if (msg.key.fromMe) continue;

      const texto =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        '';

      await processarMensagem(texto, msg.key.id);
    }
  });
}

iniciar().catch(err => console.error('Erro ao iniciar o bot:', err));
