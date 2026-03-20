const http = require('http');
const fs = require('fs');
const path = require('path');

http.createServer((req, res) => {
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
