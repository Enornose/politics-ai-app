const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const APP_URL = 'https://politics-ai-app-production.up.railway.app';
const TOKEN_FILE = '/tmp/shopify_token.txt';

let accessToken = process.env.SHOPIFY_TOKEN || null;
if (!accessToken && fs.existsSync(TOKEN_FILE)) {
  accessToken = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  console.log('Loaded token from disk:', accessToken ? 'YES' : 'NO');
}

function saveToken(token) {
  accessToken = token;
  try { fs.writeFileSync(TOKEN_FILE, token); } catch(e) { console.error('Could not save token:', e.message); }
}

app.get('/auth', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  const redirectUri = `${APP_URL}/auth/callback`;
  const scopes = 'read_products,write_products';
  const authUrl = `https://${SHOPIFY_STORE}/admin/oauth/authorize?client_id=${SHOPIFY_CLIENT_ID}&scope=${scopes}&redirect_uri=${redirectUri}&state=${state}`;
  res.redirect(authUrl);
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const response = await fetch(`https://${SHOPIFY_STORE}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: SHOPIFY_CLIENT_ID, client_secret: SHOPIFY_CLIENT_SECRET, code })
    });
    const data = await response.json();
    if (data.access_token) {
      saveToken(data.access_token);
      console.log('Token saved to disk');
    }
    res.redirect('/');
  } catch (err) {
    console.error('OAuth error:', err);
    res.status(500).send('Auth failed: ' + err.message);
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  if (!accessToken) return res.redirect('/auth');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/products', async (req, res) => {
  if (!accessToken) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const response = await fetch(
      `https://${SHOPIFY_STORE}/admin/api/2024-01/products.json?limit=50&fields=id,title,images,body_html&status=any&order=created_at+desc`,
      { headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' } }
    );
    const data = await response.json();
    if (data.errors) {
      accessToken = null;
      try { fs.unlinkSync(TOKEN_FILE); } catch(e) {}
      return res.status(401).json({ error: 'Token expired' });
    }
    res.json(data.products || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/generate', async (req, res) => {
  const { title, imageUrl } = req.body;
  console.log('Generating for:', title);

  const systemPrompt = `You write Shopify product descriptions for a denim and streetwear brand called Politics Jeans.

Always follow this EXACT format — output ONLY these lines, nothing else, no intro, no extra text:

Material: [fabric content, e.g. 100% Cotton or 98% Cotton 2% Elastane]
Fit: [fit type and fabric feel, e.g. Slim straight fit with rigid denim]
Color: [main color and any embellishment colors]
Details: [key design details, construction, embellishments, pocket style, rise]
Style Number: [extract number from product title if present, otherwise write N/A]

Rules:
- Be specific and factual
- Use the image to identify colors, fabric, embellishments, and design details
- Keep each line concise — one line per field, no bullet points
- Never add extra sections or commentary`;

  try {
    let messageContent;
    if (imageUrl) {
      const imgRes = await fetch(imageUrl);
      const imgBuffer = await imgRes.buffer();
      const base64 = imgBuffer.toString('base64');
      const mimeType = imgRes.headers.get('content-type') || 'image/jpeg';
      messageContent = [
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
        { type: 'text', text: `Product title: ${title}\nAnalyze the image carefully and fill in each field accurately.` }
      ];
    } else {
      messageContent = `Product title: ${title}\nNo image provided — infer details from the title.`;
    }

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        system: systemPrompt,
        messages: [{ role: 'user', content: messageContent }]
      })
    });

    const data = await anthropicRes.json();
    console.log('Anthropic status:', anthropicRes.status);
    if (!data.content || !data.content[0]) {
      return res.status(500).json({ error: JSON.stringify(data) });
    }
    res.json({ description: data.content[0].text });
  } catch (err) {
    console.error('Generate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/save', async (req, res) => {
  if (!accessToken) return res.status(401).json({ error: 'Not authenticated' });
  const { productId, description } = req.body;

  // Convert spec format to clean HTML
  const html = description.split('\n')
    .filter(line => line.trim())
    .map(line => `<p><strong>${line.split(':')[0]}:</strong>${line.split(':').slice(1).join(':')}</p>`)
    .join('');

  try {
    const response = await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-01/products/${productId}.json`, {
      method: 'PUT',
      headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ product: { id: productId, body_html: html } })
    });
    const data = await response.json();
    console.log('Save status:', response.status);
    res.json({ success: true });
  } catch (err) {
    console.error('Save error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Politics Jeans AI app running on port ${PORT}`));
