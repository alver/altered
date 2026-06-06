// cards.js — Card database loading, stat/cost helpers, and the ability registry.
//
// Conventions:
//   • A player's `deck` is an array whose LAST element is the TOP (deck.pop() draws).
//   • A "card" is a plain object cloned from the DB with a unique `uid`.
//   • A character in play is a "charState": { card, exhausted, boosts, fleeting,
//     anchored, asleep, expedition, enteredDay }. A boost counter is +1/+1/+1.

const CardManager = (() => {
  const TERRAINS = ['forest', 'mountain', 'water'];
  let cardDb = {};
  let uidCounter = 0;

  // ─── DATA LOADING ──────────────────────────────────────────────
  async function loadCards() {
    const res = await fetch('data/cards.json');
    if (!res.ok) throw new Error(`Failed to load card DB: ${res.status}`);
    cardDb = await res.json();
    return cardDb;
  }
  async function loadDeck(file) {
    const res = await fetch(file);
    if (!res.ok) throw new Error(`Failed to load deck ${file}: ${res.status}`);
    return res.json();
  }
  async function loadManifest() {
    const res = await fetch('data/decks.json');
    if (!res.ok) throw new Error(`Failed to load deck manifest: ${res.status}`);
    return (await res.json()).decks;
  }
  function getCard(id) { return cardDb[String(id)] || null; }

  function instantiate(base) { return { ...base, uid: ++uidCounter }; }

  /** Expand a deck list into shuffled-ready card instances (Hero excluded). */
  function buildDeckInstances(deckData) {
    const cards = [];
    for (const e of deckData.cards) {
      const base = cardDb[String(e.id)];
      if (!base) throw new Error(`Unknown card id in deck: ${e.id}`);
      for (let i = 0; i < e.count; i++) cards.push(instantiate(base));
    }
    return cards;
  }

  // Token art, keyed by token name. Tokens are never in a deck, so they're not
  // in cards.json / assets via the deck path — the generator copies these refs
  // explicitly (keep in sync with TOKEN_ART in tools/generate_data.py). Resolving
  // by name here covers every creation path (scripts.js AND the auto-detected
  // create_token handler), so a token always carries its art.
  const TOKEN_ART = {
    'Brassbug':      'assets/cards/ALT_CORE_B_AX_31_C.jpg',
    'Booda':         'assets/cards/ALT_CORE_B_BR_31_C.jpg',
    'Ordis Recruit': 'assets/cards/ALT_CORE_B_OR_31_C.jpg',
  };

  function makeToken(def) {
    return instantiate({
      id: 'token:' + def.name, name: def.name, type: 'character',
      token: true, subtypes: def.subtype ? [def.subtype] : [],
      handCost: 0, reserveCost: 0,
      forest: def.forest, mountain: def.mountain, water: def.water,
      text: '', rawEffect: '', ability: {}, fleeting: false,
      image: def.image || TOKEN_ART[def.name] || null,
    });
  }

  // ─── IMAGE PRELOAD ─────────────────────────────────────────────
  async function preloadImages(cards) {
    const srcs = [...new Set(cards.map(c => c.image).filter(Boolean))];
    await Promise.all(srcs.map(src => new Promise(res => {
      const img = new Image(); img.onload = img.onerror = res; img.src = src;
    })));
  }

  // ─── DECK PRIMITIVES ───────────────────────────────────────────
  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
  /** Draw n cards; reshuffles discard into the deck when it runs out. */
  function drawCards(player, n, log) {
    const drawn = [];
    for (let i = 0; i < n; i++) {
      if (player.deck.length === 0) {
        if (player.discard.length === 0) break;
        player.deck = shuffle(player.discard.splice(0));
        if (log) log(`${player.isHuman ? 'You reshuffle' : player.name + ' reshuffles'} the discard into the deck.`, 'system');
      }
      drawn.push(player.deck.pop());
    }
    player.hand.push(...drawn);
    return drawn;
  }

  // ─── STATS / COST ──────────────────────────────────────────────
  function isCharacter(card) { return card.type === 'character'; }
  function hasSubtype(card, s) { return (card.subtypes || []).includes(s); }

  /** Effective value of one terrain stat (base + boost counters). */
  function stat(cs, terrain) { return Math.max(0, (cs.card[terrain] || 0) + (cs.boosts || 0)); }
  function statline(cs) { return TERRAINS.map(t => stat(cs, t)); }
  function power(cs) { return TERRAINS.reduce((s, t) => s + stat(cs, t), 0); }

  /** Cost to play a card from a given zone. */
  function playCost(card, fromReserve) { return fromReserve ? (card.reserveCost || 0) : (card.handCost || 0); }
  function readyMana(p) { return p.mana.filter(o => !o.exhausted).length; }
  function totalMana(p) { return p.mana.length; }
  function canAfford(card, p, fromReserve) { return readyMana(p) >= playCost(card, fromReserve); }
  function spendMana(p, n) {
    const ready = p.mana.filter(o => !o.exhausted);
    if (ready.length < n) return false;
    for (let i = 0; i < n; i++) ready[i].exhausted = true;
    return true;
  }

  // ─── ABILITY REGISTRY ──────────────────────────────────────────
  // Handler: async (ctx) => {}, ctx = { card, self, controller, opponent, api, agent, state }.
  const HANDLERS = {};
  const register = (code, fn) => { HANDLERS[code] = fn; };
  const getHandler = (code) => HANDLERS[code];

  register('resupply', async (ctx) => {
    const p = ctx.controller;
    if (p.deck.length === 0 && p.discard.length === 0) return;
    if (p.deck.length === 0) { p.deck = shuffle(p.discard.splice(0)); }
    const c = p.deck.pop();
    p.reserve.push(c);
    ctx.api.log(`${ctx.api.who(p)} resupply${p.isHuman ? '' : 's'} (top card → Reserve).`, 'action');
  });

  register('draw', async (ctx, params) => {
    const drawn = ctx.api.draw(ctx.controller, params.n || 1);
    if (drawn.length) ctx.api.log(`${ctx.api.who(ctx.controller)} draw${ctx.controller.isHuman ? '' : 's'} ${drawn.length} card${drawn.length === 1 ? '' : 's'}.`, 'draw');
  });

  register('gain_boost', async (ctx, params) => {
    if (!ctx.self) return;
    ctx.self.boosts = (ctx.self.boosts || 0) + (params.n || 1);
    ctx.api.log(`${ctx.card.name} gains ${params.n || 1} boost.`, 'action');
  });

  register('create_token', async (ctx, params) => {
    const def = params.token;
    const which = await ctx.agent.chooseExpedition({
      card: ctx.card, player: ctx.controller,
      prompt: `Create ${def.name} ${def.forest}/${def.mountain}/${def.water} in which Expedition?`,
    });
    await ctx.api.createToken(ctx.controller, def, which || 'hero');
    ctx.api.log(`${ctx.api.who(ctx.controller)} creates a ${def.name} ${def.forest}/${def.mountain}/${def.water} token.`, 'action');
  });

  return {
    TERRAINS, TOKEN_ART,
    loadCards, loadDeck, loadManifest, getCard, instantiate, buildDeckInstances,
    makeToken, preloadImages, shuffle, drawCards,
    isCharacter, hasSubtype, stat, statline, power,
    playCost, readyMana, totalMana, canAfford, spendMana,
    register, getHandler,
  };
})();
