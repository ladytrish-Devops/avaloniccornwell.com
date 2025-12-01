// server.js
require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const basicAuth = require('basic-auth');
const cors = require('cors');

const app = express();

// --- Middleware ---
app.use(cors()); // enable CORS (adjust in production if needed)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Paths ---
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const LEADS_FILE = path.join(__dirname, 'leads.json');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// --- Multer storage and limits ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ts = Date.now();
    const safe = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    cb(null, `${ts}_${safe}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024, files: 5 } // 10MB per file, up to 5 files
});

// --- Simple leads persistence ---
function readLeads() {
  try {
    if (!fs.existsSync(LEADS_FILE)) return [];
    const raw = fs.readFileSync(LEADS_FILE, 'utf8');
    return JSON.parse(raw || '[]');
  } catch (e) {
    console.error('readLeads error', e);
    return [];
  }
}
function saveLead(lead) {
  try {
    const arr = readLeads();
    arr.unshift(lead);
    fs.writeFileSync(LEADS_FILE, JSON.stringify(arr, null, 2));
  } catch (e) {
    console.error('saveLead error', e);
  }
}

// --- Helpers ---
function escapeHtml(str = '') {
  return ('' + str).replace(/[&<>"']/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]));
}

// Basic auth for admin endpoints
function requireAuth(req, res, next) {
  const user = basicAuth(req);
  const adminUser = process.env.ADMIN_USER || 'admin';
  const adminPass = process.env.ADMIN_PASS || 'password';
  if (!user || user.name !== adminUser || user.pass !== adminPass) {
    res.set('WWW-Authenticate', 'Basic realm="Admin"');
    return res.status(401).send('Authentication required.');
  }
  next();
}

// --- Public endpoints ---
app.get('/health', (req, res) => res.json({ ok: true }));

// Accept form submissions with optional files (any field name)
// NOTE: frontend should POST multipart/form-data (FormData).
app.post('/api/submit', upload.any(), (req, res) => {
  try {
    const body = req.body || {};
    // map files to relative paths for admin links
    const files = (req.files || []).map(f => ({
      path: path.join('uploads', path.basename(f.path)).replace(/\\/g, '/'),
      originalname: f.originalname,
      mimetype: f.mimetype,
      size: f.size
    }));

    const lead = {
      id: Date.now(),
      receivedAt: new Date().toISOString(),
      company: body.company || '',
      contactName: body.name || body.contactName || '',
      phone: body.phone || '',
      email: body.email || '',
      amount: body.amount || '',
      sector: body.sector || '',
      message: body.message || '',
      files
    };

    saveLead(lead);

    // Optional email notification if SMTP set up
    if (process.env.NOTIFY_EMAIL && process.env.SMTP_HOST) {
      try {
        const nodemailer = require('nodemailer');
        (async () => {
          try {
            const transporter = nodemailer.createTransport({
              host: process.env.SMTP_HOST,
              port: parseInt(process.env.SMTP_PORT || '587', 10),
              secure: process.env.SMTP_SECURE === 'true',
              auth: process.env.SMTP_USER ? {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS
              } : undefined
            });

            const to = process.env.NOTIFY_EMAIL;
            const subject = `New funding request: ${lead.company || lead.contactName || 'Unknown'}`;
            const text = `New lead received:\n\nCompany: ${lead.company}\nContact: ${lead.contactName}\nEmail: ${lead.email}\nPhone: ${lead.phone}\nAmount: ${lead.amount}\n\nMessage:\n${lead.message}\n\nFiles:\n${files.map(f => f.originalname).join(', ')}`;

            await transporter.sendMail({
              from: process.env.SMTP_FROM || process.env.NOTIFY_EMAIL,
              to,
              subject,
              text
            });
          } catch (e) {
            console.error('Email notify failed', e);
          }
        })();
      } catch (e) {
        console.error('nodemailer missing or error', e);
      }
    }

    return res.json({ ok: true, id: lead.id });
  } catch (err) {
    console.error('submit error', err);
    return res.status(500).json({ ok: false, message: 'Server error' });
  }
});

// Serve uploaded files publicly (be careful in production)
app.use('/uploads', express.static(UPLOAD_DIR));

// --- Admin views (protected) ---
app.get('/admin', requireAuth, (req, res) => {
  const leads = readLeads();
  let html = `<!doctype html><html><head><meta charset="utf-8"><title>Avalonic Admin</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>body{font-family:Arial,Helvetica,sans-serif;color:#0b2545;padding:18px}table{width:100%;border-collapse:collapse}th,td{padding:8px;border-bottom:1px solid #eee;text-align:left}th{background:#f6fbff}a.file{display:inline-block;margin-right:6px;padding:4px;border:1px solid #eef6ff;border-radius:6px;text-decoration:none;color:#0b2545}</style>
  </head><body><h1>Avalonic Cornwell Funding — Admin</h1><p>Total leads: ${leads.length}</p><table><thead><tr><th>Date</th><th>Company</th><th>Contact</th><th>Email</th><th>Phone</th><th>Amount</th><th>Files</th></tr></thead><tbody>`;
  for (const l of leads) {
    const filesHtml = (l.files || []).map(f => `<a class="file" href="/${escapeHtml(f.path)}" target="_blank">${escapeHtml(f.originalname)}</a>`).join(' ');
    html += `<tr><td>${escapeHtml(new Date(l.receivedAt).toLocaleString())}</td><td>${escapeHtml(l.company)}</td><td>${escapeHtml(l.contactName)}</td><td>${escapeHtml(l.email)}</td><td>${escapeHtml(l.phone)}</td><td>${escapeHtml(l.amount)}</td><td>${filesHtml}</td></tr>`;
  }
  html += `</tbody></table></body></html>`;
  res.send(html);
});

app.get('/api/leads', requireAuth, (req, res) => {
  const leads = readLeads();
  res.json({ ok: true, total: leads.length, leads });
});

// --- Start server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
