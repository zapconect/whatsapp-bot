import makeWASocket, { 
    useMultiFileAuthState, 
    DisconnectReason,
    Browsers,
    fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import pino from 'pino';
import express from 'express';
import cors from 'cors';
import QRCode from 'qrcode';

const app = express();
app.use(cors());

let qrCodeDataURL = null;
let connectionStatus = 'disconnected';
let waSocket = null;

async function connectToWhatsApp() {
    console.log('[DEBUG] Iniciando useMultiFileAuthState...');
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    console.log('[DEBUG] useMultiFileAuthState concluído.');

    console.log('[DEBUG] Fetching WA Web version...');
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`[DEBUG] WA Version: ${version.join('.')}, isLatest: ${isLatest}`);

    // Em ESM o import default já é a função
    console.log('[DEBUG] Chamando makeWASocket...');
    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Desktop')
    });
    
    waSocket = sock;

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            try {
                qrCodeDataURL = await QRCode.toDataURL(qr);
                console.log('--- NOVO QR CODE GERADO (Pode ser lido no App) ---');
            } catch (err) {
                console.error('Erro ao gerar imagem QR Code:', err);
                // Fallback: enviar a string do QR puro e deixar o frontend lidar com isso, ou continuar null
                qrCodeDataURL = qr; 
            }
        }

        if (connection === 'close') {
            console.log('[DEBUG] Connection Closed:', lastDisconnect?.error);
            connectionStatus = 'disconnected';
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            connectionStatus = 'connected';
            qrCodeDataURL = null;
            console.log('✅ WhatsApp Conectado!');
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

app.get('/status', (req, res) => {
    res.json({ status: connectionStatus, hasQr: !!qrCodeDataURL });
});

app.get('/qr', (req, res) => {
    if (qrCodeDataURL) {
        const base64 = qrCodeDataURL.replace(/^data:image\/png;base64,/, '');
        res.json({ qr: base64 });
    } else {
        res.status(404).json({ error: 'QR Code não disponível' });
    }
});

app.use(express.json()); // Middleware para ler JSON no corpo da requisição

app.post('/send', async (req, res) => {
    try {
        if (connectionStatus !== 'connected' || !waSocket) {
            return res.status(400).json({ success: false, error: 'WhatsApp não está conectado' });
        }

        const { number, text } = req.body;
        if (!number || !text) {
            return res.status(400).json({ success: false, error: 'Número e texto são obrigatórios' });
        }

        // Formata o número (adiciona @s.whatsapp.net se não tiver)
        const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`;

        const sentMsg = await waSocket.sendMessage(jid, { text: text });
        res.json({ success: true, messageId: sentMsg?.key?.id });
    } catch (err) {
        console.error('Erro ao enviar mensagem:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

const PORT = 3003;
app.listen(PORT, () => {
    console.log(`🚀 API do Bot rodando em http://localhost:${PORT}`);
    connectToWhatsApp();
});
