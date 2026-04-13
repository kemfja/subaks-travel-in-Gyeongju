const https = require('https');

const BASE_URL = 'https://firestore.googleapis.com/v1/projects/subak-map/databases/(default)/documents/gyeongju/globalData';

// Helper to convert Firestore arrayValue to regular JS arrays
function parseFirestoreArray(arrayVal) {
    if (!arrayVal || !arrayVal.values) return [];
    return arrayVal.values.map(val => {
        if (val.mapValue) {
            const obj = {};
            for (const [k, v] of Object.entries(val.mapValue.fields)) {
                if (v.stringValue !== undefined) obj[k] = v.stringValue;
                else if (v.integerValue !== undefined) obj[k] = parseInt(v.integerValue, 10);
                else if (v.doubleValue !== undefined) obj[k] = parseFloat(v.doubleValue);
                else if (v.booleanValue !== undefined) obj[k] = v.booleanValue;
                else if (v.arrayValue !== undefined) obj[k] = parseFirestoreArray(v.arrayValue);
            }
            return obj;
        }
        return val.stringValue || val;
    });
}

// Convert JS to Firestore payload
function toFirestorePayload(trips) {
    return {
        fields: {
            trips: {
                arrayValue: {
                    values: trips.map(trip => {
                        const tripMap = {
                            id: { stringValue: trip.id },
                            name: { stringValue: trip.name },
                            totalDays: { integerValue: trip.totalDays.toString() },
                            days: {
                                arrayValue: {
                                    values: trip.days.map(day => ({
                                        mapValue: {
                                            fields: {
                                                items: {
                                                    arrayValue: {
                                                        values: (day.items || []).map(item => ({
                                                            mapValue: {
                                                                fields: {
                                                                    id: { stringValue: item.id },
                                                                    name: { stringValue: item.name },
                                                                    type: { stringValue: item.type }
                                                                }
                                                            }
                                                        }))
                                                    }
                                                }
                                            }
                                        }
                                    }))
                                }
                            }
                        };
                        if (trip.date) {
                            tripMap.date = { stringValue: trip.date };
                        }
                        return {
                            mapValue: {
                                fields: tripMap
                            }
                        };
                    })
                }
            }
        }
    };
}

// Fetch current
https.get(BASE_URL, (res) => {
    let raw = '';
    res.on('data', chunk => raw += chunk);
    res.on('end', () => {
        const data = JSON.parse(raw);
        const fbTrips = data.fields && data.fields.trips ? data.fields.trips : null;
        let parsedTrips = [];
        if (fbTrips && fbTrips.arrayValue) {
            parsedTrips = parseFirestoreArray(fbTrips.arrayValue);
        }

        console.log("Current Trips:", parsedTrips.map(t => `${t.name} (days: ${t.totalDays})`));

        // Find the trip to split. The user mentioned it has Day 1~4.
        const targetTripIndex = parsedTrips.findIndex(t => t.totalDays >= 4);
        
        if (targetTripIndex === -1) {
            console.log("No 4-day trip found to split!");
            return;
        }

        const originalTrip = parsedTrips[targetTripIndex];
        console.log("Found original trip to split:", originalTrip.id);

        const gyeongjuTrip = {
            id: 'trip-gyeongju-' + Date.now(),
            name: '경주여행',
            date: '3/21~3/23',
            totalDays: 3,
            days: originalTrip.days.slice(0, 3)
        };

        const daejeonTrip = {
            id: 'trip-daejeon-' + Date.now(),
            name: '대전 여행',
            date: '4/11',
            totalDays: 1,
            days: [ originalTrip.days[3] ] // Day 4
        };

        // Replace original with the two new ones
        parsedTrips.splice(targetTripIndex, 1, gyeongjuTrip, daejeonTrip);

        console.log("New Trips Config:", parsedTrips.map(t => `${t.name} (days: ${t.totalDays}, date: ${t.date || ''})`));

        // Save back
        const payloadStr = JSON.stringify(toFirestorePayload(parsedTrips));

        const req = https.request(BASE_URL + '?updateMask.fieldPaths=trips', {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payloadStr)
            }
        }, (patchRes) => {
            let patchRaw = '';
            patchRes.on('data', c => patchRaw += c);
            patchRes.on('end', () => {
                console.log("Patch Response Code:", patchRes.statusCode);
                if (patchRes.statusCode === 200) {
                    console.log("Successfully migrated trips in Firestore!");
                } else {
                    console.error("Failed to patch:", patchRaw);
                }
            });
        });

        req.write(payloadStr);
        req.end();
    });
});
