const fs = require('fs');

// === Fix index.html ===
let html = fs.readFileSync('index.html', 'utf8');

// 1. Restructure itinerary-view: add fixed bottom bar
const oldItineraryView = html.match(/<!-- Itinerary Container \(일정 뷰\) -->[\s\S]*?<div id="itinerary-view"[\s\S]*?<\/div>\s*<\/div>/);
if (oldItineraryView) {
    html = html.replace(oldItineraryView[0], `<!-- Itinerary Container (일정 뷰) -->
    <div id="itinerary-view" class="hidden flex-1 w-full bg-gray-100 z-20 flex-col overflow-hidden h-full">
        <div class="w-full max-w-lg mx-auto h-full flex flex-col">
            <div class="flex-1 overflow-y-auto py-6 px-4 no-scrollbar" id="itinerary-container">
                <!-- 일정 UI 동적 삽입 영역 -->
            </div>
            <div id="itinerary-bottom-bar" class="hidden px-4 pb-4 pt-2 shrink-0">
                <button type="button" id="btn-open-create-trip-modal-fixed" class="w-full py-3 bg-gray-800 hover:bg-gray-900 text-white text-sm font-bold rounded-xl shadow-sm cursor-pointer transition-colors flex items-center justify-center gap-2">
                    ➕ 새 여행 만들기
                </button>
            </div>
        </div>
    </div>`);
}

// 2. Make date required (remove 선택 label) and remove days selector from modal
html = html.replace('여행 날짜 <span class="text-gray-400 font-normal">(선택)</span>', '여행 날짜');

// Remove the days selector div from the create modal
const daysRegex = /\s*<div>\s*<label class="block text-xs font-semibold text-gray-600 mb-1">며칠 동안 가시나요\?<\/label>[\s\S]*?<\/div>\s*<\/div>/;
html = html.replace(daysRegex, '');

fs.writeFileSync('index.html', html);
console.log('index.html updated');

// === Fix main.js ===
let js = fs.readFileSync('main.js', 'utf8');

// 1. Update trip creation to not use days input, start with 1 day
js = js.replace(
    `            const days = parseInt(daysInput.value, 10);

            const newTrip = {
                id: 'trip-' + Date.now(),
                name: name,
                date: tripDate,
                totalDays: days,
                days: Array.from({length: days}, () => ({ items: [] }))
            };`,
    `            if (!startDate || !endDate) {
                alert('여행 날짜를 선택해주세요!');
                return;
            }

            const newTrip = {
                id: 'trip-' + Date.now(),
                name: name,
                date: tripDate,
                totalDays: 1,
                days: [{ items: [] }]
            };`
);

// Remove daysInput reference
js = js.replace("            const daysInput = document.getElementById('modal-new-trip-days');\n", '');

// 2. Remove the inline button from rebuildItineraryUI and use the fixed bottom bar instead
js = js.replace(
    `                // 여행 추가 버튼 (하단 고정)
                html += \`
                    <div class="sticky bottom-0 pt-3 pb-2 px-1 bg-gradient-to-t from-gray-50 via-gray-50 to-transparent">
                        <button type="button" id="btn-open-create-trip-modal" class="w-full py-3 bg-gray-800 hover:bg-gray-900 text-white text-sm font-bold rounded-xl shadow-sm cursor-pointer transition-colors flex items-center justify-center gap-2">
                            ➕ 새 여행 만들기
                        </button>
                    </div>
                \`;

                container.innerHTML = html;

                document.getElementById('btn-open-create-trip-modal')?.addEventListener('click', () => {
                    // 모달 입력값 초기화
                    document.getElementById('modal-new-trip-name').value = '';
                    document.getElementById('modal-new-trip-date-start').value = '';
                    document.getElementById('modal-new-trip-date-end').value = '';
                    document.getElementById('modal-new-trip-days').value = '2';
                    document.getElementById('trip-create-modal').classList.remove('hidden');
                });`,
    `                container.innerHTML = html;

                // 하단 고정 버튼 표시
                const bottomBar = document.getElementById('itinerary-bottom-bar');
                if (bottomBar) bottomBar.classList.remove('hidden');`
);

// 3. Change "총 N일 일정" to use trip.days.length instead of trip.totalDays
js = js.replace(
    "총 ${trip.totalDays}일 일정",
    "총 ${trip.days.length}일 일정"
);

// 4. Hide bottom bar when entering trip detail view
js = js.replace(
    `            // 2. 특정 여행이 선택된 상태 (여행 상세 뷰)`,
    `            // 하단 버튼 숨기기 (상세뷰에서는 불필요)
            const bottomBar2 = document.getElementById('itinerary-bottom-bar');
            if (bottomBar2) bottomBar2.classList.add('hidden');

            // 2. 특정 여행이 선택된 상태 (여행 상세 뷰)`
);

fs.writeFileSync('main.js', js);
console.log('main.js updated');
