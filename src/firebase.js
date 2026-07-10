import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
    apiKey: "AIzaSyC4FcjFosdCMxWnPAeMe_ObZPDShnHZy2E",
    authDomain: "gen-lang-client-0142372615.firebaseapp.com",
    projectId: "gen-lang-client-0142372615",
    storageBucket: "gen-lang-client-0142372615.firebasestorage.app",
    messagingSenderId: "115950049911",
    appId: "1:115950049911:web:4da94cec4b908429c78472",
    measurementId: "G-5VJSHY37WP"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);