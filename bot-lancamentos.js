/**
 * BOT DE CAPTURA — Lançamentos via WhatsApp (Grupo M.S)
 * ---------------------------------------------------------------
 * Revisão: fallback QR Code, auto-limpeza de credenciais, logs detalhados
 */

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
const fs = require('fs');
const path = require('path');

// ===================== CONFIGURAÇÃO =====================
const GROUP_NAME = 'Movimentações Diárias';
const COLLECTION = 'lancamentos';
const USE_AI_FALLBACK = !!process.env.ANTHROPIC_API_KEY;
const AUTH_DIR = 'auth_info';
// ==========================================================

const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

let anthropic = null;
if (USE_AI_FALLBACK) {
  const Anthropic = require('@anthropic-ai/sdk');
  anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

// ---------- Limpeza de credenciais se detectado erro de pareamento ----------
function limparCredenciais() {
  const authPath = path.join(__dirname, AUTH_DIR);
  if (fs.existsSync(authPath)) {
    fs.rmSync(authPath, { recursive: true, force: true });
    console.log('🧹 Credenciais antigas removidas. Tentando novamente...');
  }
}

// ---------- Extração via REGEX (formato padrão do grupo) ----------
function extrairComRegex(texto) {
  const dataMatch = texto.match(/(\d{2}\/\d{2}\/\d{4})/);
  if (!dataMatch) return null;

  const limpo = texto.replace(/\*/g, '');

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
  if (!colaborador) return null;

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

// ---------- Extração via IA (fallback) ----------
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
  if (!texto || texto.length < 15) return;

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

// ---------- Conexão com o WhatsApp (com fallback QR) ----------
async function iniciar() {
  // Se houver erro de pareamento, forçamos limpeza na próxima execução
  let tentativaQR = false;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
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
      setTimeout(async () => {
        try {
          const codigo = await sock.requestPairingCode(process.env.PAIRING_PHONE);
          console.log('==================================================');
          console.log(`🔑 CÓDIGO DE PAREAMENTO: ${codigo}`);
          console.log('No celular do bot: WhatsApp > Aparelhos conectados >');
          console.log('Conectar um aparelho > Conectar com número de telefone');
          console.log('==================================================');
        } catch (e) {
          console.log('❌ Erro ao gerar código de pareamento:', e.message);
          console.log('🔄 Mudando para QR Code como fallback...');
          tentativaQR = true;
          // Forçar QR Code reiniciando sem PAIRING_PHONE
          process.env.PAIRING_PHONE = '';
          // Limpar credenciais para evitar conflito
          limparCredenciais();
          // Reiniciar o bot
          setTimeout(() => iniciar(), 2000);
        }
      }, 3000);
    }

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr && !usarPairingCode && !tentativaQR) {
        console.log('📱 Escaneie o QR Code abaixo com o WhatsApp do número do bot:');
        qrcode.generate(qr, { small: true });
      }
      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log(`Conexão encerrada. Código: ${statusCode}. Motivo: ${lastDisconnect?.error?.message || 'desconhecido'}. Reconectar? ${shouldReconnect}`);
        if (statusCode === 401 || statusCode === 403) {
          // Credenciais inválidas, limpar e reiniciar
          limparCredenciais();
        }
        if (shouldReconnect) {
          setTimeout(() => iniciar(), 5000);
        } else {
          console.log('🔒 Deslogado permanentemente. Para reconectar, limpe a pasta auth_info e reinicie.');
        }
      } else if (connection === 'open') {
        console.log('✅ Bot conectado ao WhatsApp.');
      }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages) {
        if (!msg.message) continue;

        const chatId = msg.key.remoteJid;
        if (!chatId?.endsWith('@g.us')) continue;

        let ehGrupoCerto = false;
        try {
          const metadata = await sock.groupMetadata(chatId);
          ehGrupoCerto = metadata.subject === GROUP_NAME;
        } catch (e) {
          continue;
        }
        if (!ehGrupoCerto) continue;

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

  } catch (error) {
    console.error('Erro fatal ao iniciar:', error);
    // Se erro de pareamento, tenta QR Code
    if (error.message && error.message.includes('pairing')) {
      limparCredenciais();
      process.env.PAIRING_PHONE = '';
      setTimeout(() => iniciar(), 3000);
    }
  }
}

iniciar().catch(err => console.error('Erro ao iniciar o bot:', err));
