/**
 * Firebase Configuration for Levante Dashboard
 * Update these values with your actual Firebase project configuration
 */

const FIREBASE_CONFIG = {
    // hs-levante-admin-dev Firebase project configuration
    // Retrieved from levante-dashboard/src/config/firebaseLevante.js
    apiKey: "AIzaSyCOzRA9a2sDHtVlX7qnszxrgsRCBLyf5p0",
    authDomain: "hs-levante-admin-dev.firebaseapp.com", 
    projectId: "hs-levante-admin-dev",
    storageBucket: "hs-levante-admin-dev.appspot.com",
    messagingSenderId: "41590333418",
    appId: "1:41590333418:web:3468a7caadab802d6e5c93"
};

// Superadmin email list (alternative to Firestore role checking)
const SUPERADMIN_EMAILS = [
    "admin@levante.com",
    "superadmin@levante.com",
    "david81@stanford.edu",  // Your email for direct access
    "cuskley@stanford.edu",
    "aal@stanford.edu",
    "zdwatson@stanford.edu",
    "serlee@stanford.edu",
    "sachino@stanford.edu",
    "mcfrank@stanford.edu",
    "acardinal42@gmail.com"
    // Add more superadmin emails here if needed
];

// Export configuration
if (typeof window !== 'undefined') {
    window.FIREBASE_CONFIG = FIREBASE_CONFIG;
    window.SUPERADMIN_EMAILS = SUPERADMIN_EMAILS;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { FIREBASE_CONFIG, SUPERADMIN_EMAILS };
}
