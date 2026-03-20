module.exports = function (req, res) {
  // CORS 처리 (필요에 따라 Vercel에서는 자동 지원될 수 있으나 명시적 추가)
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  res.status(200).json({
    apiKey: process.env.VITE_FIREBASE_API_KEY,
    authDomain: "subak-map.firebaseapp.com",
    projectId: "subak-map",
    storageBucket: "subak-map.firebasestorage.app",
    messagingSenderId: "368910159844",
    appId: "1:368910159844:web:148b22d919b29048af81f1"
  });
};
