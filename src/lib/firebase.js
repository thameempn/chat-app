import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";

// Web app's Firebase configuration
const firebaseConfig = {
  apiKey: import.meta.env.VITE_API_KEY,
  authDomain: "reactchat-966ff.firebaseapp.com",
  projectId: "reactchat-966ff",
  storageBucket: "reactchat-966ff.appspot.com",
  messagingSenderId: "244036065567",
  appId: "1:244036065567:web:816bb82540106caa5b782a",
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

export const auth = getAuth();
export const db = getFirestore();
export const storage = getStorage();
