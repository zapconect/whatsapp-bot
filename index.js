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
import fs from 'fs';

const app = express();
app.use(cors());
app.use(express.json()); // Middleware para ler JSON no corpo da requisição

const instances = new Map(); // instanceName -> { sock, status, qr, saveCreds }

async function getOrCreateInstance(instanceName) {
    // Normaliza o nome da instância
    const name = instanceName || 'default';

    if (instances.has(name)) {
        return instances.get(name);
    }

    console.log(`[DEBUG] Iniciando instância: ${name}`);
    const folderName = `auth_info_${name}`;
    
    const { state, saveCreds } = await useMultiFileAuthState(folderName);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Desktop')
    });

    const instanceData = {
        sock,
        status: 'disconnected',
        qr: null,
        saveCreds
    };

    instances.set(name, instanceData);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            try {
                instanceData.qr = await QRCode.toDataURL(qr);
                console.log(`--- NOVO QR CODE GERADO para [${name}] ---`);
            } catch (err) {
                console.error(`Erro ao gerar imagem QR Code para ${name}:`, err);
                instanceData.qr = qr; 
            }
        }

        if (connection === 'close') {
            console.log(`[DEBUG] Connection Closed for [${name}]:`, lastDisconnect?.error);
            instanceData.status = 'disconnected';
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            
            if (shouldReconnect) {
                console.log(`[DEBUG] Tentando reconectar [${name}] em 5 segundos...`);
                setTimeout(() => {
                    instances.delete(name);
                    getOrCreateInstance(name);
                }, 5000);
            }
        } else if (connection === 'open') {
            instanceData.status = 'connected';
            instanceData.qr = null;
            console.log(`✅ WhatsApp Conectado para [${name}]!`);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    return instanceData;
}

app.get('/status', async (req, res) => {
    const instanceName = req.query.instance || 'default';
    const instance = await getOrCreateInstance(instanceName);
    res.json({ status: instance.status, hasQr: !!instance.qr });
});

app.get('/qr', async (req, res) => {
    const instanceName = req.query.instance || 'default';
    const instance = await getOrCreateInstance(instanceName);
    
    if (instance.qr) {
        const base64 = instance.qr.replace(/^data:image\/png;base64,/, '');
        res.json({ qr: base64 });
    } else {
        res.status(404).json({ error: 'QR Code não disponível ou já conectado' });
    }
});

app.get('/pair', async (req, res) => {
    const instanceName = req.query.instance || 'default';
    const phone = req.query.phone;
    
    if (!phone) {
        return res.status(400).json({ error: 'Número de telefone é obrigatório' });
    }

    const instance = await getOrCreateInstance(instanceName);

    try {
        if (instance.status === 'connected') {
            return res.json({ status: 'connected', message: 'Já conectado' });
        }

        const cleanPhone = phone.replace(/\D/g, '');
        const fullPhone = cleanPhone.startsWith('55') ? cleanPhone : `55${cleanPhone}`;
        
        const code = await instance.sock.requestPairingCode(fullPhone);
        res.json({ code });
    } catch (err) {
        console.error('Erro ao gerar código de pareamento:', err);
        res.status(500).json({ error: 'Erro ao gerar código de pareamento' });
    }
});

app.post('/send', async (req, res) => {
    try {
        const { number, text, instance: instanceName } = req.body;
        const name = instanceName || 'default';
        const instance = await getOrCreateInstance(name);

        if (instance.status !== 'connected' || !instance.sock) {
            return res.status(400).json({ success: false, error: `WhatsApp [${name}] não está conectado` });
        }

        if (!number || !text) {
            return res.status(400).json({ success: false, error: 'Número e texto são obrigatórios' });
        }

        const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`;
        const sentMsg = await instance.sock.sendMessage(jid, { text: text });
        res.json({ success: true, messageId: sentMsg?.key?.id });
    } catch (err) {
        console.error('Erro ao enviar mensagem:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

const PORT = 3003;
app.listen(PORT, async () => {
    console.log(`🚀 API do Bot Multi-Instâncias rodando em http://localhost:${PORT}`);
    
    // Auto-carrega instâncias existentes que estão em pastas
    try {
        const files = fs.readdirSync('.');
        const folders = files.filter(f => f.startsWith('auth_info_') && fs.statSync(f).isDirectory());
        
        for (const folder of folders) {
            const instanceName = folder.replace('auth_info_', '');
            if (instanceName !== 'baileys') { // ignora a pasta antiga genérica
                await getOrCreateInstance(instanceName);
            }
        }
    } catch (err) {
        console.error('Erro ao carregar instâncias existentes:', err);
    }
});
