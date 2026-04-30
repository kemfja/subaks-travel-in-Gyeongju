const fs = require('fs');

let js = fs.readFileSync('main.js', 'utf8');
js = js.replace(/\r\n/g, '\n');

// 1. Update the list buttons
const old_buttons = `<div class="flex items-center gap-2 shrink-0">
                                            <button onclick="editTrip(event, '\${trip.id}')" class="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-gray-500 hover:bg-gray-200 hover:text-gray-800 transition-colors" title="여행 정보 수정">
                                                ✏️
                                            </button>
                                            <button onclick="deleteTrip(event, '\${trip.id}')" class="w-8 h-8 rounded-full bg-red-50 flex items-center justify-center text-red-400 hover:bg-red-500 hover:text-white transition-colors" title="이 일정 삭제">
                                                🗑️
                                            </button>
                                            <div class="w-10 h-10 rounded-full bg-blue-50 flex items-center justify-center text-blue-500 group-hover:bg-blue-600 group-hover:text-white transition-colors">
                                                ➔
                                            </div>
                                        </div>`;

const new_buttons = `<div class="flex items-center gap-2 shrink-0">
                                            <button onclick="openShareModalForTrip(event, '\${trip.id}')" class="w-8 h-8 rounded-full bg-green-50 flex items-center justify-center text-green-600 hover:bg-green-100 hover:text-green-700 transition-colors" title="이 일정 공유">
                                                🔗
                                            </button>
                                            <button onclick="editTrip(event, '\${trip.id}')" class="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-gray-500 hover:bg-gray-200 hover:text-gray-800 transition-colors" title="여행 정보 수정">
                                                ✏️
                                            </button>
                                            <button onclick="deleteTrip(event, '\${trip.id}')" class="w-8 h-8 rounded-full bg-red-50 flex items-center justify-center text-red-400 hover:bg-red-500 hover:text-white transition-colors" title="이 일정 삭제">
                                                🗑️
                                            </button>
                                        </div>`;

if (js.includes(old_buttons)) {
    js = js.replace(old_buttons, new_buttons);
} else {
    console.log("old_buttons not found");
}

// 2. Add openShareModalForTrip
const old_delete_func = `        window.deleteTrip = (event, tripId) => {`;
const new_delete_func = `        window.openShareModalForTrip = (event, tripId) => {
            event.stopPropagation();
            if (!currentUser) {
                document.getElementById('login-required-modal').classList.remove('hidden');
                return;
            }
            window.tripIdToShare = tripId;
            document.getElementById('trip-share-modal')?.classList.remove('hidden');
        };

        window.deleteTrip = (event, tripId) => {`;

if (js.includes(old_delete_func)) {
    js = js.replace(old_delete_func, new_delete_func);
} else {
    console.log("old_delete_func not found");
}

// 3. Update existing share listeners to use window.tripIdToShare
const old_share_listener = `        document.getElementById('btn-open-share-modal')?.addEventListener('click', () => {
            if (!currentUser) {
                document.getElementById('login-required-modal').classList.remove('hidden');
                return;
            }
            if (!activeTripId) return;
            document.getElementById('trip-share-modal')?.classList.remove('hidden');
        });

        document.getElementById('btn-confirm-share-trip')?.addEventListener('click', async () => {
            if (!currentUser || !activeTripId) return;
            
            const shareUrl = \`\${window.location.origin}\${window.location.pathname}?shareTripId=\${activeTripId}&ownerUid=\${currentUser.uid}\`;`;

const new_share_listener = `        document.getElementById('btn-open-share-modal')?.addEventListener('click', () => {
            if (!currentUser) {
                document.getElementById('login-required-modal').classList.remove('hidden');
                return;
            }
            if (!activeTripId) return;
            window.tripIdToShare = activeTripId;
            document.getElementById('trip-share-modal')?.classList.remove('hidden');
        });

        document.getElementById('btn-confirm-share-trip')?.addEventListener('click', async () => {
            const targetTripId = window.tripIdToShare || activeTripId;
            if (!currentUser || !targetTripId) return;
            
            const shareUrl = \`\${window.location.origin}\${window.location.pathname}?shareTripId=\${targetTripId}&ownerUid=\${currentUser.uid}\`;`;

if (js.includes(old_share_listener)) {
    js = js.replace(old_share_listener, new_share_listener);
} else {
    console.log("old_share_listener not found");
}

js = js.replace(/\n/g, '\r\n');
fs.writeFileSync('main.js', js, 'utf8');
console.log('main.js patched.');
