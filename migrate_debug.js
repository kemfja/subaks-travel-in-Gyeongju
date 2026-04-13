const https = require('https');
const BASE_URL = 'https://firestore.googleapis.com/v1/projects/subak-map/databases/(default)/documents/gyeongju/globalData';

https.get(BASE_URL, (res) => {
    let raw = '';
    res.on('data', chunk => raw += chunk);
    res.on('end', () => {
        const data = JSON.parse(raw);
        console.log(Object.keys(data.fields));
        if (data.fields.trips) console.log("Has trips array");
        else console.log("No trips in fields.");
        
        if (data.fields.trips && data.fields.trips.arrayValue) {
            console.log("Trip item count:", data.fields.trips.arrayValue.values ? data.fields.trips.arrayValue.values.length : 0);
        }
    });
});
