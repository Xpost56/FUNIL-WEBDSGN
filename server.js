/**
 * ZapFunil — Servidor Online (Railway + PostgreSQL)
 * node server.js
 */

const express   = require('express');
const http      = require('http');
const https     = require('https');
const WebSocket = require('ws');
const path      = require('path');
const fs        = require('fs');
const multer    = require('multer');
const csv       = require('csv-parse/sync');

// ─── PostgreSQL ───────────────────────────────────────────────────────────────
let pgClient = null;

async function initDB() {
  if (!process.env.DATABASE_URL) {
    console.log('[DB] DATABASE_URL não definido — usando memória (dados não persistem)');
    return;
  }
  try {
    const { Client } = require('pg');
    pgClient = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await pgClient.connect();
    await pgClient.query(`
      CREATE TABLE IF NOT EXISTS zapfunil_leads (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS zapfunil_funnel (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL
      );
    `);
    console.log('[DB] PostgreSQL conectado ✅');
  } catch (e) {
    console.error('[DB] Erro ao conectar:', e.message);
    pgClient = null;
  }
}

async function dbLoadLeads() {
  if (!pgClient) return null;
  try {
    const r = await pgClient.query("SELECT data FROM zapfunil_leads ORDER BY (data->>'createdAt') ASC");
    return r.rows.map(row => row.data);
  } catch (e) { console.error('[DB] loadLeads:', e.message); return null; }
}

async function dbSaveLeads(leads) {
  if (!pgClient) return;
  try {
    await pgClient.query('DELETE FROM zapfunil_leads');
    for (const lead of leads) {
      await pgClient.query(
        'INSERT INTO zapfunil_leads (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = $2',
        [lead.id, JSON.stringify(lead)]
      );
    }
  } catch (e) { console.error('[DB] saveLeads:', e.message); }
}

async function dbLoadFunnel() {
  if (!pgClient) return null;
  try {
    const r = await pgClient.query("SELECT data FROM zapfunil_funnel WHERE id = 'steps'");
    if (r.rows.length) return r.rows[0].data;
    return null;
  } catch (e) { console.error('[DB] loadFunnel:', e.message); return null; }
}

async function dbSaveFunnel(steps) {
  if (!pgClient) return;
  try {
    await pgClient.query(
      "INSERT INTO zapfunil_funnel (id, data) VALUES ('steps', $1) ON CONFLICT (id) DO UPDATE SET data = $1",
      [JSON.stringify(steps)]
    );
  } catch (e) { console.error('[DB] saveFunnel:', e.message); }
}

// ─── Evolution API Config ─────────────────────────────────────────────────────
const EVO_HOST     = process.env.EVO_HOST     || 'evolution-api-production-a123.up.railway.app';
const EVO_KEY      = process.env.EVO_KEY      || 'apidozap';
const EVO_INSTANCE = process.env.EVO_INSTANCE || 'zapfunil';

function evoRequest(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: EVO_HOST,
      path: endpoint,
      method: method,
      headers: { 'apikey': EVO_KEY, 'Content-Type': 'application/json' }
    };
    if (data) options.headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch { resolve({ raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ─── Upload em memória (Railway não tem disco persistente) ────────────────────
const storage = multer.memoryStorage();
const upload  = multer({ storage });

// ─── State ────────────────────────────────────────────────────────────────────
let connected = false;
let leads     = [];
let steps     = [];
let wss;

function defaultSteps() {
  return [
    { id: 1, name: 'Boas-vindas',  message: 'Olá {nome}! 👋 Obrigado pelo contato.', delayMinutes: 0,    type: 'text', mediaUrl: '' },
    { id: 2, name: 'Apresentação', message: 'Aqui está nossa apresentação!',           delayMinutes: 1440, type: 'text', mediaUrl: '' },
    { id: 3, name: 'Follow-up',    message: '{nome}, ficou alguma dúvida?',             delayMinutes: 2880, type: 'text', mediaUrl: '' },
  ];
}

// ─── Express + WS ─────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
wss          = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(__dirname));

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data });
  wss.clients.forEach(c => c.readyState === WebSocket.OPEN && c.send(msg));
}
function log(msg) {
  console.log('[ZapFunil]', msg);
  broadcast('log', { msg });
}

wss.on('connection', ws => {
  ws.send(JSON.stringify({ type: 'init', data: { connected, leads, steps } }));
  checkStatus();
});

// ─── Status ───────────────────────────────────────────────────────────────────
async function checkStatus() {
  try {
    const data = await evoRequest('GET', `/instance/connectionState/${EVO_INSTANCE}`);
    console.log('[checkStatus]', JSON.stringify(data));
    const state = data?.instance?.state || data?.state;
    connected = state === 'open';
    broadcast('status', { connected });
    if (connected) log('✅ WhatsApp conectado!');
  } catch (e) {
    console.log('[checkStatus] erro:', e.message);
    connected = false;
    broadcast('status', { connected: false });
  }
}

setInterval(checkStatus, 15000);

// ─── Envio ────────────────────────────────────────────────────────────────────
async function sendStep(phone, step, leadName) {
  const digits = phone.replace(/\D/g, '');
  const number = digits.startsWith('55') ? digits : '55' + digits;

  const messages = (step.messages && step.messages.length)
    ? step.messages
    : [{ type: step.type || 'text', message: step.message || '', mediaUrl: step.mediaUrl || '' }];

  for (const msg of messages) {
    const text = (msg.message || '').replace(/\{nome\}/gi, leadName || '');

    if (msg.type === 'text' || !msg.mediaUrl) {
      if (text) {
        const r = await evoRequest('POST', `/message/sendText/${EVO_INSTANCE}`, { number, text });
        console.log('[sendText]', JSON.stringify(r));
      }
    } else {
      const mimetypes = { audio: 'audio/mp4', image: 'image/jpeg', video: 'video/mp4', document: 'application/pdf' };
      const r = await evoRequest('POST', `/message/sendMedia/${EVO_INSTANCE}`, {
        number,
        mediatype: msg.type,
        mimetype:  mimetypes[msg.type] || 'application/octet-stream',
        media:     msg.mediaUrl,
        fileName:  path.basename(msg.mediaUrl || 'arquivo'),
        caption:   text,
      });
      console.log('[sendMedia]', JSON.stringify(r));
    }
    if (messages.length > 1) await sleep(1500);
  }
}

async function fireLead(lead) {
  if (!connected) throw new Error('WhatsApp não conectado');
  if (lead.completed) throw new Error('Lead já completou o funil');
  const step = steps[lead.currentStep];
  if (!step) throw new Error('Etapa não encontrada');

  log(`📤 Enviando "${step.name}" para ${lead.name || lead.phone}`);
  await sendStep(lead.phone, step, lead.name);

  lead.currentStep += 1;
  if (lead.currentStep >= steps.length) {
    lead.completed = true;
    log(`🏁 ${lead.name || lead.phone} completou o funil!`);
  }
  lead.lastFired = new Date().toISOString();
  await dbSaveLeads(leads);
}

// ─── API ──────────────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => res.json({
  connected,
  leadsTotal: leads.length,
  activeLeads: leads.filter(l => !l.completed).length
}));

app.post('/api/connect', async (req, res) => {
  try {
    await checkStatus();
    if (!connected) {
      const data = await evoRequest('GET', `/instance/connect/${EVO_INSTANCE}`);
      console.log('[connect]', JSON.stringify(data));
      if (data?.base64) broadcast('qr', { qr: data.base64 });
    }
    res.json({ ok: true });
  } catch (e) {
    console.log('[connect] erro:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/disconnect', async (req, res) => {
  try {
    await evoRequest('DELETE', `/instance/logout/${EVO_INSTANCE}`);
    connected = false;
    broadcast('status', { connected: false });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/leads', (req, res) => res.json(leads));

app.post('/api/leads/add', async (req, res) => {
  const { name, phone } = req.body;
  const lead = {
    id: String(Date.now()),
    name: name || '',
    phone,
    currentStep: 0,
    completed: false,
    createdAt: new Date().toISOString()
  };
  leads.push(lead);
  await dbSaveLeads(leads);
  res.json(lead);
});

app.delete('/api/leads/:id', async (req, res) => {
  leads = leads.filter(l => l.id !== req.params.id);
  await dbSaveLeads(leads);
  res.json({ ok: true });
});

app.post('/api/leads/:id/restart', async (req, res) => {
  const lead = leads.find(l => l.id === req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
  lead.currentStep = 0;
  lead.completed   = false;
  await dbSaveLeads(leads);
  res.json({ ok: true });
});

app.post('/api/leads/import', upload.single('file'), async (req, res) => {
  try {
    const content = req.file.buffer.toString('utf8');
    const separator = content.includes(';') ? ';' : ',';

    let records;
    try {
      records = csv.parse(content, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        delimiter: separator,
        relax_column_count: true,
        relax_quotes: true,
        quote: '"',
      });
    } catch (parseErr) {
      // Fallback: parser linha-a-linha tolerante a aspas mal formadas
      records = parseCSVLoose(content, separator);
    }

    const normalizePhone = (p) => String(p || '').replace(/\D/g, '');

    const existingPhones = new Set(leads.map(l => normalizePhone(l.phone)));
    const seenInBatch = new Set();

    const imported = records.map(r => {
      const row = {};
      Object.keys(r).forEach(k => { row[k.toLowerCase().trim().replace(/\s+/g,'')] = (r[k]||'').trim(); });
      const name  = row['nome'] || row['name'] || row['contato'] || '';
      const phone = row['telefone'] || row['phone'] || row['whatsapp'] || row['fone'] || row['celular'] || '';
      const score  = row['score'] || '';
      const status = row['status'] || '';
      return {
        id: String(Date.now() + Math.random()),
        name, phone, score, status,
        currentStep: 0,
        completed: false,
        createdAt: new Date().toISOString(),
      };
    }).filter(l => {
      if (!l.phone) return false;
      const norm = normalizePhone(l.phone);
      if (!norm) return false;
      if (existingPhones.has(norm)) return false;
      if (seenInBatch.has(norm)) return false;
      seenInBatch.add(norm);
      return true;
    });

    const skipped = records.length - imported.length;

    leads = [...leads, ...imported];
    await dbSaveLeads(leads);
    res.json({ ok: true, count: imported.length, skipped, leads: imported });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Parser CSV tolerante: lida com aspas mal formadas / aninhadas sem abortar o arquivo inteiro
function parseCSVLoose(content, separator) {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim().length);
  if (!lines.length) return [];

  function parseLine(line) {
    const fields = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        // Trata aspas duplicadas "" como aspas literais, senão alterna estado
        if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = !inQuotes;
      } else if (c === separator && !inQuotes) {
        fields.push(cur);
        cur = '';
      } else {
        cur += c;
      }
    }
    fields.push(cur);
    return fields.map(f => f.trim());
  }

  const header = parseLine(lines[0]).map(h => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseLine(lines[i]);
    const obj = {};
    header.forEach((h, idx) => { obj[h] = vals[idx] !== undefined ? vals[idx] : ''; });
    rows.push(obj);
  }
  return rows;
}

app.get('/api/funnel', (req, res) => res.json(steps));

app.post('/api/funnel', async (req, res) => {
  steps = req.body.steps || [];
  await dbSaveFunnel(steps);
  broadcast('init', { connected, leads, steps });
  res.json({ ok: true });
});

app.post('/api/fire/:id', async (req, res) => {
  const lead = leads.find(l => l.id === req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
  try { await fireLead(lead); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/fire-specific', async (req, res) => {
  const { leadId, stepIndex } = req.body;
  const lead = leads.find(l => l.id === leadId);
  if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
  const step = steps[stepIndex];
  if (!step) return res.status(400).json({ error: 'Etapa não encontrada' });
  if (!connected) return res.status(400).json({ error: 'WhatsApp não conectado' });

  try {
    const { customText } = req.body;
    if (customText) {
      log(`📤 Msg avulsa para ${lead.name || lead.phone}`);
      const digits = lead.phone.replace(/\D/g,'');
      const number = digits.startsWith('55') ? digits : '55' + digits;
      const r2 = await evoRequest('POST', `/message/sendText/${EVO_INSTANCE}`, { number, text: customText });
      console.log('[quickMsg]', JSON.stringify(r2));
      return res.json({ ok: true });
    }
    log(`📤 Enviando "${step.name}" para ${lead.name || lead.phone}`);
    await sendStep(lead.phone, step, lead.name);
    if (lead.currentStep === stepIndex) {
      lead.currentStep += 1;
      if (lead.currentStep >= steps.length) lead.completed = true;
    }
    lead.lastFired = new Date().toISOString();
    await dbSaveLeads(leads);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/fire-step', async (req, res) => {
  const { stepIndex } = req.body;
  const step = steps[stepIndex];
  if (!step) return res.status(400).json({ error: 'Etapa não encontrada' });
  res.json({ ok: true });

  const targets = leads.filter(l => !l.completed && l.currentStep === stepIndex);
  log(`🚀 Disparando etapa "${step.name}" para ${targets.length} leads...`);
  for (const lead of targets) {
    try {
      await fireLead(lead);
      broadcast('init', { connected, leads, steps });
      await sleep(3000 + Math.random() * 4000);
    } catch (e) { log(`❌ ${lead.phone}: ${e.message}`); }
  }
  log(`✅ Etapa "${step.name}" concluída!`);
});

app.post('/api/fire-all', async (req, res) => {
  res.json({ ok: true });
  const pending = leads.filter(l => !l.completed && l.currentStep < steps.length);
  log(`🚀 Disparando para ${pending.length} leads...`);
  for (const lead of pending) {
    try {
      await fireLead(lead);
      broadcast('init', { connected, leads, steps });
      await sleep(3000 + Math.random() * 4000);
    } catch (e) { log(`❌ ${lead.phone}: ${e.message}`); }
  }
  log('✅ Disparo concluído!');
});

// Upload de mídia — converte para base64 e retorna URL pública (se configurada)
// Sem disco persistente no Railway: mídias devem ser hospedadas externamente (Cloudinary, S3, etc.)
// Este endpoint retorna aviso para orientar o usuário
app.post('/api/media/upload', upload.single('file'), (req, res) => {
  res.status(400).json({
    error: 'Upload de mídia local não disponível no modo online. Hospede o arquivo em um serviço como Cloudinary ou Imgur e use a URL diretamente na etapa do funil.'
  });
});

app.get('/api/messages/:phone', async (req, res) => {
  try {
    const digits = req.params.phone.replace(/\D/g,'');
    const number = digits.startsWith('55') ? digits : '55' + digits;
    const data = await evoRequest('POST', `/chat/findMessages/${EVO_INSTANCE}`, {
      where: { key: { remoteJid: number + '@s.whatsapp.net' } },
      limit: 50
    });
    const msgs = data?.messages?.records || data?.messages || data || [];
    const list = Array.isArray(msgs) ? msgs.map(m => ({
      fromMe:    m.key?.fromMe || false,
      body:      m.message?.conversation || m.message?.extendedTextMessage?.text || m.body || '',
      type:      m.messageType || 'text',
      timestamp: m.messageTimestamp || m.timestamp || 0,
    })).sort((a,b) => a.timestamp - b.timestamp) : [];
    res.json({ messages: list });
  } catch(e) {
    console.log('[messages] erro:', e.message);
    res.json({ messages: [] });
  }
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function boot() {
  await initDB();

  // Carrega dados do banco (ou usa padrão)
  const savedLeads  = await dbLoadLeads();
  const savedFunnel = await dbLoadFunnel();

  leads = savedLeads  || [];
  steps = savedFunnel || defaultSteps();

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`\n✅ ZapFunil rodando em http://localhost:${PORT}\n`);
    checkStatus();
  });
}

boot();
