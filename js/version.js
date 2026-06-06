// version.js — shared constants, loaded first.
// Bump GAME_VERSION whenever the saved-data format changes to force a clean reset.
const GAME_VERSION = '0.1.0';
const STORAGE_KEY = 'altered-deck-choice';
const STORAGE_VERSION_KEY = 'altered-version';

try {
  if (localStorage.getItem(STORAGE_VERSION_KEY) !== GAME_VERSION) {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.setItem(STORAGE_VERSION_KEY, GAME_VERSION);
  }
} catch (_) { /* localStorage unavailable (file://) — ignore */ }
