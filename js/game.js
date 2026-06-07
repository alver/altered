// game.js — Core Altered game engine.
//
// Drives the Day cycle (Morning / Noon / Afternoon / Dusk / Night), Mana Orbs,
// Hand / Reserve / Expeditions / Landmarks / Deck / Discard, the Dusk statistic
// race that advances Expedition markers along the shared 8-region Tumult track,
// Night rest & cleanup, and the win-by-meeting condition.
//
// Human and bot drive the SAME internal actions; only their `.agent` differs.

const GameEngine = (() => {
  const CM = CardManager;
  const PHASES = {
    SETUP: 'setup', MORNING: 'morning', NOON: 'noon',
    AFTERNOON: 'afternoon', DUSK: 'dusk', NIGHT: 'night', GAME_OVER: 'game_over',
  };
  const TRACK_LEN = 8;            // regions 0..7; markers meet when heroPos >= compPos
  const T = CM.TERRAINS;

  let state = null;
  let onStateChange = null;
  let onEvent = null;
  let lastLogIndex = 0;
  let humanResolver = null;       // resolves the in-progress human Afternoon action

  const delay = (ms) => new Promise(r => setTimeout(r, ms));

  // ─── CONSTRUCTION ──────────────────────────────────────────────
  function createPlayer(isHuman) {
    return {
      isHuman, name: isHuman ? 'You' : 'Opponent', agent: null,
      faction: '', factionName: '', hero: null,
      deck: [], hand: [], discard: [], reserve: [], landmarks: [],
      heroExp: [], compExp: [], mana: [],
      heroDist: 0, compDist: 0, passed: false, heroExhausted: false,
      reserveLimit: 2, landmarkLimit: 2, playedCharThisAfternoon: false,
      // Transient "next card you play this turn …" Support modifiers (cost cuts,
      // boosts). Set by a Reserve Support ability; consumed on the matching play;
      // any leftover is cleared at the end of the player's turn.
      pendingMods: [],
    };
  }

  function makeChar(card, opts = {}) {
    return {
      card, exhausted: false, boosts: 0, counters: {},
      fleeting: !!opts.fleeting, anchored: false, asleep: !!opts.asleep,
      expedition: opts.expedition || 'hero', enteredDay: state ? state.day : 1,
    };
  }

  async function setupGame({ changeCallback, eventHook, humanDeckFile, botDeckFile, humanAgent, botAgent }) {
    onStateChange = changeCallback; onEvent = eventHook; lastLogIndex = 0;

    await CM.loadCards();
    const [hd, bd] = await Promise.all([CM.loadDeck(humanDeckFile), CM.loadDeck(botDeckFile)]);

    const you = createPlayer(true), opp = createPlayer(false);
    for (const [p, d] of [[you, hd], [opp, bd]]) {
      p.faction = d.faction; p.factionName = d.factionName;
      p.hero = CM.instantiate(CM.getCard(d.hero));
      p.reserveLimit = p.hero.reserveLimit ?? 2;
      p.landmarkLimit = p.hero.landmarkLimit ?? 2;
      p.deck = CM.buildDeckInstances(d);
      CM.shuffle(p.deck);
    }
    you.agent = humanAgent; opp.agent = botAgent;
    opp.name = bd.factionName;

    const tokenArt = Object.values(CM.TOKEN_ART).map(image => ({ image }));
    await CM.preloadImages([...you.deck, ...opp.deck, you.hero, opp.hero, ...tokenArt]);

    const youFirst = Math.random() < 0.5;
    state = {
      you, opp, current: null, firstPlayer: youFirst ? you : opp,
      day: 1, phase: PHASES.SETUP, busy: true, awaitingHuman: false,
      winner: null, log: [], track: buildTrack(), api: null,
    };
    state.api = buildApi();
    addLog(`A new journey begins. ${who(state.firstPlayer)} ${state.firstPlayer.isHuman ? 'are' : 'is'} the First Player.`, 'system');
    notify();
    return state;
  }

  // ─── TUMULT TRACK ──────────────────────────────────────────────
  // 8 regions: [Hero Region] [t][t][t][t][t][t] [Companion Region].
  // Three Tumults (V|MO, M|VO, O|VM), shuffled & randomly flipped, fill 1..6.
  // Real Adventure cards (extracted from the Print&Play accessories PDF). Each
  // Tumult card spans two track positions (its single-type half and double-type
  // half); a random flip decides which half faces the Hero side.
  function buildTrack() {
    const all3 = ['forest', 'mountain', 'water'];
    const tumults = [
      { halves: [['forest'], ['mountain', 'water']], image: 'assets/adventure/tumult1_wide.png' },
      { halves: [['mountain'], ['forest', 'water']], image: 'assets/adventure/tumult2_wide.png' },
      { halves: [['water'], ['forest', 'mountain']], image: 'assets/adventure/tumult3_wide.png' },
    ];
    CM.shuffle(tumults);
    const regions = [{ types: all3, faceUp: true, label: 'Hero Region' }];
    const cards = [{ kind: 'hero', image: 'assets/adventure/hero_wide.png', positions: [0] }];
    let pos = 1;
    for (const t of tumults) {
      const flip = Math.random() < 0.5;
      const halves = flip ? [t.halves[1], t.halves[0]] : [t.halves[0], t.halves[1]];
      regions.push({ types: halves[0], faceUp: false, label: 'Tumult' });
      regions.push({ types: halves[1], faceUp: false, label: 'Tumult' });
      cards.push({ kind: 'tumult', image: t.image, back: 'assets/adventure/tumult_back.png', flip, positions: [pos, pos + 1] });
      pos += 2;
    }
    regions.push({ types: all3, faceUp: true, label: 'Companion Region' });
    cards.push({ kind: 'companion', image: 'assets/adventure/companion_wide.png', positions: [7] });
    return { regions, cards };
  }
  function regionTypesAt(pos) { return state.track.regions[pos].types; }
  function heroPos(p) { return p.heroDist; }
  function compPos(p) { return (TRACK_LEN - 1) - p.compDist; }
  function reveal(pos) {
    const r = state.track.regions[pos];
    if (!r.faceUp) { r.faceUp = true; addLog(`A Tumult region is revealed: ${r.types.map(cap).join('/')}.`, 'system'); }
  }
  const cap = (s) => s[0].toUpperCase() + s.slice(1);

  // ─── LOG / NOTIFY ──────────────────────────────────────────────
  function addLog(message, type = 'action') { state.log.push({ message, type, t: Date.now() }); }
  function notify() {
    if (!onStateChange) return;
    const fresh = state.log.slice(lastLogIndex);
    lastLogIndex = state.log.length;
    onStateChange(state, fresh);
  }
  async function emit(evt) { if (onEvent) await onEvent(evt); }
  function who(p) { return p.isHuman ? 'You' : p.name; }
  function verb(p, v) { return p.isHuman ? `You ${v}` : `${p.name} ${v}s`; }
  function opponentOf(p) { return p === state.you ? state.opp : state.you; }
  function isGameOver() { return state.phase === PHASES.GAME_OVER || !!state.winner; }

  // ─── KEYWORDS: Gigantic / Tough ────────────────────────────────
  function isGigantic(card) { return !!(card.keywords && card.keywords.gigantic); }
  // Tough granted by a controller's Landmarks (e.g. The Spindle's aura).
  function auraTough(p) {
    let n = 0;
    for (const l of p.landmarks) {
      const sc = CardScripts.get(l.card.id);
      if (sc && sc.aura && sc.aura.toughControlled) n += sc.aura.toughControlled;
    }
    return n;
  }
  // Total cost an opponent pays to target this Character (intrinsic keyword + auras).
  function toughOf(card, owner) {
    return ((card.keywords && card.keywords.tough) || 0) + (owner ? auraTough(owner) : 0);
  }
  // Defender: a Character whose Expedition can't move forward at Dusk. A script can
  // declare it conditionally via `defender(ctx) => bool` (Monolith Archivist).
  function isDefender(cs, owner) {
    const sc = CardScripts.get(cs.card.id);
    if (!sc || !sc.defender) return false;
    try { return !!sc.defender(ctxFor(cs.card, cs, owner, null)); } catch (_) { return false; }
  }
  function expeditionHasDefender(p, which) {
    return (which === 'hero' ? p.heroExp : p.compExp).some(cs => isDefender(cs, p));
  }

  // ─── DICE (LYRA) ───────────────────────────────────────────────
  // A player rolls one or more d6. The Ouroboros, Lyra Bastion (a Landmark whose
  // script carries `diceMod:'ouroboros'`) adds one die to every roll and lets the
  // player ignore the result of their choice — modelled by rolling n+1 and asking
  // the agent which `n` to keep.
  function hasDiceMod(p) {
    for (const l of p.landmarks) {
      const sc = CardScripts.get(l.card.id);
      if (sc && sc.diceMod === 'ouroboros') return true;
    }
    return false;
  }
  async function rollDice(p, n = 1) {
    const extra = hasDiceMod(p) ? 1 : 0;
    const rolls = [];
    for (let i = 0; i < n + extra; i++) rolls.push(1 + Math.floor(Math.random() * 6));
    await emit({ type: 'dice', player: p, rolls });
    let kept;
    if (extra) {
      kept = await p.agent.chooseDie({ player: p, rolls, keep: n, prompt: 'The Ouroboros — choose which die to keep.' });
      if (!kept || kept.length !== n) kept = [...rolls].sort((a, b) => b - a).slice(0, n);  // safety
      addLog(`🎲 ${who(p)} ${p.isHuman ? 'roll' : 'rolls'} [${rolls.join(', ')}] (Ouroboros) → keep${p.isHuman ? '' : 's'} ${kept.join(', ')}.`, 'dusk');
    } else {
      kept = rolls;
      addLog(`🎲 ${who(p)} ${p.isHuman ? 'roll' : 'rolls'} ${rolls.join(', ')}.`, 'dusk');
    }
    return kept;
  }
  async function rollDie(p) { return (await rollDice(p, 1))[0]; }

  // ─── ABILITY API (for handlers & card scripts) ─────────────────
  function buildApi() {
    return {
      who, verb, log: addLog, notify, opponentOf, dispatch,
      readyMana: CM.readyMana, spendMana: CM.spendMana,
      isRobot: (card) => CM.hasSubtype(card, 'Robot'),
      draw: (p, n) => CM.drawCards(p, n, addLog),
      // Create a Character token in an Expedition and announce the join.
      async createToken(p, def, which) {
        const cs = makeChar(CM.makeToken(def), { expedition: which === 'companion' ? 'companion' : 'hero' });
        (cs.expedition === 'companion' ? p.compExp : p.heroExp).push(cs);
        await dispatch('characterJoins', { charState: cs, controller: p });
        return cs;
      },
      // Gather targetable cards as descriptors { uid, card, owner, zone, charState?/landmarkState?, toughCost }.
      // opts: { controller, side:'me'|'opp'|'any', zone:'reserve', kind:'character'|'permanent', maxHandCost, payable }
      // When the requester (opts.controller) targets an enemy Character, toughCost is
      // what they must pay; `payable` drops targets they can't currently afford.
      targets(opts) {
        const players = opts.side === 'me' ? [opts.controller]
          : opts.side === 'opp' ? [opponentOf(opts.controller)]
            : [opts.controller, opponentOf(opts.controller)];
        const okCost = (card) => (opts.maxHandCost == null || (card.handCost || 0) <= opts.maxHandCost)
          && (opts.minHandCost == null || (card.handCost || 0) >= opts.minHandCost);
        const out = [];
        for (const pl of players) {
          if (opts.zone === 'reserve') {
            for (const c of pl.reserve) if (okCost(c)) out.push({ uid: c.uid, card: c, owner: pl, zone: 'reserve', toughCost: 0 });
            continue;
          }
          if (!opts.kind || opts.kind === 'character') {
            for (const cs of [...pl.heroExp, ...pl.compExp]) {
              if (!okCost(cs.card)) continue;
              const toughCost = (opts.controller && pl !== opts.controller) ? toughOf(cs.card, pl) : 0;
              if (opts.payable && toughCost > CM.readyMana(opts.controller)) continue;
              out.push({ uid: cs.card.uid, card: cs.card, owner: pl, zone: 'expedition', charState: cs, toughCost });
            }
          }
          if (!opts.kind || opts.kind === 'permanent') {
            for (const l of pl.landmarks) if (okCost(l.card)) out.push({ uid: l.card.uid, card: l.card, owner: pl, zone: 'landmark', landmarkState: l, toughCost: 0 });
          }
        }
        return out;
      },
      // Choose a target and pay its Tough cost (if any). Returns the descriptor or null.
      async resolveTarget({ agent, requester, candidates, optional, prompt, intent }) {
        const t = await agent.chooseTarget({ candidates, optional, prompt, intent, player: requester });
        if (!t) return null;
        if (t.toughCost > 0) {
          const yes = await agent.confirm({ player: requester, prompt: `Pay ${t.toughCost}⚡ to target ${t.card.name} (Tough ${t.toughCost})?` });
          if (!yes) return null;
          CM.spendMana(requester, t.toughCost);
          addLog(`${who(requester)} ${requester.isHuman ? 'pay' : 'pays'} ${t.toughCost} to target ${t.card.name} (Tough).`, 'action');
        }
        return t;
      },
      async bounceToReserve(t) {
        const cs = t.charState, owner = t.owner;
        const arr = cs.expedition === 'companion' ? owner.compExp : owner.heroExp;
        const i = arr.indexOf(cs); if (i !== -1) arr.splice(i, 1);
        if (cs.card.token) addLog(`${cs.card.name} token is removed.`, 'action');
        else owner.reserve.push(cs.card);
        await fireLeaveExpedition(cs, owner);
      },
      destroyPermanent(t) {
        const owner = t.owner, i = owner.landmarks.indexOf(t.landmarkState);
        if (i !== -1) { owner.landmarks.splice(i, 1); owner.discard.push(t.card); }
      },
      // Hard-remove a Character to its owner's Discard (Banishing Gate). token → removed.
      async discardCharacter(t) {
        const cs = t.charState, owner = t.owner;
        const arr = cs.expedition === 'companion' ? owner.compExp : owner.heroExp;
        const i = arr.indexOf(cs); if (i !== -1) arr.splice(i, 1);
        if (cs.card.token) addLog(`${cs.card.name} token is removed.`, 'action');
        else owner.discard.push(cs.card);
        await fireLeaveExpedition(cs, owner);
      },
      // Push an Expedition marker back one region (Sakarabru). Floored at its start.
      moveExpeditionBackwards(p, which) {
        if (which === 'hero') { if (p.heroDist > 0) { p.heroDist--; return true; } }
        else { if (p.compDist > 0) { p.compDist--; return true; } }
        return false;
      },
      discardFromReserve(t) {
        const owner = t.owner, i = owner.reserve.indexOf(t.card);
        if (i !== -1) { owner.reserve.splice(i, 1); owner.discard.push(t.card); }
      },
      moveHandToReserve(p, card) {
        const i = p.hand.indexOf(card);
        if (i !== -1) { p.hand.splice(i, 1); p.reserve.push(card); }
      },
      // Return a card from a Reserve to its owner's hand (Hathor's Support).
      returnReserveToHand(p, card) {
        const i = p.reserve.indexOf(card);
        if (i !== -1) { p.reserve.splice(i, 1); p.hand.push(card); }
      },
      // Re-fire a Permanent's join ({J}) trigger (Jian's Support).
      async activateJoin(stateObj, p) { await runCardTrigger('join', stateObj, p); },
      // Return a Character or Permanent to its owner's hand (token → removed).
      async returnToHand(t) {
        const owner = t.owner;
        if (t.zone === 'expedition') {
          const cs = t.charState;
          const arr = cs.expedition === 'companion' ? owner.compExp : owner.heroExp;
          const i = arr.indexOf(cs); if (i !== -1) arr.splice(i, 1);
          if (cs.card.token) addLog(`${cs.card.name} token is removed.`, 'action');
          else owner.hand.push(cs.card);
          await fireLeaveExpedition(cs, owner);
        } else if (t.zone === 'landmark') {
          const i = owner.landmarks.indexOf(t.landmarkState);
          if (i !== -1) { owner.landmarks.splice(i, 1); owner.hand.push(t.card); }
        }
      },
      // Return a Character or Permanent to the TOP of its owner's deck (Paint Prison).
      async returnToTopOfDeck(t) {
        const owner = t.owner;
        if (t.zone === 'expedition') {
          const cs = t.charState;
          const arr = cs.expedition === 'companion' ? owner.compExp : owner.heroExp;
          const i = arr.indexOf(cs); if (i !== -1) arr.splice(i, 1);
          if (cs.card.token) addLog(`${cs.card.name} token is removed.`, 'action');
          else owner.deck.push(cs.card);                   // deck top = last element
          await fireLeaveExpedition(cs, owner);
        } else if (t.zone === 'landmark') {
          const i = owner.landmarks.indexOf(t.landmarkState);
          if (i !== -1) { owner.landmarks.splice(i, 1); owner.deck.push(t.card); }
        }
      },
      rollDie, rollDice, hasDiceMod,
    };
  }

  // A ctx for a card script handler. `self` is the in-play state object.
  function ctxFor(card, self, controller, event) {
    return { card, self, controller, opponent: opponentOf(controller),
      state, agent: controller.agent, api: state.api, event };
  }
  async function runScript(fn, card, controller, self, event) {
    await fn(ctxFor(card, self, controller, event));
  }
  async function runAbility(entry, card, controller, self) {
    const fn = CM.getHandler(entry.code);
    if (!fn) { addLog(`[unimplemented ability: ${entry.code}]`, 'system'); return; }
    await fn({ card, self, controller, opponent: opponentOf(controller),
      state, agent: controller.agent, api: state.api }, entry);
  }
  // A card script / ability threw mid-resolution. Surface it and keep playing —
  // a buggy ability is skipped, never bricks the turn (the play has committed).
  function reportAbilityError(card, e) {
    const name = card ? card.name : 'A card';
    addLog(`⚠ ${name}'s ability errored and was skipped (${(e && e.message) || e}).`, 'system');
    try { console.error(`[ability error: ${card && card.id}]`, e); } catch (_) {}
  }
  // Run a played card's on-play triggers, swallowing (but logging) any script
  // error so the play still stands instead of leaving a half-resolved state.
  async function fireTriggers(card, run) {
    try { await run(); } catch (e) { reportAbilityError(card, e); }
  }

  // ─── TRIGGERS & EVENT DISPATCH ─────────────────────────────────
  // A wrapper around the Hero so it can be exhausted / carry counters / react.
  function heroState(p) {
    if (!p._heroState) {
      p._heroState = {
        card: p.hero, isHero: true, counters: {},
        get exhausted() { return p.heroExhausted; },
        set exhausted(v) { p.heroExhausted = v; },
      };
    }
    return p._heroState;
  }
  function reactiveSources(p) {
    return [heroState(p), ...p.landmarks, ...p.heroExp, ...p.compExp];
  }
  // Notify every in-play card's reactive `on[type]` handler (First Player first).
  async function dispatch(type, payload) {
    const order = [state.firstPlayer, opponentOf(state.firstPlayer)];
    for (const p of order) {
      for (const src of reactiveSources(p)) {
        const sc = CardScripts.get(src.card.id);
        const h = sc && sc.on && sc.on[type];
        if (h) { await runScript(h, src.card, p, src, payload); notify(); await delay(120); }
      }
    }
  }
  // Run one trigger on a played card: script wins, else legacy ability.
  async function runCardTrigger(name, stateObj, p) {
    const card = stateObj.card;
    const sc = CardScripts.get(card.id);
    if (sc && sc[name]) { await runScript(sc[name], card, p, stateObj); notify(); await delay(150); return; }
    const e = card.ability && card.ability[name];
    if (e) { await runAbility(e, card, p, stateObj); notify(); await delay(150); }
  }
  // A Character has just left an Expedition (Night Rest, bounce, return-to-hand,
  // return-to-deck, …). Fire its "When I leave the Expedition zone" script, if any
  // (e.g. Jeanne d'Arc mustering Ordis Recruits). Guarded so it never bricks the flow.
  async function fireLeaveExpedition(cs, owner) {
    const sc = CardScripts.get(cs.card.id);
    if (!sc || !sc.onLeave) return;
    try { await runScript(sc.onLeave, cs.card, owner, cs); notify(); await delay(120); }
    catch (e) { reportAbilityError(cs.card, e); }
  }

  // Fire the on-play trigger sequence for a card entering play.
  async function firePlay(card, p, self, fromReserve, joinsPlay) {
    const sc = CardScripts.get(card.id);
    const ab = card.ability || {};
    const seq = [];
    if (joinsPlay) seq.push('join');
    seq.push(fromReserve ? 'reserve' : 'hand');
    seq.push('play');                              // script-only, fires from any zone
    for (const name of seq) {
      if (sc && sc[name]) { await runScript(sc[name], card, p, self); notify(); await delay(120); }
      else if (ab[name]) { await runAbility(ab[name], card, p, self); notify(); await delay(120); }
    }
  }
  // Exhaust/support quick actions available to player p right now.
  function availableQuickActions(p) {
    const out = [];
    // Exhaust abilities on the Hero and Landmarks (the card stays in play).
    for (const src of [heroState(p), ...p.landmarks]) {
      const sc = CardScripts.get(src.card.id);
      if (!sc || !sc.quickActions) continue;
      const acts = sc.quickActions(ctxFor(src.card, src, p, null)) || [];
      acts.forEach((a, i) => out.push({ sourceUid: src.card.uid, index: i, label: a.label, kind: a.kind, canRun: !!a.canRun, run: a.run }));
    }
    // Support abilities on cards in the Reserve. The script's support(ctx) returns
    // { label, canRun, effect, endsTurn? }; the engine pays the cost (discard the
    // card from Reserve) before running the effect. Some Supports (Alice's After You)
    // also end the turn — flagged via endsTurn for playerQuickAction to honour.
    for (const card of p.reserve) {
      const sc = CardScripts.get(card.id);
      if (!sc || !sc.support) continue;
      const a = sc.support(ctxFor(card, { card, zone: 'reserve' }, p, null));
      if (!a) continue;
      out.push({
        sourceUid: card.uid, index: 0, label: a.label, kind: 'support',
        canRun: !!a.canRun, endsTurn: !!a.endsTurn,
        run: async () => {
          const i = p.reserve.indexOf(card);
          if (i === -1) return;                                  // already gone
          p.reserve.splice(i, 1); p.discard.push(card);
          addLog(`${verb(p, 'discard')} ${card.name} from Reserve (Support).`, 'action');
          await a.effect();
        },
      });
    }
    return out;
  }

  // ─── DAY FLOW ──────────────────────────────────────────────────
  async function startGame() {
    // Setup: each player draws 6, puts 3 in their Mana zone, keeps 3 in hand.
    for (const p of [state.you, state.opp]) {
      CM.drawCards(p, 6, addLog);
      const picks = await p.agent.chooseManaCards({
        player: p, hand: p.hand, count: 3, optional: false,
        prompt: 'Choose 3 cards to place face-down as Mana Orbs. The other 3 are your starting hand.',
      });
      placeMana(p, picks);
      addLog(`${who(p)} set up ${picks.length} Mana Orbs and a hand of ${p.hand.length}.`, 'system');
      notify();
    }
    await runDay();
  }

  async function runDay() {
    if (isGameOver()) return;
    addLog(`— Day ${state.day} —`, 'phase');
    if (state.day > 1) await morning();
    if (isGameOver()) return;
    await noon();
    await afternoon();
    await dusk();
    await night();
    if (checkVictory()) { notify(); return; }
    state.day++;
    await runDay();
  }

  // ── Morning ──
  async function morning() {
    state.phase = PHASES.MORNING; state.busy = true; notify();
    state.firstPlayer = opponentOf(state.firstPlayer);
    addLog(`Morning of Day ${state.day}. First Player: ${who(state.firstPlayer)}.`, 'phase');
    for (const p of [state.you, state.opp]) {
      for (const o of p.mana) o.exhausted = false;
      for (const l of p.landmarks) l.exhausted = false;
      for (const cs of [...p.heroExp, ...p.compExp]) cs.exhausted = false;   // Anchored leftovers
      p.heroExhausted = false;
    }
    notify(); await delay(250);
    const order = [state.firstPlayer, opponentOf(state.firstPlayer)];
    for (const p of order) { CM.drawCards(p, 2, addLog); }
    addLog('Each player draws 2 cards.', 'draw'); notify();
    // Each player may add one card to their Mana zone (First Player first).
    for (const p of order) {
      if (p.hand.length === 0) continue;
      const picks = await p.agent.chooseManaCards({
        player: p, hand: p.hand, count: 1, optional: true,
        prompt: 'You may place one card from your hand into your Mana zone.',
      });
      if (picks && picks.length) { placeMana(p, picks); addLog(`${verb(p, 'add')} a Mana Orb. (${p.mana.length} total)`, 'mana'); notify(); }
    }
  }

  function placeMana(p, picks) {
    for (const c of picks) {
      const i = p.hand.indexOf(c);
      if (i !== -1) { p.hand.splice(i, 1); p.mana.push({ exhausted: false, card: c }); }
    }
  }

  // ── Noon ──
  async function noon() {
    state.phase = PHASES.NOON; state.busy = true; notify();
    addLog('Noon.', 'phase');
    const order = [state.firstPlayer, opponentOf(state.firstPlayer)];
    for (const p of order) {
      // "At Noon" abilities of the Hero, Landmarks, and Anchored characters.
      await runCardTrigger('atNoon', heroState(p), p);
      for (const l of [...p.landmarks]) await runCardTrigger('atNoon', l, p);
      for (const cs of [...p.heroExp, ...p.compExp]) await runCardTrigger('atNoon', cs, p);
    }
  }

  // ── Afternoon ──
  async function afternoon() {
    state.phase = PHASES.AFTERNOON;
    state.you.passed = false; state.opp.passed = false;
    state.you.playedCharThisAfternoon = false; state.opp.playedCharThisAfternoon = false;
    state.current = state.firstPlayer;
    addLog('Afternoon — players alternate, one card per turn.', 'phase');
    notify();
    while (!(state.you.passed && state.opp.passed)) {
      const p = state.current;
      if (p.passed) { state.current = opponentOf(p); continue; }
      if (p.isHuman) {
        state.busy = false; state.awaitingHuman = true; notify();
        await new Promise(res => { humanResolver = res; });
        humanResolver = null; state.awaitingHuman = false; state.busy = true; notify();
      } else {
        state.busy = true; notify();
        await delay(420);
        try { await BotAI.takeAfternoonTurn(state, PUBLIC); }
        catch (e) { reportAbilityError(null, e); notify(); }
      }
      p.pendingMods = [];                  // Support "this turn" mods don't carry to the next turn
      state.current = opponentOf(p);
    }
    addLog('Both players pass. Afternoon ends.', 'phase');
  }

  function resolveHuman() { if (humanResolver) humanResolver(); }

  // ── Dusk ──
  async function dusk() {
    state.phase = PHASES.DUSK; state.busy = true; notify();
    addLog('Dusk — comparing Expeditions.', 'phase');
    // "At Dusk" abilities (Hero, Landmarks, Expedition characters) fire first,
    // before any marker moves (e.g. Kadigiran Mage-Dancer's draw).
    const dorder = [state.firstPlayer, opponentOf(state.firstPlayer)];
    for (const p of dorder) {
      await runCardTrigger('atDusk', heroState(p), p);
      for (const l of [...p.landmarks]) await runCardTrigger('atDusk', l, p);
      for (const cs of [...p.heroExp, ...p.compExp]) await runCardTrigger('atDusk', cs, p);
    }
    await delay(300);
    // Compute every move from the pre-Dusk board (movement doesn't change stats).
    const order = [state.firstPlayer, opponentOf(state.firstPlayer)];
    const decisions = [];
    for (const p of order) for (const which of ['hero', 'companion']) {
      decisions.push({ p, which, move: evalMove(p, which) });
    }
    for (const d of decisions) {
      if (!d.move) { addLog(`${who(d.p)}'s ${d.which} Expedition holds position.`, 'dusk'); continue; }
      advanceMarker(d.p, d.which);
      await emit({ type: 'advance', player: d.p, which: d.which });
      notify(); await delay(220);
    }
  }

  function expeditionTotals(p, which) {
    const main = which === 'hero' ? p.heroExp : p.compExp;
    const other = which === 'hero' ? p.compExp : p.heroExp;
    const tot = { forest: 0, mountain: 0, water: 0 };
    // Asleep Characters' statistics are ignored at Dusk (Beauty Sleep).
    for (const cs of main) { if (cs.asleep) continue; for (const t of T) tot[t] += CM.stat(cs, t); }
    // Gigantic Characters count in BOTH Expeditions, so add them from the other lane.
    for (const cs of other) { if (cs.asleep || !isGigantic(cs.card)) continue; for (const t of T) tot[t] += CM.stat(cs, t); }
    return tot;
  }
  /** Does this Expedition beat the facing one in at least one of its region's terrains? */
  function evalMove(p, which) {
    if (expeditionHasDefender(p, which)) return false;   // a Defender pins this Expedition
    const pos = which === 'hero' ? heroPos(p) : compPos(p);
    const types = regionTypesAt(pos);
    const mine = expeditionTotals(p, which);
    const theirs = expeditionTotals(opponentOf(p), which);
    return types.some(t => mine[t] > 0 && mine[t] > theirs[t]);
  }
  function advanceMarker(p, which) {
    if (which === 'hero') { p.heroDist++; reveal(heroPos(p)); }
    else { p.compDist++; reveal(compPos(p)); }
    addLog(`${who(p)}'s ${which} Expedition advances! (Hero ${heroPos(p)} ↔ Companion ${compPos(p)})`, 'dusk');
  }

  // ── Night ──
  async function night() {
    state.phase = PHASES.NIGHT; state.busy = true; notify();
    addLog('Night — Rest and Cleanup.', 'phase');
    // Rest: Expedition characters return to Reserve (Fleeting → discard; tokens vanish; Anchored stays).
    // Both lanes rest first; THEN "leaves the Expedition zone" triggers fire (so any
    // tokens they muster — e.g. Jeanne d'Arc's Recruits — land in the now-rested
    // Expeditions and persist to the next Day instead of resting immediately).
    for (const p of [state.you, state.opp]) {
      const left = [];
      for (const key of ['heroExp', 'compExp']) {
        const keep = [];
        for (const cs of p[key]) {
          // Anchored / Asleep each keep a Character out of Rest once, then are lost.
          if (cs.anchored || cs.asleep) {
            const lost = [];
            if (cs.anchored) { cs.anchored = false; lost.push('Anchored'); }
            if (cs.asleep) { cs.asleep = false; lost.push('Asleep'); }
            keep.push(cs);
            addLog(`${cs.card.name} stays in the Expedition (${lost.join(' & ')}) and loses ${lost.join(' & ')}.`, 'action');
            continue;
          }
          if (cs.card.token) { addLog(`${cs.card.name} token leaves play and is removed.`, 'action'); left.push(cs); continue; }
          if (cs.fleeting) { p.discard.push(cs.card); }
          else { p.reserve.push(cs.card); }
          left.push(cs);
        }
        p[key] = keep;
      }
      for (const cs of left) await fireLeaveExpedition(cs, p);
    }
    notify(); await delay(200);
    // Cleanup: enforce Reserve and Landmark limits.
    for (const p of [state.you, state.opp]) {
      if (p.reserve.length > p.reserveLimit) {
        const n = p.reserve.length - p.reserveLimit;
        const picks = await p.agent.chooseDiscards({
          player: p, zone: 'reserve', cards: [...p.reserve], count: n,
          prompt: `Reserve limit is ${p.reserveLimit}. Discard ${n} card${n === 1 ? '' : 's'} from your Reserve.`,
        });
        for (const c of normalizePicks(picks, p.reserve, n)) { remove(p.reserve, c); p.discard.push(c); }
        addLog(`${verb(p, 'discard')} ${n} card${n === 1 ? '' : 's'} from Reserve (limit ${p.reserveLimit}).`, 'action');
      }
      if (p.landmarks.length > p.landmarkLimit) {
        const n = p.landmarks.length - p.landmarkLimit;
        const picks = await p.agent.chooseDiscards({
          player: p, zone: 'landmarks', cards: p.landmarks.map(l => l.card), count: n,
          prompt: `Landmark limit is ${p.landmarkLimit}. Sacrifice ${n} Landmark${n === 1 ? '' : 's'}.`,
        });
        for (const c of normalizePicks(picks, p.landmarks.map(l => l.card), n)) {
          const idx = p.landmarks.findIndex(l => l.card === c);
          if (idx !== -1) { p.discard.push(p.landmarks[idx].card); p.landmarks.splice(idx, 1); }
        }
        addLog(`${verb(p, 'sacrifice')} ${n} Landmark${n === 1 ? '' : 's'} (limit ${p.landmarkLimit}).`, 'action');
      }
    }
    notify();
  }
  function normalizePicks(picks, pool, n) {
    let arr = (picks || []).filter(c => pool.includes(c));
    if (arr.length > n) arr = arr.slice(0, n);
    if (arr.length < n) for (const c of pool) { if (arr.length >= n) break; if (!arr.includes(c)) arr.push(c); }
    return arr;
  }
  function remove(arr, c) { const i = arr.indexOf(c); if (i !== -1) arr.splice(i, 1); }

  // ── Victory ──
  function metGoal(p) { return p.heroDist + p.compDist >= TRACK_LEN - 1; }   // heroPos >= compPos
  function totalDistance(p) { return p.heroDist + p.compDist; }
  function checkVictory() {
    const youMet = metGoal(state.you), oppMet = metGoal(state.opp);
    if (!youMet && !oppMet) return false;
    let winner;
    if (youMet && !oppMet) winner = state.you;
    else if (oppMet && !youMet) winner = state.opp;
    else {                                  // both met this Dusk — further traveller wins
      const dy = totalDistance(state.you), dOpp = totalDistance(state.opp);
      winner = dy > dOpp ? state.you : dOpp > dy ? state.opp : state.firstPlayer;
      addLog('Both Expeditions met this Dusk — comparing distance travelled.', 'system');
    }
    state.winner = winner; state.phase = PHASES.GAME_OVER;
    addLog(`${who(winner)}'s Expeditions meet — ${winner.isHuman ? 'you win!' : winner.name + ' wins!'}`, 'system');
    return true;
  }

  // ─── PLAYING CARDS (shared by human & bot) ─────────────────────
  // A script's declarative `costReduction:{ perReserveDiscard, max }` (Paint Prison).
  function scriptCostReduction(card) {
    const sc = CardScripts.get(card.id);
    return sc && sc.costReduction ? sc.costReduction : null;
  }
  // Transient "next <card> you play this turn costs N less" Support modifiers
  // (Foundry Mechanic → next Permanent, Studious Disciple → next Spell). They sit
  // in p.pendingMods and stack onto the matching play.
  function transientCostDiscount(card, p) {
    let d = 0;
    for (const m of p.pendingMods) if (m.kind === 'cost' && m.match(card)) d += m.amount;
    return d;
  }
  // Best-case cost: a card with a Reserve-discount can pay less by discarding from
  // Reserve, so affordability must account for the maximum available discount.
  function minPlayCost(card, p, fromReserve) {
    let cost = CM.playCost(card, fromReserve);
    cost = Math.max(0, cost - transientCostDiscount(card, p));     // Support "next … costs less"
    const cr = scriptCostReduction(card);
    if (cr) {
      const poolSize = (fromReserve ? p.reserve.length - 1 : p.reserve.length);   // the card itself isn't a source
      const n = Math.min(cr.max || 1, Math.max(0, poolSize));
      cost = Math.max(0, cost - n * cr.perReserveDiscard);
    }
    return cost;
  }
  function canAfford(card, p, fromReserve) { return CM.readyMana(p) >= minPlayCost(card, p, fromReserve); }

  // Interactive Reserve-discount (Paint Prison). Returns the final cost to pay.
  async function applyCostReduction(p, card, baseCost, cr) {
    const per = cr.perReserveDiscard, maxN = cr.max || 1;
    const pool = [...p.reserve];                                                   // the played card is already out of Reserve
    const maxBeneficial = Math.min(maxN, pool.length, Math.ceil(baseCost / per));
    if (maxBeneficial <= 0) return baseCost;
    const ready = CM.readyMana(p);
    const need = Math.max(0, Math.min(maxBeneficial, Math.ceil((baseCost - ready) / per)));   // discards required to afford
    const picks = await p.agent.chooseCards({
      player: p, card, cards: pool, min: need, max: maxBeneficial, purpose: 'costReduction', need,
      prompt: need > 0
        ? `Discard ${need} card${need > 1 ? 's' : ''} from your Reserve to afford ${card.name} (−${per} each).`
        : `You may discard a card from your Reserve to reduce ${card.name}'s cost by ${per}.`,
    });
    const chosen = (picks || []).filter(c => p.reserve.includes(c)).slice(0, maxBeneficial);
    for (const c of pool) { if (chosen.length >= need) break; if (!chosen.includes(c)) chosen.push(c); }   // guarantee the required minimum
    for (const c of chosen) { remove(p.reserve, c); p.discard.push(c); }
    if (chosen.length) addLog(`${verb(p, 'discard')} ${chosen.length} card${chosen.length > 1 ? 's' : ''} from Reserve (−${per * chosen.length} to ${card.name}).`, 'action');
    return Math.max(0, baseCost - per * chosen.length);
  }

  function canPlay(p, card, fromReserve) {
    if (state.phase !== PHASES.AFTERNOON) return 'Not the Afternoon.';
    if (state.current !== p) return 'Not your turn.';
    if (p.passed) return 'You have already passed.';
    const zone = fromReserve ? p.reserve : p.hand;
    if (!zone.includes(card)) return fromReserve ? 'Card not in Reserve.' : 'Card not in hand.';
    if (!canAfford(card, p, fromReserve)) return 'Not enough Mana.';
    return null;
  }

  async function playCard(p, card, fromReserve) {
    const why = canPlay(p, card, fromReserve);
    if (why) return { error: why };
    remove(fromReserve ? p.reserve : p.hand, card);          // pull the card out first (so its own Reserve copy isn't a discount source)
    let cost = CM.playCost(card, fromReserve);
    cost = Math.max(0, cost - transientCostDiscount(card, p)); // Support "next … costs less"
    p.pendingMods = p.pendingMods.filter(m => !(m.kind === 'cost' && m.match(card)));   // consume cost mods
    const cr = scriptCostReduction(card);
    if (cr) cost = await applyCostReduction(p, card, cost, cr);
    CM.spendMana(p, cost);
    addLog(`${verb(p, 'play')} ${card.name} (${cost} mana${fromReserve ? ', from Reserve' : ''}).`, 'play');

    if (card.type === 'character') {
      const which = await p.agent.chooseExpedition({ card, player: p, prompt: `Place ${card.name} in which Expedition?` });
      const cs = makeChar(card, { expedition: which || 'hero', fleeting: fromReserve });
      (cs.expedition === 'companion' ? p.compExp : p.heroExp).push(cs);
      // Hero passive: the first Character played each Afternoon gains boost(s)
      // (e.g. Teija & Nauraa — +1 boost).
      if (!p.playedCharThisAfternoon) {
        p.playedCharThisAfternoon = true;
        const n = (p.hero && p.hero.ability && p.hero.ability.firstCharBoost) || 0;
        if (n > 0) { cs.boosts += n; addLog(`${p.hero.name}: ${card.name} gains ${n} boost.`, 'action'); }
      }
      // Transient "next Character gains N boost" Support modifiers (Issun-bōshi,
      // Haven Warrior, Meditation Training) — applied then consumed.
      for (const m of p.pendingMods) {
        if (m.kind === 'boost' && m.match(card)) {
          cs.boosts += m.amount;
          addLog(`${m.label}: ${card.name} gains ${m.amount} boost${m.amount > 1 ? 's' : ''}.`, 'action');
        }
      }
      p.pendingMods = p.pendingMods.filter(m => !(m.kind === 'boost' && m.match(card)));
      await fireTriggers(card, async () => {
        await emit({ type: 'play', player: p, card, charState: cs });
        await firePlay(card, p, cs, fromReserve, true);
        await dispatch('characterJoins', { charState: cs, controller: p });
      });
    } else if (card.type === 'permanent' || card.type === 'landmark') {
      // Permanents (incl. from Reserve) go to the Landmark zone; never Fleeting.
      const ls = { card, exhausted: false, counters: {} };
      p.landmarks.push(ls);
      await fireTriggers(card, async () => {
        await emit({ type: 'play', player: p, card });
        await firePlay(card, p, ls, fromReserve, true);
        await dispatch('playPermanent', { card, controller: p });
      });
    } else { // spell
      await fireTriggers(card, async () => {
        await emit({ type: 'play', player: p, card });
        await firePlay(card, p, null, fromReserve, false);
        await dispatch('playSpell', { card, controller: p });
      });
      if (fromReserve || card.fleeting) p.discard.push(card);
      else p.reserve.push(card);
    }
    notify();
    return { ok: true };
  }

  // ─── HERO: "After You" (Akesha & Taru) ─────────────────────────
  // As First Player you may exhaust your Hero to yield your turn to the opponent
  // WITHOUT passing (you still take turns later this Day). Once per Day (Hero readies
  // each Morning). The Hero script just carries the `afterYou:true` marker.
  function heroAfterYou(p) { const sc = CardScripts.get(p.hero.id); return !!(sc && sc.afterYou); }
  function canAfterYou(p) {
    return heroAfterYou(p) && state.firstPlayer === p && !p.heroExhausted && !opponentOf(p).passed;
  }

  // ─── PLAYER-FACING WRAPPERS (UI calls these) ───────────────────
  function ensureHumanTurn() {
    if (state.busy || !state.awaitingHuman) return 'Please wait…';
    if (state.phase !== PHASES.AFTERNOON) return 'Not the Afternoon.';
    if (state.current !== state.you) return 'Not your turn.';
    return null;
  }

  const PUBLIC = {
    PHASES, TRACK_LEN,
    setupGame, startGame,
    getState: () => state,
    // shared (bot also calls)
    playCard, canPlay, canAfford, minPlayCost, opponentOf, expeditionTotals, evalMove,
    heroPos, compPos, regionTypesAt, metGoal, totalDistance,
    availableQuickActions, toughOf, isGigantic, isDefender,
    cm: CM, addLog, notify, who,
    // human-facing wrappers
    async playerPlay(card, fromReserve) {
      const err = ensureHumanTurn(); if (err) return { error: err };
      let r;
      try {
        r = await playCard(state.you, card, fromReserve);
      } catch (e) {
        // The play committed (mana spent, card moved) but something threw outside
        // the trigger guard. End the turn rather than soft-lock the Afternoon.
        reportAbilityError(card, e); notify(); resolveHuman();
        return { ok: true };
      }
      if (r.ok) resolveHuman();
      return r;
    },
    // Quick action — resolves an exhaust/support ability WITHOUT ending the turn.
    async playerQuickAction(sourceUid, index) {
      const err = ensureHumanTurn(); if (err) return { error: err };
      const a = availableQuickActions(state.you).find(x => x.sourceUid === sourceUid && x.index === index);
      if (!a || !a.canRun) return { error: 'Action unavailable.' };
      try { await a.run(); } catch (e) { reportAbilityError(null, e); }
      notify();
      // A Support like Alice's After You ends the turn (yields without passing).
      if (a.endsTurn) resolveHuman();
      return { ok: true };
    },
    playerPass() {
      const err = ensureHumanTurn(); if (err) return { error: err };
      state.you.passed = true;
      addLog('You pass.', 'phase'); notify();
      resolveHuman();
      return { ok: true };
    },
    // "After You" — yield the turn to the opponent without passing (Hero exhaust).
    canAfterYou: () => state.awaitingHuman && state.current === state.you && canAfterYou(state.you),
    playerAfterYou() {
      const err = ensureHumanTurn(); if (err) return { error: err };
      if (!canAfterYou(state.you)) return { error: 'Cannot use After You now.' };
      state.you.heroExhausted = true;
      addLog(`${state.you.hero.name}: After You — you let your opponent act first.`, 'phase');
      notify();
      resolveHuman();               // end the turn (NOT passed); the loop hands over
      return { ok: true };
    },
  };
  return PUBLIC;
})();
