const fs = require('fs');
const file = 'main.js';
let content = fs.readFileSync(file, 'utf8');

content = content.replace(
    "setTimeout(() => { map.invalidateSize(); if(window.fitAllMarkers) window.fitAllMarkers(); }, 50);",
    "setTimeout(() => { map.invalidateSize(); if(window.fitAllMarkers) window.fitAllMarkers(); }, 300);"
);

fs.writeFileSync(file, content);
console.log("Fix applied");
