import os

html_path = 'index.html'
with open(html_path, 'r', encoding='utf-8') as f:
    html = f.read()

# 1. Add search input
old_list_container = '''    <!-- List Container -->
    <div id="list-view" class="hidden flex-1 w-full bg-transparent z-20 flex-col overflow-hidden h-full">
        <div class="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 h-full flex flex-col min-h-0">
            <div class="bg-white shadow ring-1 ring-black ring-opacity-5 sm:rounded-lg flex-1 overflow-y-auto relative">'''

new_list_container = '''    <!-- List Container -->
    <div id="list-view" class="hidden flex-1 w-full bg-transparent z-20 flex-col overflow-hidden h-full">
        <div class="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 h-full flex flex-col min-h-0 gap-4">
            
            <!-- 리스트 검색 영역 -->
            <div class="relative w-full max-w-md shrink-0">
                <input type="text" id="list-search-input" placeholder="장소명 또는 주소 검색..." class="w-full bg-white border border-gray-300 rounded-lg pl-10 pr-4 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none shadow-sm transition-shadow">
                <span class="absolute left-3 top-2.5 text-gray-400 text-sm">🔍</span>
            </div>

            <div class="bg-white shadow ring-1 ring-black ring-opacity-5 sm:rounded-lg flex-1 overflow-y-auto relative">'''

html = html.replace(old_list_container, new_list_container)

# 2. Add login modal
old_modal_comment = '''    <!-- 새 여행 만들기 모달 -->'''
new_modal_comment = '''    <!-- 로그인 필요 커스텀 모달 -->
    <div id="login-required-modal" class="fixed inset-0 z-[2000] hidden bg-black bg-opacity-50 flex items-center justify-center">
        <div class="bg-white rounded-xl shadow-xl p-6 w-full max-w-sm mx-4 text-center">
            <div class="text-4xl mb-4">🔒</div>
            <h2 class="text-lg font-bold mb-2 text-gray-800">로그인이 필요합니다</h2>
            <p class="text-sm text-gray-600 mb-6">나만의 여행 일정을 만들고 관리하려면<br>먼저 로그인을 진행해 주세요!</p>
            <div class="flex justify-center gap-2">
                <button type="button" onclick="document.getElementById('login-required-modal').classList.add('hidden')" class="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors w-1/3 cursor-pointer">닫기</button>
                <button type="button" onclick="document.getElementById('login-required-modal').classList.add('hidden'); document.getElementById('btn-login').click();" class="px-4 py-2 text-sm font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors w-2/3 cursor-pointer">구글 로그인</button>
            </div>
        </div>
    </div>

    <!-- 새 여행 만들기 모달 -->'''

html = html.replace(old_modal_comment, new_modal_comment, 1)

with open(html_path, 'w', encoding='utf-8') as f:
    f.write(html)


js_path = 'main.js'
with open(js_path, 'r', encoding='utf-8') as f:
    js = f.read()

# 3. Add listSearchQuery state and event listener
js_insert_search_state = "let isFavoriteFilterActive = false;"
js_search_state_replacement = '''let isFavoriteFilterActive = false;
        let listSearchQuery = '';

        document.getElementById('list-search-input')?.addEventListener('input', (e) => {
            listSearchQuery = e.target.value.trim().toLowerCase();
            renderList();
        });'''
js = js.replace(js_insert_search_state, js_search_state_replacement)

# 4. Modify renderList to use the query
old_render_list = '''            // 1. 활성화된 필터 타입과 즐겨찾기 여부를 동시에 필터링
            let filteredLocations = allLocations.filter(loc => {
                const typeMatch = activeTypes.includes(loc.type);
                const favMatch = isFavoriteFilterActive ? favorites.includes(loc.name) : true;
                return typeMatch && favMatch;
            });'''

new_render_list = '''            // 1. 활성화된 필터 타입, 즐겨찾기, 그리고 검색어를 동시에 필터링
            let filteredLocations = allLocations.filter(loc => {
                const typeMatch = activeTypes.includes(loc.type);
                const favMatch = isFavoriteFilterActive ? favorites.includes(loc.name) : true;
                const searchMatch = listSearchQuery === '' || loc.name.toLowerCase().includes(listSearchQuery) || (loc.address && loc.address.toLowerCase().includes(listSearchQuery));
                return typeMatch && favMatch && searchMatch;
            });'''
js = js.replace(old_render_list, new_render_list)

# 5. Fix the login alert issue
old_alert_handler = '''        document.getElementById('btn-open-create-trip-modal-fixed')?.addEventListener('click', () => {
            if (!currentUser) {
                alert('로그인이 필요한 기능입니다.');
                return;
            }'''

new_alert_handler = '''        document.getElementById('btn-open-create-trip-modal-fixed')?.addEventListener('click', () => {
            if (!currentUser) {
                document.getElementById('login-required-modal').classList.remove('hidden');
                return;
            }'''
js = js.replace(old_alert_handler, new_alert_handler)

with open(js_path, 'w', encoding='utf-8') as f:
    f.write(js)

print("Patch applied successfully.")
