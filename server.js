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

let accessToken = null;

// Clear route - resets everything
app.get('/clear', (req, res) => {
  accessToken = null;
  try { fs.unlinkSync(TOKEN_FILE); } catch(e) {}
  res.send('Token cleared. <a href="/auth">Click here to re-authorize</a>');
});

app.get('/auth', (req, res) => {
  accessToken = null;
  try { fs.unlinkSync(TOKEN_FILE); } catch(e) {}
  const state = crypto.randomBytes(16).toString('hex');
  const redirectUri = APP_URL + '/auth/callback';
  const scopes = 'read_products,write_products';
  const authUrl = 'https://' + SHOPIFY_STORE + '/admin/oauth/authorize?client_id=' + SHOPIFY_CLIENT_ID + '&scope=' + scopes + '&redirect_uri=' + encodeURIComponent(redirectUri) + '&state=' + state;
  console.log('Redirecting to Shopify auth:', authUrl);
  res.redirect(authUrl);
});

app.get('/auth/callback', async (req, res) => {
  const code = req.query.code;
  console.log('Got callback with code:', code ? 'YES' : 'NO');
  try {
    const response = await fetch('https://' + SHOPIFY_STORE + '/admin/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: SHOPIFY_CLIENT_ID, client_secret: SHOPIFY_CLIENT_SECRET, code: code })
    });
    const data = await response.json();
    console.log('Token exchange response:', JSON.stringify(data));
    if (data.access_token) {
      accessToken = data.access_token;
      fs.writeFileSync(TOKEN_FILE, accessToken);
      console.log('Token saved successfully');
    } else {
      return res.status(500).send('Failed to get token: ' + JSON.stringify(data));
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
    const url = 'https://' + SHOPIFY_STORE + '/admin/api/2024-01/products.json?limit=250&fields=id,title,images,body_html&status=any';
    const response = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' }
    });
    const data = await response.json();
    console.log('Shopify response status:', response.status);
    if (data.errors) {
      console.log('Shopify error:', data.errors);
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
  const title = req.body.title;
  const imageUrl = req.body.imageUrl;
  console.log('Generating for:', title);

  const systemPrompt = 'You write Shopify product descriptions for a denim and streetwear brand called Politics Jeans.\n\nAlways follow this EXACT format — output ONLY these lines, nothing else:\n\nMaterial: [fabric content, e.g. 100% Cotton]\nFit: [fit type and fabric feel]\nColor: [main color and any embellishment colors]\nDetails: [key design details, construction, embellishments, pocket style, rise]\nStyle Number: [extract number from product title if present, otherwise write N/A]\n\nRules:\n- Be specific and factual\n- Use the image to identify colors, fabric, embellishments, and design details\n- Keep each line concise\n- Never add extra sections or commentary';

  try {
    var messageContent;
    if (imageUrl) {
      const imgRes = await fetch(imageUrl);
      const imgBuffer = await imgRes.buffer();
      const base64 = imgBuffer.toString('base64');
      const mimeType = imgRes.headers.get('content-type') || 'image/jpeg';
      messageContent = [
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
        { type: 'text', text: 'Product title: ' + title + '\nAnalyze the image carefully and fill in each field accurately.' }
      ];
    } else {
      messageContent = 'Product title: ' + title + '\nNo image provided — infer details from the title.';
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
    if (!data.content || !data.content[0]) {
      return res.status(500).json({ error: JSON.stringify(data) });
    }
    res.json({ description: data.content[0].text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/save', async (req, res) => {
  if (!accessToken) return res.status(401).json({ error: 'Not authenticated' });
  const productId = req.body.productId;
  const description = req.body.description;

  const html = description.split('\n')
    .filter(function(line) { return line.trim(); })
    .map(function(line) {
      const parts = line.split(':');
      const key = parts[0];
      const value = parts.slice(1).join(':');
      return '<p><strong>' + key + ':</strong>' + value + '</p>';
    }).join('');

  try {
    const response = await fetch('https://' + SHOPIFY_STORE + '/admin/api/2024-01/products/' + productId + '.json', {
      method: 'PUT',
      headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ product: { id: productId, body_html: html } })
    });
    console.log('Save status:', response.status);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log('Politics Jeans AI app running on port ' + PORT); });
