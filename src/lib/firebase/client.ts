"use client";

/**
 * Firebase Web SDK init — client side only.
 *
 * Idempotent: reuses the existing [DEFAULT] app when one is already
 * initialized (Next.js HMR re-evaluates modules), with a guard that it
 * targets the same project. The checked-in defaults identify the production
 * `highquotahq214` project (reuse-audit §2 — external contract); the
 * NEXT_PUBLIC_FIREBASE_* env vars override them for previews.
 */

import { getApps, initializeApp, type FirebaseApp } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";
import { getFirestore, type Firestore } from "firebase/firestore";

export interface FirebaseClientConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
}

const DEFAULT_CONFIG: FirebaseClientConfig = {
  apiKey: "AIzaSyCklz28QDpVHdagTruIxlPc5hdi-fj6QxE",
  authDomain: "highquotahq214.firebaseapp.com",
  projectId: "highquotahq214",
  storageBucket: "highquotahq214.firebasestorage.app",
  messagingSenderId: "224586017261",
  appId: "1:224586017261:web:86d75e8878e42209a4dfe4",
};

// Static process.env.NEXT_PUBLIC_* member access so Next.js can inline the
// values into the client bundle.
export const firebaseClientConfig: FirebaseClientConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY || DEFAULT_CONFIG.apiKey,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || DEFAULT_CONFIG.authDomain,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || DEFAULT_CONFIG.projectId,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || DEFAULT_CONFIG.storageBucket,
  messagingSenderId:
    process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || DEFAULT_CONFIG.messagingSenderId,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID || DEFAULT_CONFIG.appId,
};

/** The shared client app; initializes on first use. */
export function getFirebaseClientApp(): FirebaseApp {
  const existing = getApps().find((app) => app.name === "[DEFAULT]");
  if (existing) {
    if (existing.options.projectId !== firebaseClientConfig.projectId) {
      throw new Error(
        "The existing Firebase client app targets a different project than HQHQ Wiki.",
      );
    }
    return existing;
  }
  return initializeApp(firebaseClientConfig);
}

/** Firebase Auth bound to the shared client app. */
export function getFirebaseAuth(): Auth {
  return getAuth(getFirebaseClientApp());
}

/**
 * Client Firestore — used only for account forms (username → email lookup,
 * profile creation). Authorization always comes from the server response.
 */
export function getFirebaseFirestore(): Firestore {
  return getFirestore(getFirebaseClientApp());
}
