import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getFirestore, doc, onSnapshot, setDoc, getDoc, collection, query, orderBy, deleteDoc, updateDoc, arrayUnion, where, getDocs } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js";
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";

// Firebase 웹 설정 (클라이언트용 공개 설정 - 보안은 Firestore Rules가 담당)
const firebaseConfig = {
    apiKey: "AIzaSyDVdpX3rKwN5aR7a7lyA2C1b2d5lRRZWKI",
    authDomain: "subak-map.firebaseapp.com",
    projectId: "subak-map",
    storageBucket: "subak-map.firebasestorage.app",
    messagingSenderId: "368910159844",
    appId: "1:368910159844:web:148b22d919b29048af81f1"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const provider = new GoogleAuthProvider();

let currentUser = null;
const MASTER_HASH = '3bda033cecd838fa5de1d537b301b631f129d6223299a1417a5a3f517387c6bd';
let isMasterUser = false;

const escapeHTML = (str) => {
    return str ? String(str).replace(/[&<>'"]/g, tag => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;'
    }[tag])) : '';
};

// --- 클라우드 실시간 동기화 데이터 ---
let favorites = [];
let customLocations = [];
let trips = [];
let activeTripId = null;
let isFirstLoad = true;

let unsubscribeGlobal = null;
let unsubscribeUserGlobal = null;
let unsubscribeTrips = null;
let unsubscribeShared = null;
let ownedTrips = [];
let sharedTrips = [];
let unsubscribeSharedTripsMap = {};

const globalDocRef = doc(db, "gyeongju", "globalData");

// 인증 상태 관리 및 로그인 UI 업데이트
const updateUserUI = (user) => {
    const btnLogin = document.getElementById('btn-login');
    const userProfile = document.getElementById('user-profile');
    const userAvatar = document.getElementById('user-avatar');
    const userName = document.getElementById('user-name');
    
    if (user) {
        btnLogin.classList.add('hidden');
        userProfile.classList.remove('hidden');
        userProfile.classList.add('flex');
        userAvatar.src = user.photoURL || '';
        userName.textContent = user.displayName || '사용자';
    } else {
        btnLogin.classList.remove('hidden');
        userProfile.classList.add('hidden');
        userProfile.classList.remove('flex');
    }
};

const saveCustomLocations = async () => {
    try {
        await setDoc(globalDocRef, { customLocations }, { merge: true });
    } catch(e) { console.error("커스텀 위치 저장 실패", e); }
};

const saveFavorites = async () => {
    if (!currentUser) return;
    try {
        const userGlobalRef = doc(db, "users", currentUser.uid, "data", "globalData");
        await setDoc(userGlobalRef, { favorites }, { merge: true });
    } catch(e) { console.error("즐겨찾기 저장 실패", e); }
};

const saveSingleTrip = async (trip) => {
    if (!currentUser || window.isSharedView) return;
    trip.createdAt = trip.createdAt || Date.now();
    try {
        const targetUid = trip.isShared && trip.ownerUid ? trip.ownerUid : currentUser.uid;
        const tripRef = doc(db, "users", targetUid, "trips", trip.id);
        
        const dataToSave = { ...trip };
        delete dataToSave.isShared;
        delete dataToSave.ownerUid;
        
        await setDoc(tripRef, dataToSave, { merge: true });
    } catch(e) { console.error("여행 저장 실패", e); }
};

const saveTrips = () => {
    trips.forEach(t => saveSingleTrip(t));
};

const removeTrip = async (tripId) => {
    if (!currentUser || window.isSharedView) return;
    try {
        const tripRef = doc(db, "users", currentUser.uid, "trips", tripId);
        await deleteDoc(tripRef);
    } catch(e) { console.error("여행 삭제 실패", e); }
};

const migrateExistingData = async (uid) => {
    const oldSnap = await getDoc(globalDocRef);
    const userRef = doc(db, "users", uid, "data", "globalData");
    const userSnap = await getDoc(userRef);
    
    // 이전에 저장된 구버전 데이터(favorites, trips)가 있다면 마이그레이션
    if (oldSnap.exists() && !userSnap.exists()) {
        const oldData = oldSnap.data();
        await setDoc(userRef, { favorites: oldData.favorites || [] });
        
        if (oldData.trips && oldData.trips.length > 0) {
            for (const t of oldData.trips) {
                t.createdAt = t.createdAt || Date.now();
                await setDoc(doc(db, "users", uid, "trips", t.id), t);
            }
        } else if (oldData.itinerary && oldData.itinerary.totalDays > 0) {
            let migratedDays = oldData.itinerary.days || [];
            if (migratedDays.length > 0 && Array.isArray(migratedDays[0])) {
                migratedDays = migratedDays.map(arr => ({ items: arr || [] }));
            }
            const t = {
                id: 'trip-' + Date.now(),
                name: '내 첫 번째 여행',
                totalDays: oldData.itinerary.totalDays,
                days: migratedDays,
                createdAt: Date.now()
            };
            await setDoc(doc(db, "users", uid, "trips", t.id), t);
        }
        console.log("✅ 기존 데이터 이전 완료!");
    }
};

const loadGlobalData = () => {
    if (unsubscribeGlobal) unsubscribeGlobal();
    unsubscribeGlobal = onSnapshot(globalDocRef, async (docSnap) => {
        if (!docSnap.exists() && isFirstLoad) {
            // 구버전 로컬스토리지 마이그레이션 (customLocations만)
            const oldCustoms = JSON.parse(localStorage.getItem('gyeongju_custom_locations')) || [];
            if (oldCustoms.length > 0) {
                customLocations = oldCustoms;
                await saveCustomLocations();
            }
        } else if (docSnap.exists()) {
            customLocations = docSnap.data().customLocations || [];
        }
        rebuildMarkers();
        if (isFirstLoad) { isFirstLoad = false; }
    });
};

const loadUserData = (uid) => {
    if (unsubscribeUserGlobal) unsubscribeUserGlobal();
    if (unsubscribeTrips) unsubscribeTrips();

    const userGlobalRef = doc(db, "users", uid, "data", "globalData");
    const tripsColRef = collection(db, "users", uid, "trips");

    unsubscribeUserGlobal = onSnapshot(userGlobalRef, (docSnap) => {
        favorites = docSnap.exists() ? (docSnap.data().favorites || []) : [];
        rebuildMarkers();
        renderList();
    });

    unsubscribeTrips = onSnapshot(tripsColRef, (querySnapshot) => {
        if (window.isSharedView) return; // 공유 뷰에서는 내 일정을 로드하지 않음
        const newTrips = [];
        querySnapshot.forEach((doc) => newTrips.push(doc.data()));
        trips = newTrips.sort((a, b) => b.createdAt - a.createdAt);
        if(window.rebuildItineraryUI) rebuildItineraryUI();
        rebuildMarkers();
    });
};

const loadSharedTrip = async (shareTripId, ownerUid) => {
    const tripRef = doc(db, "users", ownerUid, "trips", shareTripId);
    try {
        const tripSnap = await getDoc(tripRef);
        if (!tripSnap.exists()) {
            alert("유효하지 않거나 접근 권한이 없는 일정입니다.");
            window.location.href = window.location.pathname;
            return;
        }

        window.isSharedView = true;
        alert("초대된 여행 일정을 실시간으로 보고 있습니다 👀 (읽기 전용)");

        if (unsubscribeShared) unsubscribeShared();
        unsubscribeShared = onSnapshot(tripRef, (docSnap) => {
            if (docSnap.exists()) {
                const sharedTripData = docSnap.data();
                trips = [sharedTripData];
                activeTripId = sharedTripData.id;
                if(window.rebuildItineraryUI) rebuildItineraryUI();
                rebuildMarkers();
            }
        });
    } catch (e) {
        console.error(e);
        alert("일정을 불러오지 못했습니다. 로그인 계정을 확인해주세요.");
    }
};

const setupAuth = () => {
    const urlParams = new URLSearchParams(window.location.search);
    const shareTripId = urlParams.get('shareTripId');
    const ownerUid = urlParams.get('ownerUid');

    document.getElementById('btn-login').addEventListener('click', () => {
        signInWithPopup(auth, provider).catch(err => console.error("Login failed", err));
    });

    document.getElementById('btn-logout').addEventListener('click', () => {
        signOut(auth).then(() => { window.location.href = window.location.pathname; });
    });

    onAuthStateChanged(auth, async (user) => {
        currentUser = user;

        if (user && user.email) {
            const msgBuffer = new TextEncoder().encode(user.email);
            window.crypto.subtle.digest('SHA-256', msgBuffer).then(hashBuffer => {
                const hashArray = Array.from(new Uint8Array(hashBuffer));
                const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
                isMasterUser = (hashHex === MASTER_HASH);
                updateUserUI(user);
                rebuildMarkers();
            });
        } else {
            isMasterUser = false;
            updateUserUI(user);
        }

        // 공용 데이터는 무조건 로드
        loadGlobalData();

        if (user) {
            await migrateExistingData(user.uid);
            loadUserData(user.uid);
            
            if (shareTripId && ownerUid) {
                await loadSharedTrip(shareTripId, ownerUid);
            }
        } else {
            isMasterUser = false;
            favorites = [];
            if (!shareTripId) {
                trips = [];
            } else {
                alert("공유된 일정을 보려면 먼저 로그인해주세요!");
            }
            if (unsubscribeUserGlobal) unsubscribeUserGlobal();
            if (unsubscribeTrips) unsubscribeTrips();
            rebuildMarkers();
            renderList();
            if(window.rebuildItineraryUI) rebuildItineraryUI();
        }
    });
};

// Start Auth
setupAuth();

// 경주 중심 좌표 (대릉원 인근)
        const gyeongjuCenter = [35.8383, 129.2116];
        
        // 지도 초기화
        const map = L.map('map').setView(gyeongjuCenter, 13);

        // OpenStreetMap 타일 레이어 추가
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        }).addTo(map);

        // 마커 색상 정의 (SVG 아이콘 활용)
        const createIcon = (color) => {
            return L.divIcon({
                className: 'custom-icon',
                html: `<svg width="30" height="42" viewBox="0 0 30 42" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M15 0C6.71573 0 0 6.71573 0 15C0 26.25 15 42 15 42C15 42 30 26.25 30 15C30 6.71573 23.2843 0 15 0Z" fill="${color}"/>
                        <circle cx="15" cy="15" r="7" fill="white"/>
                       </svg>`,
                iconSize: [30, 42],
                iconAnchor: [15, 42],
                popupAnchor: [0, -40]
            });
        };

        const icons = {
            tour: createIcon('#3B82F6'), // Blue
            food: createIcon('#EF4444'), // Red
            cafe: createIcon('#10B981'),  // Green
            transport: createIcon('#A855F7'), // Purple
            shop: createIcon('#F97316'), // Orange
            stay: createIcon('#06B6D4')  // Cyan
        };

        // 장소 데이터 리스트
        
const INITIAL_BASE_LOCATIONS = [
    // --- 경주 데이터 ---
    { city: 'gyeongju', name: "경주역", searchName: "경주역 KTX", lat: 35.7976, lng: 129.1398, type: "transport", desc: "경주의 주요 관문. (구 신경주역)", address: "경북 경주시 건천읍 신경주역로 80", hours: "상시", closed: "연중무휴" },
    { city: 'gyeongju', name: "불국사", searchName: "불국사", lat: 35.7899, lng: 129.3318, type: "tour", desc: "유네스코 세계문화유산. 필수 코스.", address: "경북 경주시 불국로 385", hours: "07:30 - 17:30", closed: "연중무휴" },
    { city: 'gyeongju', name: "석굴암", searchName: "석굴암", lat: 35.7949, lng: 129.3492, type: "tour", desc: "신라 불교 미술의 정수.", address: "경북 경주시 불국로 873-243", hours: "09:00 - 17:30", closed: "연중무휴" },
    { city: 'gyeongju', name: "대릉원", searchName: "대릉원", lat: 35.8383, lng: 129.2116, type: "tour", desc: "도심 속 거대한 고분군.", address: "경북 경주시 황남동 31-1", hours: "09:00 - 22:00", closed: "연중무휴" },
    { city: 'gyeongju', name: "동궁과 월지", searchName: "동궁과 월지", lat: 35.8347, lng: 129.2266, type: "tour", desc: "경주 최고의 야경 명소.", address: "경북 경주시 원화로 102", hours: "09:00 - 22:00", closed: "연중무휴" },
    { city: 'gyeongju', name: "황리단길", searchName: "황리단길", lat: 35.8377, lng: 129.2096, type: "tour", desc: "한옥 감성 거리.", address: "경북 경주시 포석로 1080 일대", hours: "상시 개방", closed: "매장별 상이" },
    { city: 'gyeongju', name: "경주월드", searchName: "경주월드", lat: 35.8364, lng: 129.2821, type: "tour", desc: "스릴 넘치는 테마파크.", address: "경북 경주시 보문로 544", hours: "10:00 - 18:00", closed: "연중무휴" },
    { city: 'gyeongju', name: "경주엑스포대공원", searchName: "경주엑스포대공원", lat: 35.8285, lng: 129.2806, type: "tour", desc: "경주타워, 솔거미술관 등 다양한 볼거리가 가득한 문화 테마파크.", address: "경북 경주시 경감로 614", hours: "10:00 - 18:00", closed: "연중무휴" },
    { city: 'gyeongju', name: "옥산서원", searchName: "옥산서원", lat: 35.9961, lng: 129.1633, type: "tour", desc: "유네스코 세계문화유산.", address: "경북 경주시 안강읍 옥산서원길 216-27", hours: "09:00 - 18:00", closed: "연중무휴" },
    { city: 'gyeongju', name: "오릉", searchName: "경주 오릉", lat: 35.8227, lng: 129.2104, type: "tour", desc: "신라 초기 왕들의 무덤. 평화로운 산책로와 대나무숲이 아름다운 곳.", address: "경북 경주시 탑동 67", hours: "09:00 - 18:00", closed: "연중무휴" },
    { city: 'gyeongju', name: "향화정", searchName: "경주 향화정", lat: 35.8375, lng: 129.2087, type: "food", desc: "황리단길 인기 맛집.", address: "경북 경주시 사정로57번길 17", hours: "11:00 - 21:00", closed: "연중무휴" },
    { city: 'gyeongju', name: "가마솥족발", searchName: "경주 가마솥족발", lat: 35.8427, lng: 129.2081, type: "food", desc: "현지인 추천 족발 맛집.", address: "경북 경주시 노서동 54-4", hours: "11:30 - 21:30", closed: "매주 화요일" },
    { city: 'gyeongju', name: "영양숯불갈비", searchName: "경주 영양숯불갈비", lat: 35.8415, lng: 129.2091, type: "food", desc: "50년 전통의 한우 숯불갈비.", address: "경북 경주시 봉황로 79", hours: "10:30 - 21:00", closed: "연중무휴" },
    { city: 'gyeongju', name: "함양집 황리단점", searchName: "경주 함양집 황남점", lat: 35.8358, lng: 129.2095, type: "food", desc: "전통 육회물회 맛집.", address: "경북 경주시 포석로1050번길 39", hours: "10:30 - 20:00", closed: "매주 수,목" },
    { city: 'gyeongju', name: "대화만두 본점", searchName: "경주 대화만두 본점", lat: 35.8421, lng: 129.2117, type: "food", desc: "1988년부터 이어온 쫄면과 만두가 맛있는 경주 로컬 맛집.", address: "경북 경주시 계림로 93", hours: "11:30 - 20:30", closed: "매주 월요일" },
    { city: 'gyeongju', name: "시골밥상", searchName: "경주 안강 시골밥상", lat: 35.9950, lng: 129.1640, type: "food", desc: "⭐ 평점 4.2 | 옥산서원 산책 전후 들르기 좋은 소박하고 든든한 시골풍 백반집.", address: "경북 경주시 안강읍 옥산서원길", hours: "10:00 - 21:00", closed: "매일 운영" },
    { city: 'gyeongju', name: "통나무집식당", searchName: "경주 안강 통나무집식당", lat: 35.9955, lng: 129.1635, type: "food", desc: "⭐ 평점 4.2 | 편안하고 정겨운 분위기에서 든든하게 식사하기 좋은 로컬 식당.", address: "경북 경주시 안강읍 옥산서원길", hours: "11:00 - 21:00", closed: "매일 운영" },
    { city: 'gyeongju', name: "산장식당", searchName: "경주 안강 산장식당", lat: 35.9970, lng: 129.1620, type: "food", desc: "⭐ 평점 4.1 | 복잡하지 않고 조용한 분위기 속에서 여유롭게 식사를 원할 때 추천.", address: "경북 경주시 안강읍 옥산서원길", hours: "09:00 - 21:00", closed: "매일 운영" },
    { city: 'gyeongju', name: "대구회식당", searchName: "경주 문무대왕면 대구회식당", lat: 35.7380, lng: 129.4800, type: "food", desc: "⭐ 평점 4.7 | 문무대왕릉 앞 해안길 위치. 평점이 독보적으로 높은 신선한 횟집.", address: "경북 경주시 문무대왕면 봉길해안길", hours: "11:00 - 21:00", closed: "매일 운영" },
    { city: 'gyeongju', name: "감포횟집", searchName: "경주 감포횟집", lat: 35.7950, lng: 129.5050, type: "food", desc: "⭐ 평점 4.2 | 시원한 바다 풍경과 함께 해산물 요리와 회를 전문으로 즐길 수 있는 곳.", address: "경북 경주시 감포읍 대본리", hours: "09:00 - 20:00", closed: "매일 운영" },
    { city: 'gyeongju', name: "삼거리식당", searchName: "경주 문무대왕면 삼거리식당", lat: 35.7375, lng: 129.4795, type: "food", desc: "⭐ 평점 4.3 | 해산물 외에 깔끔한 정식이나 든든한 식사를 원할 때 방문하기 좋은 식당.", address: "경북 경주시 문무대왕면 봉길리", hours: "09:30 - 20:00", closed: "매일 운영" },
    { city: 'gyeongju', name: "진양닭집", searchName: "경주 진양닭집", lat: 35.8643, lng: 129.2132, type: "food", desc: "40년 전통의 경주 현지인 치킨/닭강정 맛집.", address: "경북 경주시 용담로116번길 41-17", hours: "11:00 - 23:00", closed: "매일 운영" },
    { city: 'gyeongju', name: "충효닭집", searchName: "경주 충효닭집", lat: 35.8431, lng: 129.2045, type: "food", desc: "중앙시장 내 위치한 경주 3대 통닭 맛집.", address: "경북 경주시 금성로 295 중앙시장", hours: "09:30 - 20:00", closed: "1, 15일 휴무" },
    { city: 'gyeongju', name: "대남통닭", searchName: "경주 대남통닭", lat: 35.8462, lng: 129.2031, type: "food", desc: "중앙시장 부근의 양 많고 맛있는 로컬 닭강정 맛집.", address: "경북 경주시 성건동 339-2", hours: "09:00 - 21:00", closed: "매일 운영" },
    { city: 'gyeongju', name: "현대밀면", searchName: "경주 현대밀면", lat: 35.8445, lng: 129.2065, type: "food", desc: "오랜 전통을 자랑하는 경주 노포 밀면 맛집.", address: "경북 경주시 화랑로 61", hours: "11:00 - 18:00", closed: "매일 운영" },
    { city: 'gyeongju', name: "도미", searchName: "경주 도미", lat: 35.8423, lng: 129.2111, type: "food", desc: "루프탑에서 즐기는 화덕피자와 시원한 맥주 펍.", address: "경북 경주시 중앙로 10", hours: "11:30 - 21:00", closed: "매주 화요일" },
    { city: 'gyeongju', name: "족발공장", searchName: "경주 족발공장", lat: 35.8458, lng: 129.2141, type: "food", desc: "부드럽고 쫄깃한 식감이 일품인 경주 현지인 족발 맛집.", address: "경북 경주시 동문로 38", hours: "16:00 - 24:00", closed: "매주 일요일" },
    { city: 'gyeongju', name: "짱궤", searchName: "경주 짱궤", lat: 35.8492, lng: 129.2165, type: "food", desc: "오래된 현지인 중식 맛집.", address: "경북 경주시 원화로281번길 11", hours: "11:00 - 20:00", closed: "매주 월요일" },
    { city: 'gyeongju', name: "류대협명인곰탕", searchName: "경주 류대협명인곰탕", lat: 35.8312, lng: 129.2221, type: "food", desc: "진하고 깊은 국물 맛을 자랑하는 곰탕 전문점.", address: "경북 경주시 원화로", hours: "09:00 - 20:00", closed: "연중무휴" },
    { city: 'gyeongju', name: "용산회식당", searchName: "경주 용산회식당", lat: 35.7874, lng: 129.2082, type: "food", desc: "가성비 최고! 신선한 회덮밥 단일 메뉴로 줄 서서 먹는 내남면 식당.", address: "경북 경주시 내남면 포석로 112", hours: "08:30 - 14:00", closed: "매주 월요일" },
    { city: 'gyeongju', name: "경주신라반상 수리뫼", searchName: "경주 수리뫼", lat: 35.7871, lng: 129.2075, type: "food", desc: "품격 있는 전통 한정식을 맛볼 수 있는 곳.", address: "경북 경주시 내남면 포석로 110-32", hours: "11:30 - 20:00", closed: "매주 화요일" },
    { city: 'gyeongju', name: "내남식육식당", searchName: "경주 내남식육식당", lat: 35.7725, lng: 129.1983, type: "food", desc: "질 좋은 고기를 합리적인 가격에 즐길 수 있는 현지인 고깃집.", address: "경북 경주시 내남면 이조3길 6", hours: "11:00 - 21:00", closed: "매주 월요일" },
    { city: 'gyeongju', name: "노워즈", searchName: "경주 노워즈", lat: 35.8379, lng: 129.2099, type: "cafe", desc: "엑설런트 라떼 유명 카페.", address: "경북 경주시 태종로 744", hours: "12:00 - 18:00", closed: "연중무휴" },
    { city: 'gyeongju', name: "스컹크웍스", searchName: "경주 스컹크웍스", lat: 35.8371, lng: 129.2083, type: "cafe", desc: "대형 한옥 카페.", address: "경북 경주시 포석로 1058-3", hours: "10:00 - 22:00", closed: "연중무휴" },
    { city: 'gyeongju', name: "향미사", searchName: "경주 향미사", lat: 35.8412, lng: 129.2110, type: "cafe", desc: "스페셜티 커피 추천.", address: "경북 경주시 태종로 734", hours: "11:00 - 18:00", closed: "연중무휴" },
    { city: 'gyeongju', name: "올리브", searchName: "경주 올리브 베이커리", lat: 35.8368, lng: 129.2089, type: "cafe", desc: "화이트 톤 예쁜 한옥 카페.", address: "경북 경주시 사정로57번길 7-6", hours: "10:00 - 21:00", closed: "연중무휴" },
    { city: 'gyeongju', name: "커피 플레이스", searchName: "경주 커피플레이스", lat: 35.8434, lng: 129.2115, type: "cafe", desc: "로컬 로스터리 커피 맛집.", address: "경북 경주시 중앙로 18", hours: "08:00 - 18:00", closed: "연중무휴" },
    { city: 'gyeongju', name: "앙주", searchName: "경주 앙주", lat: 35.8372, lng: 129.2091, type: "cafe", desc: "과일 타르트 디저트 맛집.", address: "경북 경주시 포석로1068번길 23", hours: "11:00 - 19:00", closed: "매주 월,화" },
    { city: 'gyeongju', name: "이스트1779", searchName: "이스트1779", lat: 35.8306, lng: 129.2166, type: "cafe", desc: "교촌마을 내 붉은 벽돌이 매력적인 감성 카페.", address: "경북 경주시 교촌안길 21", hours: "11:00 - 20:00", closed: "매주 화요일" },
    { city: 'gyeongju', name: "소노캄경주 오롯", searchName: "소노캄경주 오롯", lat: 35.8422, lng: 129.2965, type: "cafe", desc: "소노캄 경주 1층에 위치한 북카페 겸 라운지.", address: "경북 경주시 보문로 402-12 1층", hours: "09:00 - 21:00", closed: "연중무휴" },
    { city: 'gyeongju', name: "스타트커피", searchName: "경주 스타트커피", lat: 35.8115, lng: 129.5070, type: "cafe", desc: "⭐ 평점 4.24 | 바다와 함께하는 여유로운 커피 한잔. 감포 앞바다 오션뷰 카페.", address: "경북 경주시 감포읍 동해안로 1862", hours: "상시 영업 (17:30 라스트오더)", closed: "매일 운영" },
    { city: 'gyeongju', name: "아차차", searchName: "경주 아차차", lat: 35.8395, lng: 129.2098, type: "cafe", desc: "귀여운 비주얼과 달콤한 맛의 황리단길 아이스크림 전문점.", address: "경북 경주시 포석로 1083", hours: "11:00 - 19:00", closed: "매일 운영" },
    { city: 'gyeongju', name: "디저트시네마 경주점", searchName: "디저트시네마 경주점", lat: 35.8381, lng: 129.2085, type: "cafe", desc: "부산에서 건너온 결이 살아있는 페스츄리 맛집.", address: "경북 경주시 사정동", hours: "11:00 - 18:00", closed: "휴무일 인스타 공지" },
    { city: 'gyeongju', name: "경주 아벤타 호텔", searchName: "경주 아벤타호텔", lat: 35.8427, lng: 129.2057, type: "stay", desc: "경주 터미널 근처 가성비 좋고 깔끔한 비즈니스 호텔.", address: "경북 경주시 태종로 685번길 12", hours: "IN 15:00 / OUT 11:00", closed: "연중무휴" },
    { city: 'gyeongju', name: "스테이 화녹", searchName: "경주 스테이 화녹", lat: 35.8374, lng: 129.2088, type: "stay", desc: "황리단길 안쪽, 고즈넉하고 감성적인 프리미엄 한옥 숙소.", address: "경북 경주시 포석로1068번길 17-5", hours: "IN 15:00 / OUT 11:00", closed: "연중무휴" },
    { city: 'gyeongju', name: "월정교", searchName: "월정교", lat: 35.8296, lng: 129.2157, type: "tour", desc: "야경 반영샷 명소.", address: "경북 경주시 교동 274", hours: "09:00 - 22:00", closed: "연중무휴" },
    { city: 'gyeongju', name: "황금십원빵 본점", searchName: "경주 황금십원빵 본점", lat: 35.8377, lng: 129.2093, type: "food", desc: "황리단길 필수 간식.", address: "경북 경주시 포석로 1083", hours: "10:00 - 21:00", closed: "연중무휴" },
    { city: 'gyeongju', name: "카페 솔", searchName: "경주 카페솔", lat: 35.8388, lng: 129.2105, type: "cafe", desc: "연못 포토존 감성 카페.", address: "경북 경주시 포석로1092번길 62-8", hours: "10:30 - 21:00", closed: "연중무휴" },
    { city: 'gyeongju', name: "바실라", searchName: "경주 바실라", lat: 35.7960, lng: 129.3020, type: "cafe", desc: "해바라기/유채꽃 뷰 맛집.", address: "경북 경주시 하동못안길 88", hours: "10:00 - 21:00", closed: "연중무휴" },
    { city: 'gyeongju', name: "문무대왕릉", searchName: "문무대왕릉", lat: 35.7393, lng: 129.4803, type: "tour", desc: "신라 문무왕 수중릉.", address: "경북 경주시 문무대왕면 봉길리 30-1", hours: "상시 개방", closed: "연중무휴" },
    { city: 'gyeongju', name: "경북천년숲정원", searchName: "경북천년숲정원", lat: 35.8035, lng: 129.2482, type: "tour", desc: "외나무다리 포토존이 있는 힐링 산책 명소 (구. 경북산림환경연구원).", address: "경북 경주시 통일로 366-4", hours: "10:00 - 17:00", closed: "매일 운영" },
    { city: 'gyeongju', name: "어서어서", searchName: "경주 어서어서", lat: 35.8385, lng: 129.2097, type: "shop", desc: "약봉투 책 포장 독립 서점.", address: "경북 경주시 포석로 1083", hours: "11:00 - 19:30", closed: "연중무휴" },
    { city: 'gyeongju', name: "소소밀밀", searchName: "경주 소소밀밀", lat: 35.8378, lng: 129.2091, type: "shop", desc: "감성 그림책방.", address: "경북 경주시 포석로 1097", hours: "11:00 - 19:00", closed: "매주 화요일" },
    { city: 'gyeongju', name: "오홀리데이", searchName: "경주 오홀리데이", lat: 35.8381, lng: 129.2094, type: "shop", desc: "아기자기 소품 편집샵.", address: "경북 경주시 포석로 1089-14", hours: "11:00 - 20:00", closed: "연중무휴" },
    { city: 'gyeongju', name: "디스모먼트", searchName: "경주 디스모먼트", lat: 35.8380, lng: 129.2100, type: "shop", desc: "경주 자체 제작 기념품샵.", address: "경북 경주시 사정로 50-1", hours: "11:00 - 19:00", closed: "매주 목요일" },
    { city: 'gyeongju', name: "국립경주박물관 천년서고", searchName: "국립경주박물관 천년서고", lat: 35.8277, lng: 129.2274, type: "shop", desc: "국립경주박물관 내 위치한 감각적인 북라운지.", address: "경북 경주시 일정로 186", hours: "10:00 - 18:00", closed: "1월 1일, 명절 당일" },
    
    // --- 대전 데이터 ---
    { city: 'daejeon', name: "성심당 본점", searchName: "성심당 본점", lat: 36.3277, lng: 127.4273, type: "food", desc: "대전의 상징적인 빵집. 튀김소보로와 부추빵이 유명함.", address: "대전 중구 대종로480번길 15", hours: "08:00 - 22:00", closed: "연중무휴" },
    { city: 'daejeon', name: "엑스포과학공원", searchName: "엑스포과학공원", lat: 36.3768, lng: 127.3887, type: "tour", desc: "한빛탑과 음악분수가 있는 대전의 랜드마크.", address: "대전 유성구 대덕대로 480", hours: "09:30 - 17:30", closed: "매주 월요일" },
    { city: 'daejeon', name: "한밭수목원", searchName: "한밭수목원", lat: 36.3683, lng: 127.3888, type: "tour", desc: "도심 속 거대한 수목원. 피크닉 명소.", address: "대전 서구 둔산대로 169", hours: "06:00 - 21:00", closed: "월요일(동원)/화요일(서원)" },
    { city: 'daejeon', name: "대전 오월드", searchName: "대전 오월드", lat: 36.2891, lng: 127.3986, type: "tour", desc: "동물원, 플라워랜드, 조이랜드가 통합된 종합 테마파크.", address: "대전 중구 사정공원로 70", hours: "09:30 - 18:00", closed: "연중무휴" },
    { city: 'daejeon', name: "태평소국밥 본관", searchName: "태평소국밥", lat: 36.3204, lng: 127.3946, type: "food", desc: "대전 로컬들이 사랑하는 진한 소국밥과 육사시미.", address: "대전 중구 태평로 116", hours: "24시간", closed: "연중무휴" },
    { city: 'daejeon', name: "대전역", searchName: "대전역 KTX", lat: 36.3323, lng: 127.4343, type: "transport", desc: "대전 여행의 시작점. 내부에 성심당 분점 위치.", address: "대전 동구 중앙로 215", hours: "상시", closed: "연중무휴" },
    { city: 'daejeon', name: "신세계 Art & Science", searchName: "대전 신세계백화점", lat: 36.3754, lng: 127.3824, type: "shop", desc: "쇼핑, 전시, 전망대를 한 번에 즐기는 대규모 복합문화공간.", address: "대전 유성구 엑스포로 1", hours: "10:30 - 20:00", closed: "백화점 휴무일" }
];

let baseLocations = [];
let locations = [];


        // 뱃지 색상 및 라벨 매핑 객체
        const badgeColors = {
            tour: 'bg-blue-100 text-blue-800',
            food: 'bg-red-100 text-red-800',
            cafe: 'bg-green-100 text-green-800',
            transport: 'bg-purple-100 text-purple-800',
            shop: 'bg-orange-100 text-orange-800',
            stay: 'bg-cyan-100 text-cyan-800'
        };
        const labels = { tour: '관광지', food: '맛집', cafe: '카페', transport: '교통', shop: '소품/서점', stay: '숙소' };

        // 마커 데이터를 관리할 배열
        const markersData = [];

        // 팝업 HTML 생성 함수 (기존 디자인 복원)
        const getPopupContent = (loc) => {
            const isFav = favorites.includes(loc.name);
            const searchQuery = encodeURIComponent(loc.searchName);
            const naverMapUrl = `https://map.naver.com/p/search/${searchQuery}?c=${loc.lng},${loc.lat},15,0,0,0,dh`;
            const encodedName = encodeURIComponent(loc.name).replace(/'/g, "%27");
            const safeName = escapeHTML(loc.name);
            const safeDesc = escapeHTML(loc.desc || '');

            let deleteBtnHtml = '';
            let actionBtnHtml = '';
            
            if (!loc.isItinerary) {
                deleteBtnHtml = (loc.isCustom && isMasterUser) ? 
                    `<button type="button" onclick="deleteCustomMarker(event, '${encodedName}')" class="w-full mt-1.5 text-xs font-medium text-red-500 hover:text-red-700 bg-red-50 hover:bg-red-100 py-1.5 rounded-lg transition-colors">이 장소 삭제하기 🗑️</button>` : '';
                
                actionBtnHtml = `
                    <div class="mt-3 flex flex-col gap-1.5">
                        <a href="${naverMapUrl}" target="_blank" rel="noopener noreferrer" class="w-full text-center block px-3 py-2 text-sm font-medium text-white bg-[#03C75A] rounded-lg hover:bg-[#02b351] transition-colors shadow-sm">
                            네이버 지도에서 보기 ↗
                        </a>
                        <button type="button" onclick="openItineraryModal(event, '${encodedName}')" class="w-full text-center px-3 py-1.5 text-xs font-bold text-gray-700 border border-gray-300 bg-white rounded-lg hover:bg-gray-50 transition-colors shadow-sm">
                            🗓️ 일정에 추가
                        </button>
                        ${deleteBtnHtml}
                    </div>
                `;
            }

            return `
                <div class="p-1">
                    <div class="flex justify-between items-start mb-1">
                        <span class="inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${badgeColors[loc.type]}">${labels[loc.type]}</span>
                        <button type="button" onclick="toggleFavorite(event, '${encodedName}')" class="text-xl leading-none focus:outline-none transition-colors ${isFav ? 'text-yellow-400 hover:text-yellow-500' : 'text-gray-300 hover:text-yellow-400'}">
                            ${isFav ? '★' : '☆'}
                        </button>
                    </div>
                    <h3 class="font-bold text-gray-900 text-lg leading-tight mb-0.5">${safeName}</h3>
                    <p class="text-[13px] text-gray-600 mb-0 break-keep">${loc.desc || '설명 없음'}</p>
                    <hr class="my-1.5 border-gray-200">
                    <div class="text-[12px] text-gray-500 leading-tight">
                        ${loc.hours && loc.hours !== '-' ? `<p class="mb-0.5">⏰ 정보: ${loc.hours}</p>` : ''}
                        ${loc.closed && loc.closed !== '-' ? `<p class="mb-0">🏠 휴무: ${loc.closed}</p>` : ''}
                    </div>
                    ${actionBtnHtml}
                </div>
            `;
        };

        // 삭제할 마커 이름을 임시 저장할 변수
        let markerToDelete = null;

        // 전역 스코프에 사용자 지정 장소 삭제 함수 노출 (모달 띄우기)
        window.deleteCustomMarker = (e, encodedName) => {
            if (e) {
                e.preventDefault();
                e.stopPropagation(); // 팝업창 뒤의 지도까지 클릭되는 현상 방지
            }
            markerToDelete = decodeURIComponent(encodedName);
            document.getElementById('delete-confirm-modal').classList.remove('hidden');
        };

        // 커스텀 삭제 모달 취소 버튼
        document.getElementById('btn-cancel-delete').addEventListener('click', () => {
            markerToDelete = null;
            document.getElementById('delete-confirm-modal').classList.add('hidden');
        });

        // 커스텀 삭제 모달 확인(삭제) 버튼
        document.getElementById('btn-confirm-delete').addEventListener('click', () => {
            if (!markerToDelete) return;
            const name = markerToDelete;
            
            map.closePopup(); // 팝업 깨짐 및 렌더링 충돌 방지를 위해 먼저 닫기
            
            setTimeout(() => {
                customLocations = customLocations.filter(loc => loc.name !== name);
                saveCustomLocations();
                
                if(favorites.includes(name)) {
                    favorites = favorites.filter(f => f !== name);
                    saveFavorites();
                }
                
                rebuildMarkers();
                
                markerToDelete = null;
                document.getElementById('delete-confirm-modal').classList.add('hidden');
            }, 50);
        });

        // 전역 스코프에 즐겨찾기 토글 함수 노출
                window.toggleFavorite = (e, encodedName) => {
            if (e) {
                e.preventDefault();
                e.stopPropagation();
            }
            if (!currentUser) {
                alert("즐겨찾기는 로그인 후 이용 가능합니다!");
                return;
            }
            const name = decodeURIComponent(encodedName);
            if (favorites.includes(name)) {
                favorites = favorites.filter(f => f !== name);
            } else {
                favorites.push(name);
            }
            saveFavorites();

            // 열려있는 팝업이나 지도 마커 콘텐츠 업데이트
            markersData.forEach(item => {
                if (item.loc.name === name) {
                    item.marker.setPopupContent(getPopupContent(item.loc));
                }
            });

            // 리스트 뷰 즉시 업데이트
            renderList();

            // 즐겨찾기 필터가 켜져있는 상태에서 해제했다면 지도 마커도 즉시 숨김 처리
            if (isFavoriteFilterActive) {
                updateFilters();
            }
        };

        // 마커 전체 초기화/재생성 함수 (기본 데이터 + 커스텀 데이터 지원)
        
        const createNumberedIcon = (number, color = '#3B82F6') => {
            return L.divIcon({
                className: 'custom-numbered-icon',
                html: `<div style="background-color: ${color}; color: white; border-radius: 50%; width: 30px; height: 30px; display: flex; align-items: center; justify-content: center; font-weight: bold; border: 2px solid white; box-shadow: 0 2px 5px rgba(0,0,0,0.3); font-size: 14px;">${number}</div>`,
                iconSize: [30, 30],
                iconAnchor: [15, 15],
                popupAnchor: [0, -15]
            });
        };

        // 일정 경로 폴리라인 관리
        let itineraryPolylines = [];

        const rebuildMarkers = () => {
            markersData.forEach(item => {
                if (map.hasLayer(item.marker)) map.removeLayer(item.marker);
            });
            markersData.length = 0;

            // 기존 폴리라인 제거
            itineraryPolylines.forEach(pl => { if (map.hasLayer(pl)) map.removeLayer(pl); });
            itineraryPolylines = [];

            
            // 일정 맵 뷰 모드 검증
            const isItineraryMap = (activeMainTab === 'btn-itinerary' && itineraryMode === 'view-map');

            const activeTrip = trips.find(t => t.id === activeTripId);

            // Determine current city based on activeTrip
            let currentCity = 'gyeongju'; // default
            if (activeTrip && activeTrip.name.includes('대전')) {
                currentCity = 'daejeon';
            } else if (activeTrip && activeTrip.name.includes('경주')) {
                currentCity = 'gyeongju';
            }
            
            // Map flyTo logic
            if (currentCity === 'daejeon' && isItineraryMap) {
                map.flyTo([36.3277, 127.4273], 12);
            } else if (currentCity === 'gyeongju' && isItineraryMap) {
                map.flyTo([35.8383, 129.2116], 13);
            }

            // Fallback to INITIAL_BASE_LOCATIONS if DB is empty to avoid blank screen
            const activeBaseLocations = (baseLocations.length > 0 ? baseLocations : INITIAL_BASE_LOCATIONS).filter(loc => loc.city === currentCity);
            locations = activeBaseLocations;

            const allLocations = [...activeBaseLocations, ...customLocations];


            if (isItineraryMap && activeTrip && activeTrip.totalDays > 0) {
                // 일정 모드 마커 렌더링 (Day별 순서 번호 적용)
                const dayColors = ['#3B82F6', '#EF4444', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899', '#14B8A6', '#84CC16', '#6366F1', '#A855F7'];

                activeTrip.days.forEach((dayObj, dayIndex) => {
                    let dailyIndex = 1;
                    const dCol = dayColors[dayIndex % dayColors.length];
                    const dayItems = dayObj.items || [];
                    const dayCoords = [];

                    dayItems.forEach((item) => {
                        const loc = allLocations.find(l => l.name === item.name);
                        if (loc) {
                            dayCoords.push([loc.lat, loc.lng]);
                            const marker = L.marker([loc.lat, loc.lng], { icon: createNumberedIcon(dailyIndex, dCol) });
                            marker.bindPopup(getPopupContent({...loc, isItinerary: true}), { 
                                className: 'custom-popup', closeButton: false, minWidth: 260, maxWidth: 260 
                            });
                            markersData.push({ marker: marker, type: loc.type, loc: loc });
                        }
                        dailyIndex++;
                    });

                    // 같은 날 마커들을 점선으로 연결
                    if (dayCoords.length >= 2) {
                        const polyline = L.polyline(dayCoords, {
                            color: dCol,
                            weight: 3,
                            dashArray: '10, 8',
                            opacity: 0.7
                        }).addTo(map);
                        itineraryPolylines.push(polyline);
                    }
                });
            } else {
                // 기본 마커 렌더링
                allLocations.forEach(loc => {
                    const marker = L.marker([loc.lat, loc.lng], { icon: icons[loc.type] });
                    marker.bindPopup(getPopupContent(loc), { 
                        className: 'custom-popup', closeButton: false, minWidth: 260, maxWidth: 260 
                    });
                    markersData.push({ marker: marker, type: loc.type, loc: loc });
                });
            }

            updateFilters();
            if(window.rebuildItineraryUI) window.rebuildItineraryUI();
        };

        // --- 📍 마커 추가 이벤트 로직 ---
        let isAddMode = false;
        let pendingLatLng = null;

        const btnAddMarker = document.getElementById('btn-add-marker');
        const addToast = document.getElementById('add-toast');
        const addModal = document.getElementById('add-modal');
        const addForm = document.getElementById('add-form');
        const btnCancelAdd = document.getElementById('btn-cancel-add');
        const searchInput = document.getElementById('search-query');
        const btnSearchPlace = document.getElementById('btn-search-place');
        const searchResults = document.getElementById('search-results');
        const searchStatus = document.getElementById('search-status');
        const btnMapPick = document.getElementById('btn-map-pick');
        const mapPickStatus = document.getElementById('map-pick-status');
        const addAddressHidden = document.getElementById('add-address');

        // 장소 추가 버튼 클릭 시 바로 모달 띄우기 (흐름 변경)
        btnAddMarker.addEventListener('click', () => {
            addModal.classList.remove('hidden');
            
            // 만약 리스트 화면이라면 지도로 자동 전환시킴 (위치 확인 편의성)
            if(document.getElementById('map').classList.contains('hidden')){
                document.getElementById('btn-map').click();
            }

            // 초기화
            pendingLatLng = null;
            mapPickStatus.classList.remove('hidden');
            mapPickStatus.textContent = "(위치 미지정 - 지도 클릭 또는 검색 필수)";
            mapPickStatus.classList.replace('text-blue-600', 'text-red-500');
            searchInput.value = '';
            searchResults.innerHTML = '';
            searchStatus.classList.add('hidden');
        });

        // 지도에서 직접 선택하기 버튼 (모달 숨기고 맵 클릭 모드 진입)
        btnMapPick.addEventListener('click', () => {
            addModal.classList.add('hidden');
            isAddMode = true;
            addToast.classList.remove('hidden');
            map.getContainer().style.cursor = 'crosshair';
        });

        // 지도 클릭 이벤트 (직접 선택 모드일 때만 동작)
        map.on('click', function(e) {
            if(!isAddMode) return;
            
            pendingLatLng = e.latlng;
            isAddMode = false;
            addToast.classList.add('hidden');
            map.getContainer().style.cursor = '';
            
            // 위치 확정 후 텍스트/스타일 변경 및 폼 다시 띄우기
            mapPickStatus.textContent = "(위치 지정 완료 ✅)";
            mapPickStatus.classList.replace('text-red-500', 'text-blue-600');
            addAddressHidden.value = "지도에서 직접 선택한 위치"; // 주소 임시 저장 기본값
            
            addModal.classList.remove('hidden');
            setTimeout(() => document.getElementById('add-name').focus(), 100);
        });

        // 모달 닫기
        btnCancelAdd.addEventListener('click', () => {
            addModal.classList.add('hidden');
            addForm.reset();
            searchInput.value = '';
            searchResults.innerHTML = '';
            searchStatus.classList.add('hidden');
            pendingLatLng = null;
            
            // 혹시나 지도 픽 모드에서 취소한 경우도 리셋
            isAddMode = false;
            addToast.classList.add('hidden');
            map.getContainer().style.cursor = '';
        });

        // 지도 직접 선택 취소 버튼 (토스트 내장)
        const btnCancelMapPick = document.getElementById('btn-cancel-map-pick');
        if (btnCancelMapPick) {
            btnCancelMapPick.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                // 지도 클릭 모드 취소 후 모달로 원복
                isAddMode = false;
                addToast.classList.add('hidden');
                map.getContainer().style.cursor = '';
                addModal.classList.remove('hidden');
            });
        }

        // 검색 초기화 버튼 로직
        const btnResetSearch = document.getElementById('btn-reset-search');
        if (btnResetSearch) {
            btnResetSearch.addEventListener('click', () => {
                searchInput.value = '';
                searchResults.innerHTML = '';
                searchStatus.classList.add('hidden');
                document.getElementById('add-name').value = '';
                addAddressHidden.value = '직접 추가한 핀 위치';
                pendingLatLng = null;
                
                mapPickStatus.textContent = "(위치 미지정 - 지도 클릭 또는 검색 필수)";
                mapPickStatus.classList.replace('text-blue-600', 'text-red-500');
                mapPickStatus.classList.remove('hidden');
            });
        }

        // 장소 검색 모듈 (OpenStreetMap Nominatim API)
        btnSearchPlace.addEventListener('click', async () => {
            const query = searchInput.value.trim();
            if (!query) return;

            searchStatus.textContent = "검색 중...";
            searchStatus.className = "mt-2 text-xs text-blue-500 font-medium";
            searchResults.innerHTML = '';

            try {
                // 현재 지도가 보고 있는 화면 영역(Bounds) 가져오기
                const bounds = map.getBounds();
                const viewbox = `${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()},${bounds.getSouth()}`;

                // 한국 지역(countrycodes=kr)에서 검색, limit는 5개, 현재 화면 중심(viewbox) 우선 검색(bounded=0)
                const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=jsonv2&addressdetails=1&countrycodes=kr&viewbox=${viewbox}&bounded=0&limit=5`;
                const response = await fetch(url, {
                    headers: { 'Accept-Language': 'ko-KR,ko;q=0.9' }
                });
                const data = await response.json();

                if (data.length === 0) {
                    searchStatus.textContent = "검색 결과가 없습니다. 도로명 주소나 상호명을 다시 확인해주세요.";
                    searchStatus.className = "mt-2 text-xs text-red-500 font-medium";
                } else {
                    searchStatus.classList.add('hidden');
                    data.forEach(item => {
                        const li = document.createElement('li');
                        li.className = "cursor-pointer p-2 hover:bg-gray-100 rounded border border-transparent hover:border-gray-200 transition-colors";
                        
                        // 상호명이 있으면 상호명 우선, 없으면 주소 중 가장 앞부분 사용
                        const displayName = item.name || item.display_name.split(',')[0];
                        const fullAddress = item.display_name;
                        
                        li.innerHTML = `
                            <div class="font-semibold text-gray-800">${displayName}</div>
                            <div class="text-xs text-gray-500 line-clamp-1">${fullAddress}</div>
                        `;
                        
                        li.addEventListener('click', () => {
                            // 항목 클릭 시 데이터 세팅
                            pendingLatLng = L.latLng(parseFloat(item.lat), parseFloat(item.lon));
                            document.getElementById('add-name').value = displayName;
                            addAddressHidden.value = fullAddress; // API에서 가져온 실제 주소 저장
                            
                            // UI 피드백 표시
                            mapPickStatus.textContent = `(검색 위치 선택됨: ${displayName} ✅)`;
                            mapPickStatus.classList.replace('text-red-500', 'text-blue-600');
                            mapPickStatus.classList.remove('hidden');
                            
                            // 검색 리스트 비우기
                            searchResults.innerHTML = '';
                        });
                        searchResults.appendChild(li);
                    });
                }
            } catch (err) {
                searchStatus.textContent = "검색 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.";
                searchStatus.className = "mt-2 text-xs text-red-500 font-medium";
                console.error(err);
            }
        });
        
        // 엔터키 리로드 방지 및 검색 연결
        searchInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                btnSearchPlace.click();
            }
        });

        // 폼 제출 (저장)
        addForm.addEventListener('submit', (e) => {
            e.preventDefault();
            
            if (!pendingLatLng) {
                alert("장소를 검색해서 결과를 선택하거나, 하단의 지도 아이콘을 눌러 위치를 지정해야 합니다!");
                return;
            }

            const nameVal = document.getElementById('add-name').value.trim();
            if(!nameVal) return;

            const newLoc = {
                name: nameVal,
                searchName: nameVal,
                lat: pendingLatLng.lat,
                lng: pendingLatLng.lng,
                type: document.getElementById('add-type').value,
                desc: document.getElementById('add-desc').value || '',
                address: addAddressHidden.value || "직접 추가한 핀 위치",
                hours: document.getElementById('add-hours').value || '-',
                closed: document.getElementById('add-closed').value || '-',
                isCustom: true // 커스텀 장소 식별값
            };

            customLocations.push(newLoc);
            saveCustomLocations(); // Firebase 연동 함수 트리거
            
            // 모달 및 변수 리셋
            addModal.classList.add('hidden');
            addForm.reset();
            searchInput.value = '';
            searchResults.innerHTML = '';
            searchStatus.classList.add('hidden');
            pendingLatLng = null;

            // 로컬 임시 UI 업데이트 (구 rebuildMarkers 호출 등은 onSnapshot이 자동으로 해줌)
            // Firebase가 저장 후 onSnapshot을 트리거하기 때문
            // 방금 추가한 마커로 부드럽게 이동
            map.flyTo([newLoc.lat, newLoc.lng], 15, { animate: true });
        });

        // --- 필터링 상태 관리 및 로직 ---
        const allTypes = ['tour', 'food', 'cafe', 'transport', 'shop', 'stay'];
        let activeTypes = [...allTypes]; // 디폴트는 전체 선택 상태
        let isFavoriteFilterActive = false;
        let listSearchQuery = '';

        const listSearchInput = document.getElementById('list-search-input');
        const listSearchClearBtn = document.getElementById('btn-clear-list-search');

        listSearchInput?.addEventListener('input', (e) => {
            listSearchQuery = e.target.value.trim().toLowerCase();
            if (e.target.value.length > 0) {
                listSearchClearBtn?.classList.remove('hidden');
            } else {
                listSearchClearBtn?.classList.add('hidden');
            }
            renderList();
        });

        listSearchClearBtn?.addEventListener('click', () => {
            if(listSearchInput) {
                listSearchInput.value = '';
                listSearchQuery = '';
                listSearchClearBtn.classList.add('hidden');
                renderList();
                listSearchInput.focus();
            }
        }); // 즐겨찾기 필터 상태

        // --- 정렬 상태 관리 ---
        let currentSortCol = null;
        let isSortAsc = true;

        const updateFilters = () => {
            document.querySelectorAll('.filter-btn').forEach(btn => {
                const type = btn.dataset.type;
                const isAllBtn = type === 'all';
                const isActive = isAllBtn ? activeTypes.length === allTypes.length : activeTypes.includes(type);
                
                const activeBg = btn.dataset.activeBg;
                const activeBorder = btn.dataset.activeBorder;
                const activeText = btn.dataset.activeText;

                if (isActive) {
                    btn.classList.remove('bg-white', 'border-gray-200', 'text-gray-400', 'opacity-60');
                    btn.classList.add(activeBg, activeBorder, activeText, 'font-bold');
                } else {
                    btn.classList.remove(activeBg, activeBorder, activeText, 'font-bold');
                    btn.classList.add('bg-white', 'border-gray-200', 'text-gray-400', 'opacity-60');
                }
            });

            const isItineraryMap = (activeMainTab === 'btn-itinerary' && itineraryMode === 'view-map');

            markersData.forEach(item => {
                if (isItineraryMap) {
                    // 일정 뷰어 지도에서는 무조건 모든 항목을 다 표시한다 (필터 무시)
                    if (!map.hasLayer(item.marker)) map.addLayer(item.marker);
                } else {
                    const typeMatch = activeTypes.includes(item.type);
                    const favMatch = isFavoriteFilterActive ? favorites.includes(item.loc.name) : true;

                    if (typeMatch && favMatch) {
                        if (!map.hasLayer(item.marker)) map.addLayer(item.marker);
                    } else {
                        if (map.hasLayer(item.marker)) map.removeLayer(item.marker);
                    }
                }
            });

            // 리스트 뷰 업데이트 실행
            renderList();
        };

        // 즐겨찾기 전용 필터 버튼 이벤트
        const btnFavFilter = document.getElementById('btn-favorite-filter');
        btnFavFilter.addEventListener('click', () => {
            isFavoriteFilterActive = !isFavoriteFilterActive;
            
            if (isFavoriteFilterActive) {
                btnFavFilter.classList.remove('bg-white', 'border-gray-200', 'text-gray-400', 'opacity-60');
                btnFavFilter.classList.add('bg-yellow-50', 'border-yellow-400', 'text-yellow-600', 'font-bold', 'opacity-100');
            } else {
                btnFavFilter.classList.remove('bg-yellow-50', 'border-yellow-400', 'text-yellow-600', 'font-bold', 'opacity-100');
                btnFavFilter.classList.add('bg-white', 'border-gray-200', 'text-gray-400', 'opacity-60');
            }
            updateFilters();
        });

        // 일반 유형 필터 버튼 클릭 이벤트 등록
        document.querySelectorAll('.filter-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const type = e.currentTarget.dataset.type;
                
                if (type === 'all') {
                    if (activeTypes.length === allTypes.length) {
                        activeTypes = []; // 모두 해제
                    } else {
                        activeTypes = [...allTypes]; // 모두 선택
                    }
                } else {
                    if (activeTypes.includes(type)) {
                        activeTypes = activeTypes.filter(t => t !== type); // 선택 해제
                    } else {
                        activeTypes.push(type); // 개별 추가
                    }
                }
                updateFilters(); // 상태 변경 후 UI 동기화
            });
        });

        // --- 헤더 정렬 클릭 이벤트 등록 ---
        document.querySelectorAll('.sort-header').forEach(header => {
            header.addEventListener('click', () => {
                const sortKey = header.dataset.sort;
                
                if (currentSortCol === sortKey) {
                    isSortAsc = !isSortAsc; // 같은 컬럼 클릭 시 오름/내림차순 토글
                } else {
                    currentSortCol = sortKey;
                    isSortAsc = true; // 새로운 컬럼 클릭 시 기본 오름차순
                }

                // 모든 아이콘 초기화 후 현재 클릭된 컬럼에만 아이콘 표시
                document.querySelectorAll('.sort-icon').forEach(icon => icon.textContent = '');
                const iconSpan = header.querySelector('.sort-icon');
                iconSpan.textContent = isSortAsc ? '▲' : '▼';

                renderList(); // 정렬된 상태로 리스트 다시 렌더링
            });
        });

        // --- 리스트 화면 렌더링 함수 ---
        const renderList = () => {
            const tbody = document.getElementById('list-tbody');
            tbody.innerHTML = ''; // 초기화
            
            // 기본 장소와 사용자가 직접 추가한 장소 병합 데이터 사용
            const allLocations = [...locations, ...customLocations];

            // 1. 활성화된 필터 타입과 즐겨찾기 여부를 동시에 필터링
            let filteredLocations = allLocations.filter(loc => {
                const typeMatch = activeTypes.includes(loc.type);
                const favMatch = isFavoriteFilterActive ? favorites.includes(loc.name) : true;
                const searchMatch = listSearchQuery === '' || loc.name.toLowerCase().includes(listSearchQuery) || (loc.address && loc.address.toLowerCase().includes(listSearchQuery));
                return typeMatch && favMatch && searchMatch;
            });
            
            // 2. 정렬 상태가 있다면 데이터 정렬 적용
            if (currentSortCol) {
                filteredLocations.sort((a, b) => {
                    let valA, valB;
                    
                    if (currentSortCol === 'type') {
                        // 구분은 뱃지 텍스트(한글) 기준으로 정렬
                        valA = labels[a.type];
                        valB = labels[b.type];
                    } else if (currentSortCol === 'name') {
                        valA = a.name;
                        valB = b.name;
                    } else if (currentSortCol === 'address') {
                        valA = a.address || '';
                        valB = b.address || '';
                    }

                    if (valA < valB) return isSortAsc ? -1 : 1;
                    if (valA > valB) return isSortAsc ? 1 : -1;
                    return 0;
                });
            }

            // 3. 필터 및 정렬이 완료된 데이터로 HTML 렌더링
            filteredLocations.forEach((loc, index) => {
                const searchQuery = encodeURIComponent(loc.searchName);
                const naverMapUrl = `https://map.naver.com/p/search/${searchQuery}?c=${loc.lng},${loc.lat},15,0,0,0,dh`;
                const isFav = favorites.includes(loc.name);
                // 따옴표 및 특수문자로 인한 HTML 깨짐 방지
                const encodedName = encodeURIComponent(loc.name).replace(/'/g, "%27");

                const tr = document.createElement('tr');
                tr.className = "hover:bg-gray-50 transition-colors";
                
                tr.innerHTML = `
                    <td class="whitespace-nowrap py-4 pl-4 pr-2 text-center sm:pl-6">
                        <button type="button" onclick="toggleFavorite(event, '${encodedName}')" class="text-xl leading-none focus:outline-none transition-colors ${isFav ? 'text-yellow-400 hover:text-yellow-500' : 'text-gray-300 hover:text-yellow-400'}">
                            ${isFav ? '★' : '☆'}
                        </button>
                    </td>
                    <td class="whitespace-nowrap px-2 py-4 text-sm font-medium text-gray-500">${index + 1}</td>
                    <td class="whitespace-nowrap px-3 py-4 text-sm">
                        <span class="inline-flex rounded-full px-2 py-1 text-xs font-semibold ${badgeColors[loc.type]}">${labels[loc.type]}</span>
                    </td>
                    <td class="px-3 py-4 text-sm font-bold text-gray-900 break-keep">${escapeHTML(loc.name)}</td>
                    <td class="px-3 py-4 text-sm text-gray-500 break-keep">${escapeHTML(loc.address || "-")}</td>
                    <td class="px-3 py-4 text-sm text-gray-500 break-keep">${escapeHTML(loc.hours || "-")}</td>
                    <td class="px-3 py-4 text-sm text-gray-500 break-keep">${escapeHTML(loc.closed || "-")}</td>
                    <td class="whitespace-nowrap py-4 pl-3 pr-2 text-center text-sm font-medium" colspan="2">
                        <div class="flex flex-col gap-1.5 items-center w-full max-w-[90px] mx-auto">
                            <button type="button" onclick="openItineraryModal(event, '${encodedName}')" class="w-full inline-flex justify-center items-center px-2.5 py-1.5 border border-gray-300 text-xs font-bold rounded text-gray-700 bg-white hover:bg-gray-50 shadow-sm cursor-pointer whitespace-nowrap">
                                🗓️ 일정에 추가
                            </button>
                            <div class="flex items-center justify-between gap-1 w-full">
                                <button type="button" onclick="navigateToMapWithLocation('${encodedName}')" class="flex-1 inline-flex justify-center items-center px-1 py-1 border border-transparent text-[10px] font-medium rounded text-blue-700 bg-blue-50 hover:bg-blue-100 shadow-sm cursor-pointer whitespace-nowrap">
                                    📍 맵
                                </button>
                                <a href="${naverMapUrl}" target="_blank" rel="noopener noreferrer" class="flex-1 inline-flex justify-center items-center px-1 py-1 border border-transparent text-[10px] font-medium rounded text-white bg-[#03C75A] hover:bg-[#02b351] shadow-sm whitespace-nowrap">
                                    네이버↗
                                </a>
                            </div>
                        </div>
                    </td>
                `;
                tbody.appendChild(tr);
            });
        };

        // 초기화 시 전체 렌더링 시작
        const init = async () => {
            await loadInitialData();
            rebuildMarkers(); // updateFilters, renderList를 연쇄 호출함
        };
        init();

        // --- 리스트에서 지도로 이동하는 글로벌 함수 ---
        window.navigateToMapWithLocation = (encodedName) => {
            const name = decodeURIComponent(encodedName);
            const allLocations = [...locations, ...customLocations];
            const targetLoc = allLocations.find(loc => loc.name === name);
            if (!targetLoc) return;

            // 지도 뷰로 전환
            const mapView = document.getElementById('map');
            const listView = document.getElementById('list-view');
            const btnMap = document.getElementById('btn-map');
            const btnList = document.getElementById('btn-list');

            mapView.classList.remove('hidden');
            listView.classList.add('hidden');
            document.getElementById('itinerary-view').classList.add('hidden');

            btnMap.classList.add('bg-white', 'shadow-sm', 'font-bold', 'text-gray-800');
            btnMap.classList.remove('text-gray-500', 'font-medium', 'hover:text-gray-800');
            btnList.classList.add('text-gray-500', 'font-medium', 'hover:text-gray-800');
            btnList.classList.remove('bg-white', 'shadow-sm', 'font-bold', 'text-gray-800');
            
            const btnIti = document.getElementById('btn-itinerary');
            if(btnIti) {
                btnIti.classList.add('text-gray-500', 'font-medium', 'hover:text-gray-800');
                btnIti.classList.remove('bg-white', 'shadow-sm', 'font-bold', 'text-gray-800');
            }

            // 지도 사이즈 재계산 후 해당 위치로 이동 및 팝업 열기
            setTimeout(() => {
                map.invalidateSize();
                map.flyTo([targetLoc.lat, targetLoc.lng], 17, { animate: true, duration: 1.0 });

                setTimeout(() => {
                    const targetMarkerData = markersData.find(m => m.loc.name === name);
                    if (targetMarkerData) {
                        // 마커가 필터에 의해 숨겨져 있으면 지도에 추가
                        if (!map.hasLayer(targetMarkerData.marker)) {
                            map.addLayer(targetMarkerData.marker);
                        }
                        targetMarkerData.marker.openPopup();
                    }
                }, 800);
            }, 100);
        };

        // --- 탭 전환 글로벌 함수 ---
        const updateFilterPosition = () => {
            const filters = document.getElementById('filter-buttons-container');
            if (!filters) return;
            
            if (activeMainTab === 'btn-map') {
                filters.classList.remove('hidden');
                filters.className = 'absolute top-3 right-3 z-[1000] flex flex-nowrap items-center gap-1 text-xs font-medium bg-white/70 backdrop-blur-sm px-2.5 py-1.5 rounded-xl shadow-md border border-gray-100';
                document.getElementById('map').appendChild(filters);
            } else if (activeMainTab === 'btn-list') {
                filters.classList.remove('hidden');
                filters.className = 'flex flex-nowrap overflow-x-auto no-scrollbar gap-2 text-xs font-medium w-full lg:w-auto shrink-0 justify-start lg:justify-end pb-1';
                document.getElementById('list-filters-placeholder')?.appendChild(filters);
            } else {
                filters.classList.add('hidden');
            }
        };

        window.switchTab = (tabId) => {
            activeMainTab = tabId;
            const tabs = ['btn-map', 'btn-list', 'btn-itinerary'];
            const views = ['map', 'list-view', 'itinerary-view'];

            tabs.forEach((id, index) => {
                const btn = document.getElementById(id);
                const view = document.getElementById(views[index]);
                if (!btn || !view) return;

                if (id === tabId) {
                    btn.classList.add('bg-white', 'shadow-sm', 'font-bold', 'text-gray-800');
                    btn.classList.remove('text-gray-500', 'font-medium', 'hover:text-gray-800');
                    view.classList.remove('hidden');
                } else {
                    btn.classList.add('text-gray-500', 'font-medium', 'hover:text-gray-800');
                    btn.classList.remove('bg-white', 'shadow-sm', 'font-bold', 'text-gray-800');
                    view.classList.add('hidden');
                }
            });

            updateItineraryModeUI();

            if (tabId === 'btn-map') {
                rebuildMarkers();
                setTimeout(() => { map.invalidateSize(); if(window.fitAllMarkers) window.fitAllMarkers(); }, 300);
            } else if (tabId === 'btn-list') {
                rebuildMarkers();
            } else if (tabId === 'btn-itinerary') {
                activeTripId = null;
                itineraryMode = 'edit';
                if (window.rebuildItineraryUI) window.rebuildItineraryUI();
                updateItineraryModeUI();
            }
            
            updateFilterPosition();
        };

        const btnMap = document.getElementById('btn-map');
        const btnList = document.getElementById('btn-list');
        const btnItinerary = document.getElementById('btn-itinerary');
        
        btnMap.addEventListener('click', () => switchTab('btn-map'));
        btnList.addEventListener('click', () => switchTab('btn-list'));
        if (btnItinerary) btnItinerary.addEventListener('click', () => switchTab('btn-itinerary'));

        // 브라우저 리사이즈 시 지도 크기 동기화
        window.addEventListener('resize', () => {
            map.invalidateSize();
        });

        window.fitAllMarkers = () => {
            const allLocations = [...locations, ...customLocations];
            let markersToFit = [];
            
            if (activeMainTab === 'btn-itinerary' && activeTripId) {
                const activeTrip = trips.find(t => t.id === activeTripId);
                if (activeTrip) {
                    activeTrip.days.forEach(day => {
                        day.items.forEach(item => {
                            const match = allLocations.find(l => l.name === item.name);
                            if (match) markersToFit.push(match);
                        });
                    });
                }
            }
            // 특정 일정이 선택되지 않았거나 일정이 비어있다면 전체 마커를 기준으로 함
            if (markersToFit.length === 0) {
                markersToFit = allLocations;
            }
            
            if (markersToFit.length === 0) return;
            
            const group = new L.featureGroup(markersToFit.map(loc => L.customMarker ? L.marker([loc.lat, loc.lng]) : L.marker([loc.lat, loc.lng])));
            map.invalidateSize();
            map.fitBounds(group.getBounds().pad(0.1), { maxZoom: 16 });
        };

        // 초기 줌 설정 및 필터 위치 초기화
        setTimeout(() => {
            if(window.fitAllMarkers) window.fitAllMarkers();
            updateFilterPosition();
        }, 800);

    
        // --- 일정 관리를 위한 전역 함수 및 로직 ---
        let pendingItineraryLocation = null;

        window.openItineraryModal = (e, encodedName) => {
            if (e) {
                e.preventDefault();
                e.stopPropagation();
            }
            if (!trips || trips.length === 0) {
                alert("아직 생성된 여행이 없습니다. [일정] 탭에서 새 여행을 먼저 만들어주세요!");
                switchTab('btn-itinerary');
                return;
            }

            pendingItineraryLocation = decodeURIComponent(encodedName);
            
            const tripSelect = document.getElementById('trip-select');
            tripSelect.innerHTML = '';
            trips.forEach(trip => {
                const opt = document.createElement('option');
                opt.value = trip.id;
                opt.textContent = `${trip.name} (${trip.totalDays}일)`;
                tripSelect.appendChild(opt);
            });
            
            if (activeTripId) tripSelect.value = activeTripId;

            const renderDayButtons = () => {
                const dayBtnsContainer = document.getElementById('itinerary-day-buttons');
                dayBtnsContainer.innerHTML = '';
                const selectedTripId = tripSelect.value;
                const selectedTrip = trips.find(t => t.id === selectedTripId);
                
                if (selectedTrip) {
                    for (let i = 0; i < selectedTrip.totalDays; i++) {
                        const btn = document.createElement('button');
                        btn.className = "w-full text-left px-4 py-3 bg-blue-50 hover:bg-blue-100 text-blue-800 font-bold rounded-lg transition-colors border border-blue-200";
                        btn.textContent = `Day ${i + 1} 에 추가하기`;
                        btn.onclick = () => {
                            addLocationToItinerary(selectedTripId, i, pendingItineraryLocation);
                            document.getElementById('itinerary-select-modal').classList.add('hidden');
                        };
                        dayBtnsContainer.appendChild(btn);
                    }
                }
            };
            
            tripSelect.onchange = renderDayButtons;
            renderDayButtons();

            document.getElementById('itinerary-select-modal').classList.remove('hidden');
        };

        document.getElementById('btn-close-itinerary-modal').addEventListener('click', () => {
            pendingItineraryLocation = null;
            document.getElementById('itinerary-select-modal').classList.add('hidden');
        });

        const addLocationToItinerary = (tripId, dayIndex, locName) => {
            const allLocations = [...locations, ...customLocations];
            const locObj = allLocations.find(l => l.name === locName);
            if (!locObj) return;

            const targetTrip = trips.find(t => t.id === tripId);
            if (!targetTrip) return;

            targetTrip.days[dayIndex].items.push({
                id: 'item-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
                name: locObj.name,
                type: locObj.type
            });

            saveTrips();
            if (window.rebuildItineraryUI) rebuildItineraryUI();

            // 지도에서 추가 시 일정 뷰로 자동 튕기기
            switchTab('btn-itinerary');

            alert(`[${targetTrip.name}] Day ${dayIndex + 1} 일정에 [${locObj.name}] 추가되었습니다!`);
        };

        window.jumpToMapForAdding = () => {
            switchTab('btn-map');
            setTimeout(() => {
                alert("지도나 리스트에서 장소를 찾아 [🗓️ 일정에 추가] 버튼을 눌러주세요!");
            }, 300);
        };

        
        window.removeLocationFromItinerary = (dayIndex, itemId) => {
        if (!activeTripId) return;
        const targetTrip = trips.find(t => t.id === activeTripId);
        targetTrip.days[dayIndex].items = targetTrip.days[dayIndex].items.filter(item => item.id !== itemId);
        saveTrips();
        if (window.rebuildItineraryUI) rebuildItineraryUI();
    };

        window.resetItinerary = () => {
            document.getElementById('itinerary-reset-modal').classList.remove('hidden');
        };

        const btnConfirmResetIti = document.getElementById('btn-confirm-reset-itinerary');
        if (btnConfirmResetIti) {
            btnConfirmResetIti.addEventListener('click', () => {
                if (!activeTripId) return;
                const targetTrip = trips.find(t => t.id === activeTripId);
                if (targetTrip) {
                    targetTrip.days = Array.from({length: targetTrip.totalDays}, () => ({ items: [] }));
                    saveTrips();
                }
                document.getElementById('itinerary-reset-modal').classList.add('hidden');
                if (window.rebuildItineraryUI) rebuildItineraryUI();
            });
        }

        // --- 다중 추가 (Multi-add) 로직 ---
        let pendingMultiAddDayIndex = 0;
        let selectedMultiAddLocations = new Set();
        let multiAddSearchQuery = '';

        window.openMultiAddModal = (dayIndex) => {
            pendingMultiAddDayIndex = dayIndex;
            selectedMultiAddLocations.clear();
            multiAddSearchQuery = '';
            document.getElementById('multi-add-search').value = '';
            
            document.getElementById('multi-add-title').textContent = `Day ${dayIndex + 1} 에 여러 장소 추가`;
            document.getElementById('itinerary-multi-add-modal').classList.remove('hidden');
            
            renderMultiAddList();
            updateMultiAddCount();
        };

        window.closeMultiAddModal = () => {
            document.getElementById('itinerary-multi-add-modal').classList.add('hidden');
        };

        const renderMultiAddList = () => {
            const container = document.getElementById('multi-add-list');
            container.innerHTML = '';
            
            const allLocations = [...locations, ...customLocations];
            
            // 필터링 적용
            const query = multiAddSearchQuery.toLowerCase();
            const filtered = allLocations.filter(l => l.name.toLowerCase().includes(query) || (l.address && l.address.toLowerCase().includes(query)));

            filtered.forEach(loc => {
                const isSelected = selectedMultiAddLocations.has(loc.name);
                
                const box = document.createElement('div');
                box.className = `p-3 border-b flex items-center gap-3 cursor-pointer hover:bg-blue-50 transition-colors ${isSelected ? 'bg-blue-50 border-blue-200' : 'border-gray-100'}`;
                
                box.onclick = () => {
                    if (selectedMultiAddLocations.has(loc.name)) {
                        selectedMultiAddLocations.delete(loc.name);
                    } else {
                        selectedMultiAddLocations.add(loc.name);
                    }
                    renderMultiAddList(); // 하이라이트 토글용 재렌더링
                    updateMultiAddCount();
                };

                // 아이콘 혹은 체크박스 UI
                box.innerHTML = `
                    <div class="w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${isSelected ? 'bg-blue-500 border-blue-500 text-white' : 'border-gray-300 bg-white text-transparent'}">
                        ${isSelected ? '✓' : ''}
                    </div>
                    <div class="flex-1 flex flex-col justify-center overflow-hidden">
                        <div class="flex items-center gap-2">
                            <span class="font-bold text-sm text-gray-800 truncate">${safeName}</span>
                            <span class="text-[10px] ${badgeColors[loc.type]} px-1.5 py-0.5 rounded-full shrink-0">${labels[loc.type]}</span>
                        </div>
                        <span class="text-xs text-gray-400 truncate mt-0.5">${loc.address || ''}</span>
                    </div>
                `;
                
                container.appendChild(box);
            });
        };

        const updateMultiAddCount = () => {
            const btnSpan = document.getElementById('multi-add-count');
            if(btnSpan) btnSpan.textContent = selectedMultiAddLocations.size;
        };

        const multiAddInput = document.getElementById('multi-add-search');
        if (multiAddInput) {
            // 입력할 때마다 필터링
            multiAddInput.addEventListener('input', (e) => {
                multiAddSearchQuery = e.target.value.trim();
                renderMultiAddList();
            });
        }

        const btnConfirmMultiAdd = document.getElementById('btn-confirm-multi-add');
        if (btnConfirmMultiAdd) {
            btnConfirmMultiAdd.addEventListener('click', () => {
                if(selectedMultiAddLocations.size === 0) {
                    alert('선택된 장소가 없습니다.');
                    return;
                }

                const allLocations = [...locations, ...customLocations];
                
                // Set에 담긴 이름들을 기반해 실제 객체 찾아 itinerary에 푸시
                if (!activeTripId) return;
                const targetTrip = trips.find(t => t.id === activeTripId);
                
                selectedMultiAddLocations.forEach(name => {
                    const locObj = allLocations.find(l => l.name === name);
                    if (locObj && targetTrip) {
                        targetTrip.days[pendingMultiAddDayIndex].items.push({
                            id: 'item-' + Date.now() + '-' + Math.floor(Math.random() * 10000),
                            name: locObj.name,
                            type: locObj.type
                        });
                    }
                });

                saveTrips();
                closeMultiAddModal();
                if (window.rebuildItineraryUI) rebuildItineraryUI();
                
                // 토스트 띄우기 대용으로 시간 지연 알림 호출
                setTimeout(() => {
                    alert(`Day ${pendingMultiAddDayIndex + 1} 일정에 ${selectedMultiAddLocations.size}개 장소가 추가되었습니다!`);
                }, 100);
            });
        }

        
        let itineraryMode = 'edit'; // 'edit', 'view-list', 'view-map'
        let activeMainTab = 'btn-map';

        const updateItineraryModeUI = () => {
            const btnEdit = document.getElementById('btn-mode-edit');
            const btnList = document.getElementById('btn-mode-view-list');
            const btnMap = document.getElementById('btn-mode-view-map');
            const subHeader = document.getElementById('itinerary-sub-header');
            const itiView = document.getElementById('itinerary-view');
            const itiContainer = document.getElementById('itinerary-container');
            const mainMap = document.getElementById('map');

            if (activeMainTab !== 'btn-itinerary') {
                subHeader.classList.add('hidden');
            } else {
                subHeader.classList.remove('hidden');
            }

            // 서브헤더 좌측 영역 업데이트 (여행 목록 제목 or 뒤로가기+여행명)
            const subHeaderLeft = document.getElementById('itinerary-sub-header-left');
            const modeButtons = document.getElementById('itinerary-mode-buttons');
            if (subHeaderLeft) {
                if (!activeTripId) {
                    subHeaderLeft.innerHTML = `<h2 class="text-base font-extrabold text-gray-800 whitespace-nowrap">나의 여행 목록 🧳</h2>`;
                    if (modeButtons) modeButtons.classList.add('hidden');
                } else {
                    const activeTrip = trips.find(t => t.id === activeTripId);
                    const tripName = activeTrip ? activeTrip.name : '';
                    subHeaderLeft.innerHTML = `
                        <button type="button" onclick="goBackToTripList()" class="p-1 px-2 text-gray-500 hover:text-gray-800 hover:bg-gray-200 rounded-lg transition-colors font-bold shrink-0 cursor-pointer">⬅️</button>
                        <h2 class="text-base font-extrabold text-gray-800 truncate max-w-[200px]">${tripName}</h2>
                    `;
                    if (modeButtons) modeButtons.classList.remove('hidden');
                }
            }

            // 초기화
            [btnEdit, btnList, btnMap].forEach(b => {
                if(!b) return;
                b.className = 'px-4 py-1.5 rounded-md text-sm font-medium bg-white text-gray-500 hover:bg-gray-50 transition-colors border border-gray-200';
            });

            if (itineraryMode === 'edit') {
                if(btnEdit) btnEdit.className = 'px-4 py-1.5 rounded-md text-sm font-bold bg-blue-50 text-blue-700 transition-colors border-none';
                itiView.classList.add('flex-1', 'h-full');
                itiContainer.classList.remove('hidden');
                if(activeMainTab === 'btn-itinerary') mainMap.classList.add('hidden');
            } else if (itineraryMode === 'view-list') {
                if(btnList) btnList.className = 'px-4 py-1.5 rounded-md text-sm font-bold bg-blue-50 text-blue-700 transition-colors border-none';
                itiView.classList.add('flex-1', 'h-full');
                itiContainer.classList.remove('hidden');
                if(activeMainTab === 'btn-itinerary') mainMap.classList.add('hidden');
            } else if (itineraryMode === 'view-map') {
                if(btnMap) btnMap.className = 'px-4 py-1.5 rounded-md text-sm font-bold bg-blue-50 text-blue-700 transition-colors border-none';
                itiView.classList.remove('flex-1', 'h-full');
                itiContainer.classList.add('hidden');
                if(activeMainTab === 'btn-itinerary') mainMap.classList.remove('hidden');
            }
            
            if(activeMainTab === 'btn-itinerary' && (itineraryMode === 'view-map' || itineraryMode === 'view-list' || itineraryMode === 'edit')) {
                rebuildMarkers();
                if(itineraryMode === 'view-map') {
                    setTimeout(() => { map.invalidateSize(); if(window.fitAllMarkers) window.fitAllMarkers(); }, 300);
                }
            }
        };

        // 서브 헤더 이벤트 리스너 (module 스크립트는 DOMContentLoaded 이후 실행되므로 직접 등록)
        document.getElementById('btn-mode-edit').addEventListener('click', () => { itineraryMode = 'edit'; updateItineraryModeUI(); rebuildItineraryUI(); });
        document.getElementById('btn-mode-view-list').addEventListener('click', () => { itineraryMode = 'view-list'; updateItineraryModeUI(); rebuildItineraryUI(); });
        document.getElementById('btn-mode-view-map').addEventListener('click', () => { 
            itineraryMode = 'view-map'; 
            updateItineraryModeUI(); 
            rebuildItineraryUI(); 
            rebuildMarkers();
            setTimeout(() => { if(window.fitAllMarkers) window.fitAllMarkers(); }, 100);
        });

        document.getElementById('btn-open-share-modal')?.addEventListener('click', () => {
            if (!currentUser) {
                document.getElementById('login-required-modal').classList.remove('hidden');
                return;
            }
            if (!activeTripId) return;
            window.tripIdToShare = activeTripId;
            document.getElementById('trip-share-modal')?.classList.remove('hidden');
            if(window.loadSharedEmails) window.loadSharedEmails(activeTripId);
        });

        window.removeShare = async (shareDocId) => {
            try {
                await deleteDoc(doc(db, "shares", shareDocId));
                if(window.loadSharedEmails) window.loadSharedEmails(window.tripIdToShare);
            } catch (e) {
                console.error(e);
                alert('권한 회수에 실패했습니다.');
            }
        };

        document.getElementById('share-add-form')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const emailInput = document.getElementById('share-new-email');
            const targetEmail = emailInput.value.trim().toLowerCase();
            if (!targetEmail || !window.tripIdToShare || !currentUser) return;

            const shareDocId = `${targetEmail}_${window.tripIdToShare}`;
            try {
                await setDoc(doc(db, "shares", shareDocId), {
                    sharedEmail: targetEmail,
                    tripId: window.tripIdToShare,
                    ownerUid: currentUser.uid,
                    createdAt: Date.now()
                });
                emailInput.value = '';
                if(window.loadSharedEmails) window.loadSharedEmails(window.tripIdToShare);
            } catch (err) {
                console.error(err);
                alert('초대 실패: ' + err.message);
            }
        });

        window.loadSharedEmails = async (tripId) => {
            const listEl = document.getElementById('shared-emails-list');
            if(!listEl) return;
            listEl.innerHTML = '<div class="text-center py-4 text-sm text-gray-500 bg-gray-50 rounded-lg border border-gray-100">로딩 중...</div>';
            
            try {
                const q = query(collection(db, "shares"), where("tripId", "==", tripId));
                const snap = await getDocs(q);
                
                if (snap.empty) {
                    listEl.innerHTML = '<div class="text-center py-4 text-sm text-gray-500 bg-gray-50 rounded-lg border border-gray-100">아직 공유된 사용자가 없습니다.</div>';
                    return;
                }
                
                let html = '';
                snap.forEach(docSnap => {
                    const data = docSnap.data();
                    html += `
                    <div class="flex items-center justify-between bg-white border border-gray-200 rounded-lg px-3 py-2">
                        <span class="text-sm font-medium text-gray-700">${data.sharedEmail}</span>
                        <button type="button" onclick="removeShare('${docSnap.id}')" class="text-red-500 hover:text-red-700 hover:bg-red-50 px-2 py-1 rounded text-xs transition-colors cursor-pointer">삭제</button>
                    </div>
                    `;
                });
                listEl.innerHTML = html;
            } catch(e) {
                listEl.innerHTML = '<div class="text-center py-4 text-sm text-red-500 bg-red-50 rounded-lg border border-red-100">권한 정보를 불러오지 못했습니다.</div>';
            }
        };

        window.addNewDayToItinerary = () => {
        if (!activeTripId) return;
        const targetTrip = trips.find(t => t.id === activeTripId);
        if(targetTrip.totalDays >= 10) {
            alert("일정은 최대 10일까지만 만들 수 있습니다.");
            return;
        }
        targetTrip.days.push({ items: [] });
        targetTrip.totalDays += 1; saveSingleTrip(targetTrip);
        rebuildItineraryUI();
    };

        let dayToDelete = null;

        window.deleteDayFromItinerary = (dayIndex) => {
            if (!activeTripId) return;
            dayToDelete = dayIndex;
            document.getElementById('day-delete-modal-msg').innerText = `Day ${dayIndex + 1} 전체를 삭제하시겠습니까?`;
            document.getElementById('day-delete-modal').classList.remove('hidden');
        };

        document.getElementById('btn-confirm-delete-day')?.addEventListener('click', () => {
            if (dayToDelete === null || !activeTripId) return;
            const targetTrip = trips.find(t => t.id === activeTripId);
            if(targetTrip) {
                targetTrip.days.splice(dayToDelete, 1);
                targetTrip.totalDays -= 1; saveSingleTrip(targetTrip);
                rebuildItineraryUI();
            }
            dayToDelete = null;
            document.getElementById('day-delete-modal').classList.add('hidden');
        });

        let sortableInstances = [];

        window.selectTrip = (tripId) => {
            activeTripId = tripId;
            itineraryMode = 'view-list';
            rebuildItineraryUI();
            updateItineraryModeUI();
        };

        window.goBackToTripList = () => {
            activeTripId = null;
            itineraryMode = 'edit'; // 보기(지도) 등 모드도 기본값으로 초기화
            rebuildItineraryUI();
            updateItineraryModeUI();
            rebuildMarkers();
        };

        let tripToDelete = null;

        window.openShareModalForTrip = (event, tripId) => {
            event.stopPropagation();
            if (!currentUser) {
                document.getElementById('login-required-modal').classList.remove('hidden');
                return;
            }
            window.tripIdToShare = tripId;
            document.getElementById('trip-share-modal')?.classList.remove('hidden');
            if(window.loadSharedEmails) window.loadSharedEmails(tripId);
        };

        window.deleteTrip = (e, tripId) => {
            e.stopPropagation();
            tripToDelete = tripId;
            document.getElementById('trip-delete-modal').classList.remove('hidden');
        };

        document.getElementById('btn-confirm-delete-trip')?.addEventListener('click', () => {
            if (!tripToDelete) return;
            trips = trips.filter(t => t.id !== tripToDelete);
            if (activeTripId === tripToDelete) { activeTripId = null; itineraryMode = 'edit'; }
            removeTrip(tripToDelete);
            
            setTimeout(() => rebuildItineraryUI(), 50);
        });

        let tripToEdit = null;

        window.editTrip = (e, tripId) => {
            e.stopPropagation();
            tripToEdit = tripId;
            const targetTrip = trips.find(t => t.id === tripId);
            if (targetTrip) {
                document.getElementById('edit-trip-name-input').value = targetTrip.name || '';
                if (targetTrip.date && targetTrip.date.includes('~')) {
                    const parts = targetTrip.date.split('~');
                    const parseDate = (dStr) => {
                        if(!dStr) return '';
                        const parts = dStr.split('/');
                        if(parts.length !== 3) return '';
                        return `20${parts[0]}-${parts[1]}-${parts[2]}`;
                    };
                    document.getElementById('edit-trip-date-start').value = parseDate(parts[0]);
                    document.getElementById('edit-trip-date-end').value = parseDate(parts[1]);
                } else {
                    document.getElementById('edit-trip-date-start').value = '';
                    document.getElementById('edit-trip-date-end').value = '';
                }
                document.getElementById('trip-edit-modal').classList.remove('hidden');
            }
        };

        document.getElementById('btn-confirm-edit-trip')?.addEventListener('click', () => {
            if (!tripToEdit) return;
            const trip = trips.find(t => t.id === tripToEdit);
            if (trip) {
                const newName = document.getElementById('edit-trip-name-input').value.trim();
                const startDate = document.getElementById('edit-trip-date-start').value;
                const endDate = document.getElementById('edit-trip-date-end').value;

                if (!startDate || !endDate) {
                    alert('여행 날짜를 선택해주세요!');
                    return;
                }

                trip.name = newName || '새로운 일정';
                trip.date = `${formatDateShort(startDate)}~${formatDateShort(endDate)}`;

                const msPerDay = 1000 * 60 * 60 * 24;
                const newTotalDays = Math.max(1, Math.min(Math.round((new Date(endDate) - new Date(startDate)) / msPerDay) + 1, 30));
                while (trip.days.length < newTotalDays) {
                    trip.days.push({ items: [] });
                }
                trip.totalDays = newTotalDays;

                saveSingleTrip(trip);
                rebuildItineraryUI();
            }
            tripToEdit = null;
            document.getElementById('trip-edit-modal').classList.add('hidden');
        });

        const formatDateShort = (dateStr) => {
            if (!dateStr) return '';
            const d = new Date(dateStr);
            const yy = String(d.getFullYear()).slice(2);
            const mm = String(d.getMonth() + 1).padStart(2, '0');
            const dd = String(d.getDate()).padStart(2, '0');
            return `${yy}/${mm}/${dd}`;
        };

        document.getElementById('btn-confirm-create-trip')?.addEventListener('click', () => {
            const nameInput = document.getElementById('modal-new-trip-name');
            const startDateInput = document.getElementById('modal-new-trip-date-start');
            const endDateInput = document.getElementById('modal-new-trip-date-end');
            
            const name = nameInput.value.trim() || '새로운 일정';
            const startDate = startDateInput ? startDateInput.value : '';
            const endDate = endDateInput ? endDateInput.value : '';
            let tripDate = '';
            if (startDate && endDate) {
                tripDate = `${formatDateShort(startDate)}~${formatDateShort(endDate)}`;
            } else if (startDate) {
                tripDate = formatDateShort(startDate);
            }
            if (!startDate || !endDate) {
                alert('여행 날짜를 선택해주세요!');
                return;
            }

            const msPerDay = 1000 * 60 * 60 * 24;
            const diffDays = Math.round((new Date(endDate) - new Date(startDate)) / msPerDay) + 1;
            const totalDays = Math.max(1, Math.min(diffDays, 30));

            const newTrip = {
                id: 'trip-' + Date.now(),
                name: name,
                date: tripDate,
                totalDays: totalDays,
                days: Array.from({length: totalDays}, () => ({ items: [] }))
            };

            trips.unshift(newTrip);
            saveSingleTrip(newTrip);
            document.getElementById('trip-create-modal').classList.add('hidden');
            rebuildItineraryUI();
        });

        document.getElementById('btn-open-create-trip-modal-fixed')?.addEventListener('click', () => {
            if (!currentUser) {
                document.getElementById('login-required-modal').classList.remove('hidden');
                return;
            }
            document.getElementById('modal-new-trip-name').value = '';
            document.getElementById('modal-new-trip-date-start').value = '';
            document.getElementById('modal-new-trip-date-end').value = '';
            document.getElementById('trip-create-modal').classList.remove('hidden');
        });

        window.rebuildItineraryUI = () => {
            const container = document.getElementById('itinerary-container');
            if(!container) return;
            
            sortableInstances.forEach(inst => inst.destroy());
            sortableInstances = [];

            // 1. 활성화된 여행이 없을 때 (여행 목록 뷰)
            if (!activeTripId) {
                let html = ``;

                if (!trips || trips.length === 0) {
                    html += `
                        <div class="flex-1 flex flex-col items-center justify-center text-center p-6 pb-12">
                            <div class="text-6xl mb-6">✈️</div>
                            <h2 class="text-xl font-bold text-gray-800 mb-2">아직 계획된 여행이 없습니다</h2>
                            <p class="text-gray-500 mb-0 text-sm">새로운 경주 여행을 시작해보세요!</p>
                        </div>
                    `;
                } else {
                    html += `<div id="trip-list-sortable" class="flex flex-col gap-4 overflow-y-auto mb-6 no-scrollbar pb-4">`;
                    trips.forEach(trip => {
                        html += `
                            <div data-trip-id="${trip.id}" class="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden flex flex-col shrink-0 hover:shadow-md transition-shadow group relative">
                                <div class="flex items-stretch">
                                    <div class="trip-drag-handle w-10 flex items-center justify-center text-gray-300 hover:text-gray-500 hover:bg-gray-50 cursor-grab active:cursor-grabbing border-r border-gray-50 transition-colors">
                                        <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 16 16"><path d="M4.5 3.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0m0 4a1 1 0 1 1-2 0 1 1 0 0 1 2 0m0 4a1 1 0 1 1-2 0 1 1 0 0 1 2 0m5-8a1 1 0 1 1-2 0 1 1 0 0 1 2 0m0 4a1 1 0 1 1-2 0 1 1 0 0 1 2 0m0 4a1 1 0 1 1-2 0 1 1 0 0 1 2 0m5-8a1 1 0 1 1-2 0 1 1 0 0 1 2 0m0 4a1 1 0 1 1-2 0 1 1 0 0 1 2 0m0 4a1 1 0 1 1-2 0 1 1 0 0 1 2 0"/></svg>
                                    </div>
                                    <div onclick="selectTrip('${trip.id}')" class="p-5 flex-1 flex items-center justify-between cursor-pointer">
                                        <div class="flex flex-col gap-1 pr-6">
                                            <div class="flex items-center gap-2">
                                                <h3 class="font-bold text-gray-800 text-lg group-hover:text-blue-600 transition-colors truncate max-w-[200px]">${trip.name}</h3>
                                                ${trip.isShared ? `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-blue-100 text-blue-600 border border-blue-200 shrink-0">👥 공유됨</span>` : ''}
                                            </div>
                                            <p class="text-sm text-gray-500 font-medium">
                                                ${trip.date ? `<span class="bg-blue-50 text-blue-600 px-2 py-0.5 rounded-md text-xs font-bold mr-2">${trip.date}</span>` : ''}총 ${trip.days.length}일 일정
                                            </p>
                                        </div>
                                        <div class="flex items-center gap-2 shrink-0">
                                            ${!trip.isShared ? `<button onclick="openShareModalForTrip(event, '${trip.id}')" class="w-8 h-8 rounded-full bg-green-50 flex items-center justify-center text-green-600 hover:bg-green-100 hover:text-green-700 transition-colors" title="이 일정 공유 권한 관리">
                                                🔗
                                            </button>` : ''}
                                            <button onclick="editTrip(event, '${trip.id}')" class="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-gray-500 hover:bg-gray-200 hover:text-gray-800 transition-colors" title="여행 정보 수정">
                                                ✏️
                                            </button>
                                            ${!trip.isShared ? `<button onclick="deleteTrip(event, '${trip.id}')" class="w-8 h-8 rounded-full bg-red-50 flex items-center justify-center text-red-400 hover:bg-red-500 hover:text-white transition-colors" title="이 일정 삭제">
                                                🗑️
                                            </button>` : ''}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        `;
                    });
                    html += `</div>`;
                }

                container.innerHTML = html;

                // 하단 고정 버튼 표시
                const bottomBar = document.getElementById('itinerary-bottom-bar');
                if (bottomBar) bottomBar.classList.remove('hidden');

                // 여행 목록 드래그&드롭 리스트 (Sortable.js)
                const tripListSortableEl = document.getElementById('trip-list-sortable');
                if (tripListSortableEl) {
                    const inst = new Sortable(tripListSortableEl, {
                        handle: '.trip-drag-handle',
                        animation: 150,
                        ghostClass: 'opacity-50',
                        onEnd: function (evt) {
                            const newTrips = [];
                            evt.to.querySelectorAll('[data-trip-id]').forEach(el => {
                                const id = el.getAttribute('data-trip-id');
                                const trip = trips.find(t => t.id === id);
                                if(trip) newTrips.push(trip);
                            });
                            trips = newTrips;
                            saveTrips();
                        }
                    });
                    sortableInstances.push(inst);
                }

                return;
            }

            // 2. 특정 여행이 선택된 상태 (여행 상세 뷰)
            const activeTrip = trips.find(t => t.id === activeTripId);

            // 하단 버튼 숨기기 (상세뷰에서는 불필요)
            const btnShare = document.getElementById('btn-open-share-modal');
            if (activeTrip && activeTrip.isShared) {
                if (btnShare) btnShare.classList.add('hidden');
            } else {
                if (btnShare) btnShare.classList.remove('hidden');
            }
            const bottomBar2 = document.getElementById('itinerary-bottom-bar');
            if (bottomBar2) bottomBar2.classList.add('hidden');

            if (!activeTrip) {
                activeTripId = null;
                itineraryMode = 'edit';
                rebuildItineraryUI();
                return;
            }

            let html = ``;
            
            if (itineraryMode === 'edit') {
                html += `<div class="flex justify-end px-1 mt-2 mb-4"><button type="button" onclick="resetItinerary()" class="text-xs font-semibold px-3 py-1.5 text-red-600 bg-red-50 rounded-lg hover:bg-red-100 transition-colors shrink-0 outline-none">초기화</button></div>`;
            }

            html += `
                <div class="flex flex-col gap-6 overflow-y-auto pb-8 no-scrollbar" id="itinerary-days-wrapper">
            `;

            for (let i = 0; i < activeTrip.totalDays; i++) {
                html += `
                    <div class="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden flex flex-col shrink-0">
                        <div class="bg-gradient-to-r from-blue-50 to-indigo-50 px-4 py-3 border-b border-gray-100 flex items-center justify-between">
                            <h3 class="font-bold text-gray-800 text-base">Day ${i + 1}</h3>
                            <div class="flex items-center gap-2">
                                <span class="text-[11px] font-medium text-gray-500 bg-white px-2 py-0.5 rounded-full shadow-sm">${activeTrip.days[i].items.length} 장소</span>
                `;
                if (itineraryMode === 'edit') {
                    html += `<button onclick="deleteDayFromItinerary(${i})" class="text-red-400 hover:text-red-600 px-1 py-0.5" title="이 일정 삭제">🗑️</button>`;
                }
                html += `
                            </div>
                        </div>
                        <div class="p-3">
                            <ul class="flex flex-col gap-2 min-h-[3.5rem] itinerary-sortable-list" data-day="${i}">
                `;

                activeTrip.days[i].items.forEach((item, index) => {
                    const viewClickAttr = (itineraryMode === 'view-list') ? `onclick="navigateToMapWithLocation('${encodeURIComponent(item.name).replace(/'/g, "%27")}'); switchTab('btn-map');"` : '';
                    const cursorClass = (itineraryMode === 'view-list') ? 'cursor-pointer hover:shadow-md' : 'cursor-grab active:cursor-grabbing hover:bg-gray-100';

                    html += `
                        <li class="bg-gray-50 border border-gray-200 rounded-lg p-2.5 flex items-center gap-2.5 transition-all group ${cursorClass}" data-id="${item.id}" data-type="${item.type}" ${viewClickAttr}>
                    `;
                    
                    if (itineraryMode === 'edit') {
                        html += `
                            <div class="text-gray-400 shrink-0 flex items-center drag-handle px-1">
                                <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 16 16"><path d="M4.5 3.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0m0 4a1 1 0 1 1-2 0 1 1 0 0 1 2 0m0 4a1 1 0 1 1-2 0 1 1 0 0 1 2 0m5-8a1 1 0 1 1-2 0 1 1 0 0 1 2 0m0 4a1 1 0 1 1-2 0 1 1 0 0 1 2 0m0 4a1 1 0 1 1-2 0 1 1 0 0 1 2 0m5-8a1 1 0 1 1-2 0 1 1 0 0 1 2 0m0 4a1 1 0 1 1-2 0 1 1 0 0 1 2 0m0 4a1 1 0 1 1-2 0 1 1 0 0 1 2 0"/></svg>
                            </div>
                        `;
                    }

                    html += `
                            <div class="w-6 h-6 rounded-full flex items-center justify-center bg-white border border-gray-300 shadow-sm shrink-0">
                                <span class="text-[10px] font-bold text-gray-600">${index + 1}</span>
                            </div>
                            <div class="flex-1 font-semibold text-gray-800 text-sm truncate select-none">
                                ${item.name}
                            </div>
                            <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${badgeColors[item.type] || 'bg-gray-200 text-gray-800'} whitespace-nowrap shrink-0">
                                ${labels[item.type] || '기타'}
                            </span>
                    `;

                    if (itineraryMode === 'edit') {
                        html += `
                            <button type="button" onclick="removeLocationFromItinerary(${i}, '${item.id}')" class="text-gray-300 hover:text-red-500 transition-colors p-1" title="삭제">
                                ✖
                            </button>
                        `;
                    } else if (itineraryMode === 'view-list') {
                       html += `<span class="text-gray-400 text-xs">➡️</span>`;
                    }

                    html += `</li>`;
                });

                html += `</ul>`;

                if (itineraryMode === 'edit') {
                    html += `
                        <div class="mt-2 flex gap-2 w-full">
                            <div onclick="jumpToMapForAdding()" class="flex-1 border border-dashed border-blue-200 rounded-lg py-2.5 flex flex-col sm:flex-row items-center justify-center gap-1.5 cursor-pointer hover:bg-blue-50 transition-colors group">
                                <span class="text-blue-400 font-bold group-hover:text-blue-500 text-sm leading-none">➕</span>
                                <span class="text-sm font-semibold text-blue-500 group-hover:text-blue-600 leading-none truncate">지도에서 추가</span>
                            </div>
                            <div onclick="openMultiAddModal(${i})" class="flex-1 border border-dashed border-green-200 rounded-lg py-2.5 flex flex-col sm:flex-row items-center justify-center gap-1.5 cursor-pointer hover:bg-green-50 transition-colors group">
                                <span class="text-green-400 font-bold group-hover:text-green-500 text-sm leading-none">📋</span>
                                <span class="text-sm font-semibold text-green-500 group-hover:text-green-600 leading-none truncate">리스트 다중 추가</span>
                            </div>
                        </div>
                    `;
                }

                html += `
                        </div>
                    </div>
                `;
            }

            if (itineraryMode === 'edit') {
                html += `
                    <button onclick="addNewDayToItinerary()" class="mt-2 w-full py-4 border-2 border-dashed border-gray-300 rounded-xl text-gray-500 hover:text-gray-700 hover:bg-gray-50 hover:border-gray-400 font-bold flex items-center justify-center gap-2 transition-colors shrink-0">
                        ➕ Day 추가하기
                    </button>
                `;
            }

            html += `</div>`;
            container.innerHTML = html;

            document.querySelectorAll('.itinerary-sortable-list').forEach(listEl => {
                const inst = new Sortable(listEl, {
                    group: 'itinerary',
                    handle: '.drag-handle',
                    animation: 150,
                    ghostClass: 'opacity-50',
                    disabled: itineraryMode !== 'edit',
                    onEnd: function () {
                        updateItineraryFromDOM();
                    }
                });
                sortableInstances.push(inst);
            });
        };

        const updateItineraryFromDOM = () => {
            if (!activeTripId) return;
            const targetTrip = trips.find(t => t.id === activeTripId);
            if (!targetTrip) return;

            const nextDays = [];
            document.querySelectorAll('.itinerary-sortable-list').forEach(listEl => {
                const items = [];
                listEl.querySelectorAll('li').forEach(li => {
                    items.push({
                        id: li.getAttribute('data-id'),
                        name: li.querySelector('.truncate').innerText.trim(),
                        type: li.getAttribute('data-type')
                    });
                });
                nextDays.push({ items: items });
            });
            targetTrip.days = nextDays;
            saveTrips();
            
            setTimeout(() => rebuildItineraryUI(), 50);
        };