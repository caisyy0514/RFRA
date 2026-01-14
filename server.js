import express from 'express';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to parse JSON bodies
app.use(express.json());

// OKX API Proxy Endpoint
app.all('/api/proxy/*', async (req, res) => {
  try {
    // 1. Extract Configuration from Headers
    const apiKey = req.headers['x-api-key'];
    const secretKey = req.headers['x-secret-key'];
    const passphrase = req.headers['x-passphrase'];
    const isSimulated = req.headers['x-simulated-trading'] === '1';

    if (!apiKey || !secretKey || !passphrase) {
      return res.status(401).json({ code: '401', msg: 'Missing API Credentials', data: [] });
    }

    // 2. Prepare Target URL
    // Remove '/api/proxy' prefix to get the real OKX path (e.g., /api/v5/account/balance)
    const requestPath = req.url.replace('/api/proxy', '');
    const baseUrl = 'https://www.okx.com';
    const targetUrl = `${baseUrl}${requestPath}`;

    // 3. Generate OKX Signature
    const timestamp = new Date().toISOString();
    const method = req.method.toUpperCase();
    const body = (method === 'POST' || method === 'PUT') && req.body && Object.keys(req.body).length > 0 
      ? JSON.stringify(req.body) 
      : '';
    
    // Prehash string: timestamp + method + requestPath + body
    const preHash = timestamp + method + requestPath + body;
    const signature = crypto.createHmac('sha256', secretKey).update(preHash).digest('base64');

    // 4. Forward Request
    const headers = {
      'OK-ACCESS-KEY': apiKey,
      'OK-ACCESS-SIGN': signature,
      'OK-ACCESS-TIMESTAMP': timestamp,
      'OK-ACCESS-PASSPHRASE': passphrase,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };

    if (isSimulated) {
      headers['x-simulated-trading'] = '1';
    }

    const fetchOptions = {
      method,
      headers,
      body: method === 'GET' ? undefined : body
    };

    const response = await fetch(targetUrl, fetchOptions);
    
    // Handle non-JSON responses (like 502/504 HTML from Cloudflare)
    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
        const text = await response.text();
        console.error('OKX Non-JSON Response:', text);
        return res.status(response.status).json({ code: '500', msg: 'Upstream Error (Non-JSON)', data: [] });
    }

    const data = await response.json();
    res.status(response.status).json(data);

  } catch (error) {
    console.error('Proxy Error:', error);
    res.status(500).json({ code: '500', msg: error.message, data: [] });
  }
});

// Serve Static Files (Frontend)
app.use(express.static(__dirname));

// Fallback for SPA routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});