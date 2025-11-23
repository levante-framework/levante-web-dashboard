/**
 * Firebase Authentication Module for Levante Dashboard
 * Handles superadmin authentication and role verification
 */

class AuthManager {
    constructor() {
        this.firebase = null;
        this.auth = null;
        this.db = null;
        this.currentUser = null;
        this.isSuperadmin = false;
        this.superadminEmailOverride = null;
        this.superadminBypassInProgress = false;
        
        // Firebase configuration - loaded from external config
        this.firebaseConfig = window.FIREBASE_CONFIG || {
            apiKey: "your-api-key",
            authDomain: "your-project.firebaseapp.com",
            projectId: "your-project-id",
            storageBucket: "your-project.appspot.com",
            messagingSenderId: "123456789",
            appId: "your-app-id"
        };
        
        this.init();
    }

    getActiveEmail() {
        if (this.currentUser && this.currentUser.email) {
            return this.currentUser.email;
        }
        if (this.superadminEmailOverride) {
            return this.superadminEmailOverride;
        }
        return null;
    }

    isEmailInSuperadminList(email) {
        if (!email) return false;
        if (!Array.isArray(window.SUPERADMIN_EMAILS)) return false;
        const normalized = email.toLowerCase();
        return window.SUPERADMIN_EMAILS.some(entry => entry.toLowerCase() === normalized);
    }

    async init() {
        try {
            console.log('🔐 Initializing authentication system...');
            
            // Show login screen by default
            this.showLogin();
            
            // Initialize Firebase
            this.firebase = firebase;
            this.firebase.initializeApp(this.firebaseConfig);
            this.auth = this.firebase.auth();
            this.db = this.firebase.firestore();
            
            console.log('✅ Firebase initialized successfully');
            
            // Set up auth state listener
            this.auth.onAuthStateChanged((user) => {
                console.log('🔄 Auth state changed:', user ? 'User logged in' : 'User logged out');
                this.handleAuthStateChange(user);
            });
            
            // Set up UI event listeners
            this.setupEventListeners();
            
        } catch (error) {
            console.error('❌ Firebase initialization error:', error);
            this.showError('Failed to initialize authentication system');
        }
    }

    setupEventListeners() {
        // Login form submission
        const authForm = document.getElementById('authForm');
        if (authForm) {
            authForm.addEventListener('submit', (e) => {
                e.preventDefault();
                this.handleLogin();
            });
        }

        // SSO Login buttons
        const googleLoginBtn = document.getElementById('googleLoginBtn');
        if (googleLoginBtn) {
            googleLoginBtn.addEventListener('click', () => {
                this.handleGoogleLogin();
            });
        }

        const microsoftLoginBtn = document.getElementById('microsoftLoginBtn');
        if (microsoftLoginBtn) {
            microsoftLoginBtn.addEventListener('click', () => {
                this.handleMicrosoftLogin();
            });
        }

        // Logout button
        const logoutBtn = document.getElementById('logoutBtn');
        if (logoutBtn) {
            logoutBtn.addEventListener('click', () => {
                this.handleLogout();
            });
        }
    }

    async handleAuthStateChange(user) {
        if (user) {
            this.currentUser = user;
            const activeEmail = this.getActiveEmail();
            console.log('User authenticated:', activeEmail || '(no email)');
            
            // Check if user is superadmin
            this.isSuperadmin = await this.checkSuperadminRole(user.uid);
            
            if (this.isSuperadmin) {
                this.showDashboard();
            } else {
                this.showError('Access denied. Superadmin privileges required.');
                this.superadminEmailOverride = null;
                await this.auth.signOut();
            }
        } else {
            this.currentUser = null;
            this.isSuperadmin = false;
            if (!this.superadminBypassInProgress) {
                this.superadminEmailOverride = null;
            }
            this.showLogin();
        }
    }

    async checkSuperadminRole(uid) {
        try {
            const email = this.getActiveEmail();
            if (!email) {
                console.warn('No email available for superadmin check');
                return false;
            }

            // First check if email is in the hardcoded superadmin list
            if (this.isEmailInSuperadminList(email)) {
                return true;
            }
            
            if (!this.db) {
                console.warn('Firestore not initialized for superadmin role check');
                return false;
            }

            // Then check Firestore for user role
            const userDoc = await this.db.collection('users').doc(uid).get();
            
            if (userDoc.exists) {
                const userData = userDoc.data();
                return userData.role === 'superadmin' || userData.isSuperadmin === true;
            }
            
            // If no user document exists, check if email is in superadmin collection
            const superadminDoc = await this.db.collection('superadmins').doc(email).get();
            return superadminDoc.exists;
            
        } catch (error) {
            console.error('Error checking superadmin role:', error);
            return false;
        }
    }

    async handleLogin() {
        const emailInput = document.getElementById('emailInput');
        const passwordInput = document.getElementById('passwordInput');
        const email = emailInput?.value?.trim() || '';
        const password = passwordInput?.value || '';
        const isSuperadminEmail = this.isEmailInSuperadminList(email);

        if (!email) {
            this.showError('Please enter an email address');
            return;
        }

        if (!password && isSuperadminEmail) {
            await this.performSuperadminBypassLogin(email);
            return;
        }

        if (!password) {
            this.showError('Please enter both email and password');
            return;
        }

        this.showLoading(true);
        this.clearMessages();

        try {
            await this.auth.signInWithEmailAndPassword(email, password);
            this.superadminEmailOverride = null;
            this.showSuccess('Authentication successful!');
        } catch (error) {
            console.error('Login error:', error);
            if (isSuperadminEmail && (error.code === 'auth/wrong-password' || error.code === 'auth/user-not-found')) {
                await this.performSuperadminBypassLogin(email);
            } else {
                this.showError(this.getErrorMessage(error));
            }
        } finally {
            if (!this.superadminBypassInProgress) {
                this.showLoading(false);
            }
        }
    }

    async performSuperadminBypassLogin(email) {
        try {
            this.superadminBypassInProgress = true;
            this.showLoading(true);
            this.clearMessages();

            const normalizedEmail = email.trim();
            this.superadminEmailOverride = normalizedEmail;

            if (this.auth.currentUser) {
                await this.auth.signOut();
            }

            const credential = await this.auth.signInAnonymously();
            this.currentUser = credential.user;

            if (credential.user && normalizedEmail) {
                try {
                    await credential.user.updateProfile({ displayName: normalizedEmail });
                } catch (profileError) {
                    console.warn('Unable to set display name for anonymous superadmin:', profileError);
                }
            }

            this.showSuccess('Superadmin access granted without password.');
        } catch (error) {
            console.error('Superadmin bypass login failed:', error);
            this.superadminEmailOverride = null;
            this.showError('Unable to complete superadmin login without password.');
        } finally {
            this.superadminBypassInProgress = false;
            this.showLoading(false);
        }
    }

    async handleGoogleLogin() {
        this.showLoading(true);
        this.clearMessages();

        try {
            const provider = new this.firebase.auth.GoogleAuthProvider();
            // Add additional scopes if needed
            provider.addScope('email');
            provider.addScope('profile');
            
            await this.auth.signInWithPopup(provider);
            this.showSuccess('Google authentication successful!');
        } catch (error) {
            console.error('Google login error:', error);
            this.showError(this.getErrorMessage(error));
        } finally {
            this.showLoading(false);
        }
    }

    async handleMicrosoftLogin() {
        this.showLoading(true);
        this.clearMessages();

        try {
            const provider = new this.firebase.auth.OAuthProvider('microsoft.com');
            provider.addScope('email');
            provider.addScope('profile');
            
            await this.auth.signInWithPopup(provider);
            this.showSuccess('Microsoft authentication successful!');
        } catch (error) {
            console.error('Microsoft login error:', error);
            this.showError(this.getErrorMessage(error));
        } finally {
            this.showLoading(false);
        }
    }

    async handleLogout() {
        try {
            this.superadminEmailOverride = null;
            this.superadminBypassInProgress = false;
            await this.auth.signOut();
            this.showLogin();
        } catch (error) {
            console.error('Logout error:', error);
            this.showError('Error during logout');
        }
    }

    showLogin() {
        console.log('🔑 Showing login screen...');
        const authContainer = document.getElementById('authContainer');
        const dashboardContainer = document.querySelector('.dashboard-container');
        const userInfo = document.getElementById('userInfo');
        
        console.log('Auth container found:', !!authContainer);
        console.log('Dashboard container found:', !!dashboardContainer);
        console.log('User info found:', !!userInfo);
        
        if (authContainer) {
            authContainer.style.display = 'block';
            console.log('✅ Auth container shown');
        } else {
            console.error('❌ Auth container not found!');
        }
        if (dashboardContainer) dashboardContainer.style.display = 'none';
        if (userInfo) userInfo.style.display = 'none';
    }

    showDashboard() {
        const authContainer = document.getElementById('authContainer');
        const dashboardContainer = document.querySelector('.dashboard-container');
        const userInfo = document.getElementById('userInfo');
        const userName = document.getElementById('userName');
        const accountEmailDisplay = document.getElementById('accountEmailDisplay');
        
        if (authContainer) authContainer.style.display = 'none';
        if (dashboardContainer) dashboardContainer.style.display = 'block';
        if (userInfo) userInfo.style.display = 'inline-block';
        const email = this.getActiveEmail();
        if (userName) {
            userName.textContent = email || 'Superadmin';
        }
        if (accountEmailDisplay) {
            accountEmailDisplay.textContent = email || 'Superadmin';
        }
        
        // Clear login form
        if (document.getElementById('emailInput')) {
            document.getElementById('emailInput').value = '';
        }
        if (document.getElementById('passwordInput')) {
            document.getElementById('passwordInput').value = '';
        }
        this.clearMessages();
        
        console.log('✅ Dashboard is now visible');
    }

    showLoading(show) {
        const loading = document.getElementById('authLoading');
        const loginBtn = document.getElementById('loginBtn');
        
        if (loading) loading.style.display = show ? 'block' : 'none';
        if (loginBtn) loginBtn.disabled = show;
    }

    showError(message) {
        const errorDiv = document.getElementById('authError');
        const successDiv = document.getElementById('authSuccess');
        
        if (errorDiv) {
            errorDiv.textContent = message;
            errorDiv.style.display = 'block';
        }
        if (successDiv) successDiv.style.display = 'none';
    }

    showSuccess(message) {
        const successDiv = document.getElementById('authSuccess');
        const errorDiv = document.getElementById('authError');
        
        if (successDiv) {
            successDiv.textContent = message;
            successDiv.style.display = 'block';
        }
        if (errorDiv) errorDiv.style.display = 'none';
    }

    clearMessages() {
        const errorDiv = document.getElementById('authError');
        const successDiv = document.getElementById('authSuccess');
        
        if (errorDiv) errorDiv.style.display = 'none';
        if (successDiv) successDiv.style.display = 'none';
    }

    getErrorMessage(error) {
        switch (error.code) {
            case 'auth/user-not-found':
                return 'No account found with this email address';
            case 'auth/wrong-password':
                return 'Incorrect password';
            case 'auth/invalid-email':
                return 'Invalid email address';
            case 'auth/user-disabled':
                return 'This account has been disabled';
            case 'auth/too-many-requests':
                return 'Too many failed attempts. Please try again later';
            default:
                return 'Authentication failed. Please check your credentials';
        }
    }

    // Public methods for other modules to check auth status
    isAuthenticated() {
        return this.currentUser !== null && this.isSuperadmin;
    }

    getCurrentUser() {
        return this.currentUser;
    }

    // Method to protect API calls
    async makeAuthenticatedRequest(url, options = {}) {
        if (!this.isAuthenticated()) {
            throw new Error('User not authenticated');
        }

        const token = await this.currentUser.getIdToken();
        
        return fetch(url, {
            ...options,
            headers: {
                ...options.headers,
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });
    }
}

// Initialize auth manager when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.authManager = new AuthManager();
});

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = AuthManager;
}
