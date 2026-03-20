const http = require('http');
const fs = require('fs');
const path = require('path');

// Simple .env parser since dotenv might not be installed
function getEnv() {
    let env = {};
    try {
        const envFile = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8');
        envFile.split('\n').forEach(line => {
            const match = line.match(/^\s*([\w]+)\s*=\s*(.*)\s*$/);
            if (match) {
                env[match[1]] = match[2];
            }
        });
    } catch (e) {
        console.error('.env file not found or could not be read.');
    }
    return env;
}

http.createServer((req, res) => {
    // API endpoint for fetching frontend configs safely
    if (req.url === '/api/config') {
        const env = getEnv();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            apiKey: env.VITE_FIREBASE_API_KEY || process.env.VITE_FIREBASE_API_KEY,
            authDomain: "subak-map.firebaseapp.com",
            projectId: "subak-map",
            storageBucket: "subak-map.firebasestorage.app",
            messagingSenderId: "368910159844",
            appId: "1:368910159844:web:148b22d919b29048af81f1"
        }));
        return;
    }

    let p = path.join(process.cwd(), req.url === '/' ? 'index.html' : req.url);
    fs.readFile(p, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('Not Found');
        } else {
            const ext = path.extname(p);
            let contentType = 'text/html';
            if (ext === '.js') contentType = 'text/javascript';
            if (ext === '.css') contentType = 'text/css';
            // Disable caching for dev
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(data);
        }
    });
}).listen(8080, () => console.log('Local server running on http://localhost:8080'));
