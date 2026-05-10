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

// --- SISTEMA DE AGENDAMENTO ---
let scheduledMessages = [];
try {
    if (fs.existsSync('schedules.json')) {
        scheduledMessages = JSON.parse(fs.readFileSync('schedules.json', 'utf-8'));
        console.log(`[SCHEDULE] ${scheduledMessages.length} agendamentos carregados.`);
    }
} catch (e) {
    console.error('Erro ao carregar schedules.json:', e);
}

function saveSchedules() {
    try {
        fs.writeFileSync('schedules.json', JSON.stringify(scheduledMessages, null, 2));
    } catch (e) {
        console.error('Erro ao salvar schedules.json:', e);
    }
}

// Verifica agendamentos a cada 1 minuto
setInterval(async () => {
    const now = Date.now();
    let changed = false;
    
    for (let i = scheduledMessages.length - 1; i >= 0; i--) {
        const msg = scheduledMessages[i];
        if (msg.sendAt <= now) {
            try {
                const instance = await getOrCreateInstance(msg.instance || 'default');
                if (instance.status === 'connected' && instance.sock) {
                    const jid = msg.number.includes('@s.whatsapp.net') ? msg.number : `${msg.number}@s.whatsapp.net`;
                    await instance.sock.sendMessage(jid, { text: msg.text });
                    console.log(`[SCHEDULE] Mensagem enviada para ${msg.number}`);
                }
            } catch (err) {
                console.error(`[SCHEDULE] Erro ao enviar para ${msg.number}:`, err.message);
            }
            scheduledMessages.splice(i, 1);
            changed = true;
        }
    }
    
    if (changed) saveSchedules();
}, 60000);
// -------------------------------

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
    const force = req.query.force === 'true';
    
    if (force) {
        const existing = instances.get(instanceName);
        if (existing) {
            if (existing.sock) {
                try { existing.sock.end(); } catch(e) {}
            }
            instances.delete(instanceName);
        }
        
        const authFolder = `auth_info_${instanceName}`;
        try {
            fs.rmSync(authFolder, { recursive: true, force: true });
        } catch(e) {
            console.log(`[DEBUG] Erro ao deletar pasta ${authFolder}:`, e.message);
        }
    }

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

    const cleanPhone = phone.replace(/\D/g, '');
    const fullPhone = cleanPhone.startsWith('55') ? cleanPhone : `55${cleanPhone}`;

    // Derruba instância existente e apaga auth para começar do zero
    const existing = instances.get(instanceName);
    if (existing) {
        if (existing.sock) { try { existing.sock.end(); } catch(e) {} }
        instances.delete(instanceName);
    }
    const authFolder = `auth_info_${instanceName}`;
    try { fs.rmSync(authFolder, { recursive: true, force: true }); } catch(e) {}

    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Desktop'),
        printQRInTerminal: false
    });

    const instanceData = { sock, status: 'disconnected', qr: null, saveCreds, pairingMode: true };
    instances.set(instanceName, instanceData);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            instanceData.status = 'disconnected';
            const code = lastDisconnect?.error?.output?.statusCode;
            const loggedOut = code === DisconnectReason.loggedOut;
            
            // Se ainda está em modo de pareamento, aguarda o usuário digitar o código
            // antes de reconectar — não volta para modo QR automaticamente
            if (!instanceData.pairingMode && !loggedOut) {
                setTimeout(() => { instances.delete(instanceName); getOrCreateInstance(instanceName); }, 5000);
            } else if (!instanceData.pairingMode && loggedOut) {
                instances.delete(instanceName);
            }
        } else if (connection === 'open') {
            instanceData.status = 'connected';
            instanceData.qr = null;
            instanceData.pairingMode = false; // pareamento confirmado!
            console.log(`✅ WhatsApp Conectado via código para [${instanceName}]!`);
        }
    });
    sock.ev.on('creds.update', saveCreds);

    try {
        // Aguarda WebSocket conectar aos servidores WA mas antes do QR chegar
        await new Promise(r => setTimeout(r, 2000));
        const code = await sock.requestPairingCode(fullPhone);
        console.log(`[PAIR] Código: ${code} para ${fullPhone}`);
        // Após gerar o código, desativa pairingMode para permitir reconexão após confirmação
        instanceData.pairingMode = false;
        res.json({ code });
    } catch (err) {
        console.error('[PAIR] Erro:', err.message);
        instanceData.pairingMode = false;
        res.status(500).json({ error: err.message });
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

app.post('/schedule', async (req, res) => {
    try {
        const { number, text, sendAt, instance } = req.body;
        if (!number || !text || !sendAt) {
            return res.status(400).json({ success: false, error: 'Número, texto e sendAt (timestamp) são obrigatórios' });
        }
        
        scheduledMessages.push({
            number,
            text,
            sendAt: parseInt(sendAt),
            instance: instance || 'default'
        });
        
        saveSchedules();
        res.json({ success: true, message: 'Mensagem agendada com sucesso' });
    } catch (err) {
        console.error('Erro ao agendar mensagem:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

const PORT = 3003;
app.listen(PORT, async () => {
    const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    console.log(`🚀 API do Bot rodando em ${url}`);
    
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
