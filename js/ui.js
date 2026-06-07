// ui.js — DOM rendering, player input, modals, and the human "agent".

const UI = (() => {
  const CM = CardManager, E = GameEngine;
  const T = CM.TERRAINS;
  let state = null;
  let pending = null;      // active board-target request {candidates, resolve, ...}
  let pendingExp = null;   // active expedition-lane pick {card, player, resolve, after}
  let pendingMana = null;  // active Morning "add a Mana Orb" pick {hand, resolve}
  let acting = false;      // guards against overlapping human actions
  let autoPassTimer = null;
  let logFont = 0.82;      // rem; adjusted by the +/- steppers in the log header

  const $ = (id) => document.getElementById(id);
  const esc = (s) => (s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ─── INIT ──────────────────────────────────────────────────────
  async function init() {
    const params = new URLSearchParams(location.search);
    let choice;
    if (params.get('you') && params.get('bot')) choice = { human: params.get('you'), bot: params.get('bot') };
    else { try { choice = JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch (_) { choice = null; } }
    if (!choice || !choice.human || !choice.bot) { location.replace('deck_select.html'); return; }
    const manifest = await CM.loadManifest();
    const byId = Object.fromEntries(manifest.map(d => [d.id, d]));
    const hd = byId[choice.human], bd = byId[choice.bot];
    if (!hd || !bd) { localStorage.removeItem(STORAGE_KEY); location.replace('deck_select.html'); return; }

    state = await E.setupGame({
      changeCallback: onStateChange, eventHook: onEvent,
      humanDeckFile: hd.file, botDeckFile: bd.file,
      humanAgent, botAgent: BotAI.agent,
    });
    wireHandlers();
    if (params.get('auto')) { state.you.isHuman = false; state.you.agent = BotAI.agent; }  // headless self-test
    await E.startGame();
  }

  function onStateChange(s, logs) {
    state = s;
    for (const e of logs) appendLog(e);
    render();
    maybeGameOver();
  }

  // ─── RENDER ─────────────────────────────────────────────────────
  function render() {
    if (!state) return;
    const { you, opp } = state;
    const myTurn = state.phase === 'afternoon' && state.current === you && state.awaitingHuman && !state.busy;

    renderHero('you', you); renderHero('opp', opp);
    const gig = (cs) => E.isGigantic(cs.card);   // Gigantic bodies echo into the other lane
    renderExp('you-hero-exp', you.heroExp, you, myTurn, you.compExp.filter(gig));
    renderExp('you-comp-exp', you.compExp, you, myTurn, you.heroExp.filter(gig));
    renderExp('opp-hero-exp', opp.heroExp, opp, false, opp.compExp.filter(gig));
    renderExp('opp-comp-exp', opp.compExp, opp, false, opp.heroExp.filter(gig));
    renderTerrain('you', you); renderTerrain('opp', opp);
    renderReserve('you', you, myTurn); renderReserve('opp', opp, false);
    renderLandmarks('you', you); renderLandmarks('opp', opp);
    renderMana('you', you); renderMana('opp', opp);
    renderPiles('you', you); renderPiles('opp', opp);
    const manaPick = !!pendingMana;
    renderHand(you, myTurn, manaPick);
    renderOppHand(opp);
    renderQuickActions(myTurn);
    renderTrack();

    $('turn-banner').textContent = state.winner ? 'Game Over' : `Day ${state.day}`;
    document.querySelectorAll('#phase-list .phase-item').forEach(it =>
      it.classList.toggle('active', it.dataset.phase === state.phase));
    // In-board Mana pick: the Pass button becomes Skip (Morning's optional add) or
    // Confirm N/count (Setup's mandatory pick, enabled only when exactly N chosen).
    if (manaPick && pendingMana.optional) {
      $('btn-pass').textContent = 'Skip'; $('btn-pass').disabled = false;
    } else if (manaPick) {
      const n = pendingMana.selected.size;
      $('btn-pass').textContent = `Confirm (${n}/${pendingMana.count})`;
      $('btn-pass').disabled = n !== pendingMana.count;
    } else {
      $('btn-pass').textContent = 'Pass'; $('btn-pass').disabled = !myTurn;
    }
    $('btn-afteryou').style.display = (myTurn && E.canAfterYou()) ? '' : 'none';

    applyTargetHighlights();
    applyExpeditionPick();
    $('board').classList.toggle('locked', !myTurn && !pending && !pendingExp && !manaPick);
    maybeAutoPass(myTurn);
  }

  // The quick-action bar: exhaust/support abilities the human may take before
  // playing or passing (e.g. Kelonic Generator's "{1},{T}: Draw").
  function renderQuickActions(myTurn) {
    const el = $('quick-actions'); if (!el) return;
    if (!myTurn) { el.innerHTML = ''; return; }
    const acts = E.availableQuickActions(state.you).filter(a => a.canRun);
    el.innerHTML = acts.map(a => `<button class="qa-btn" data-uid="${a.sourceUid}" data-i="${a.index}">${esc(a.label)}</button>`).join('');
    el.querySelectorAll('button').forEach(b => b.onclick = async () => {
      if (acting) return;
      acting = true;
      await E.playerQuickAction(+b.dataset.uid, +b.dataset.i);
      acting = false;
    });
  }

  // A turn with no affordable card AND no usable quick action is a forced pass —
  // do it for the human after a short beat.
  function maybeAutoPass(myTurn) {
    clearTimeout(autoPassTimer); autoPassTimer = null;
    if (!myTurn || acting) return;
    const you = state.you;
    const canPlay = you.hand.some(c => E.canAfford(c, you, false))
      || you.reserve.some(c => E.canAfford(c, you, true))
      || E.availableQuickActions(you).some(a => a.canRun);
    if (canPlay) return;
    autoPassTimer = setTimeout(() => {
      const mt = state.phase === 'afternoon' && state.current === state.you && state.awaitingHuman && !state.busy;
      if (mt && !acting && !state.winner) E.playerPass();
    }, 950);
  }


  // ─── ZONE RENDERERS ─────────────────────────────────────────────
  function renderHero(side, p) {
    const el = $(`${side}-hero`);
    if (!p.hero) { el.classList.add('empty'); el.innerHTML = ''; return; }
    el.classList.remove('empty');
    // The First Player marker rides on that player's Hero card.
    const fp = state.firstPlayer === p
      ? `<img class="fp-on-hero" src="assets/markers/first_player.png" alt="First Player" title="First Player">` : '';
    el.innerHTML = cardImg(p.hero, p.heroExhausted ? 'hero hero-spent' : 'hero') + fp;
  }

  function renderExp(id, list, ownerP, interactive, ghosts) {
    const el = $(id);
    const label = el.querySelector('.zone-label').outerHTML;
    // Cards only; the terrain totals now live in the shared central column.
    const cards = list.map(cs => charFace(cs, ownerP)).join('')
      + (ghosts || []).map(cs => charFace(cs, ownerP, true)).join('');
    el.innerHTML = label + cards;
  }

  // Central terrain totals (Forest / Mountain / Water): one shared icon per
  // terrain, the Hero-lane sum on its left and the Companion-lane sum on its
  // right, so both Expeditions can be compared in one place. Matches
  // expeditionTotals() at Dusk (incl. Gigantic echoes from the other lane).
  function renderTerrain(side, p) {
    const hero = E.expeditionTotals(p, 'hero');
    const comp = E.expeditionTotals(p, 'companion');
    $(`${side}-terrain`).innerHTML = T.map(t => {
      const h = hero[t], c = comp[t];
      return `<div class="tc-row">`
        + `<span class="tc-num hero ${h ? '' : 'zero'}">${h}</span>`
        + `<img src="assets/markers/${t}.png" alt="${t}">`
        + `<span class="tc-num comp ${c ? '' : 'zero'}">${c}</span></div>`;
    }).join('');
  }

  function charFace(cs, ownerP, ghost) {
    const c = cs.card;
    // Per-card terrain stats are intentionally not shown — the per-Expedition
    // totals beside each lane already report the sum. Tokens/badges stay on the card.
    const badges = [];
    if (cs.boosts) {
      const tok = cs.boosts >= 2 ? 'boost2' : 'boost1';
      const cnt = cs.boosts > 2 ? `<span class="boost-count">${cs.boosts}</span>` : '';
      badges.push(`<span class="badge boost-tok" title="${cs.boosts} boost (+${cs.boosts}/+${cs.boosts}/+${cs.boosts})">${cnt}<img src="assets/markers/${tok}.png" alt="+${cs.boosts}"></span>`);
    }
    if (cs.fleeting) badges.push(`<span class="badge fleeting" title="Fleeting — discarded instead of going to Reserve"><img src="assets/markers/fleeting.png" alt="Fleeting"></span>`);
    if (cs.anchored) badges.push(`<span class="badge anchored" title="Anchored"><img src="assets/markers/anchored.png" alt="Anchored"></span>`);
    if (cs.asleep) badges.push(`<span class="badge asleep" title="Asleep"><img src="assets/markers/asleep.png" alt="Asleep"></span>`);
    if (E.isDefender(cs, ownerP)) badges.push(`<span class="badge defender" title="Defender — this Expedition can’t move forward at Dusk">D</span>`);
    if (E.isGigantic(c)) badges.push(`<span class="badge gigantic" title="Gigantic — present in both Expeditions">G</span>`);
    const tough = E.toughOf(c, ownerP);
    if (tough) badges.push(`<span class="badge tough" title="Tough ${tough} — opponents pay ${tough} to target me">T${tough}</span>`);
    const cls = ['card', 'face', 'char'];
    if (cs.exhausted) cls.push('exhausted');
    if (ghost) cls.push('ghost');
    const inner = c.image
      ? `<img src="${c.image}" alt="${esc(c.name)}" draggable="false">`
      : `<div class="tk-name">${esc(c.name)}</div>`;
    return `<div class="${cls.join(' ')} ${c.image ? '' : 'tokenless'}" data-uid="${c.uid}" data-id="${c.id}">
      ${inner}${badges.join('')}</div>`;
  }

  function renderReserve(side, p, interactive) {
    const el = $(`${side}-reserve`);
    const label = el.querySelector('.zone-label').outerHTML;
    el.innerHTML = label + p.reserve.map(c => {
      const playable = interactive && E.canAfford(c, p, true);
      return cardImg(c, 'reserve', { reserveCost: true, actionable: playable, kind: 'reserve' });
    }).join('');
  }

  function renderLandmarks(side, p) {
    const el = $(`${side}-landmarks`);
    const label = el.querySelector('.zone-label').outerHTML;
    el.innerHTML = label + p.landmarks.map(l => {
      const cls = l.exhausted ? 'landmark exhausted' : 'landmark';
      const kc = l.counters && l.counters.kelon;
      const extra = kc ? `<span class="badge counter" title="${kc} Kelon counters">${kc}</span>` : '';
      return cardImg(l.card, cls, { extra });
    }).join('');
  }

  function renderMana(side, p) {
    $(`${side}-mana`).innerHTML = p.mana.map(o => {
      const ready = !o.exhausted;
      const art = ready ? 'mana_full' : 'mana_empty';
      const title = ready ? 'Ready mana' : 'Spent mana';
      return `<span class="orb ${ready ? 'full' : 'empty'}" title="${title}"><img src="assets/markers/${art}.png" alt="${title}"></span>`;
    }).join('');
  }

  function renderPiles(side, p) {
    const deck = $(`${side}-deck`), disc = $(`${side}-discard`);
    $(`${side}-deck-count`).textContent = p.deck.length;
    $(`${side}-discard-count`).textContent = p.discard.length;
    deck.classList.toggle('has-cards', p.deck.length > 0);
    disc.classList.toggle('has-cards', p.discard.length > 0);
  }

  // The bot's hand has no visible count any more; show one face-down card back per
  // card so its hand size stays readable. (The human reads their own hand directly.)
  function renderOppHand(p) {
    $('opp-hand').innerHTML = p.hand.map(() =>
      `<div class="card face cardback" title="Hidden card"><img src="assets/cards/cardback.jpg" alt="" draggable="false"></div>`
    ).join('');
  }

  function renderHand(p, myTurn, manaPick) {
    $('you-hand').innerHTML = p.hand.map(c => {
      // In-board Mana pick (Setup or Morning): every hand card is selectable; Setup's
      // multi-select shows the chosen cards with a 'picked' ring.
      if (manaPick) return cardImg(c, 'hand', { playable: true, actionable: true, kind: 'mana', picked: pendingMana.selected.has(c.uid) });
      const playable = myTurn && E.canAfford(c, p, false);
      return cardImg(c, 'hand', { playable, actionable: playable, kind: 'hand' });
    }).join('');
  }

  function cardImg(card, sizeCls, opts = {}) {
    const cls = ['card', 'face', sizeCls];
    if (opts.playable) cls.push('playable');
    if (opts.actionable) cls.push('actionable');
    if (opts.picked) cls.push('picked');
    const cost = opts.reserveCost ? card.reserveCost : card.handCost;
    const costCls = opts.reserveCost ? 'cost reserve-cost' : 'cost';
    const showCost = sizeCls === 'hand' || opts.reserveCost;
    const tag = (card.type !== 'character' && (sizeCls === 'hand' || sizeCls === 'reserve'))
      ? `<span class="badge type-tag">${card.type}</span>` : '';
    const inner = card.image
      ? `<img src="${card.image}" alt="${esc(card.name)}" draggable="false">`
      : `<div class="tk-name">${esc(card.name)}</div>`;
    return `<div class="${cls.join(' ')} ${card.image ? '' : 'tokenless'}" data-uid="${card.uid}" data-id="${card.id}" ${opts.kind ? `data-kind="${opts.kind}"` : ''}>
      ${inner}${showCost ? `<span class="${costCls}">${cost}</span>` : ''}${tag}${opts.extra || ''}</div>`;
  }

  // ─── TUMULT TRACK (real Adventure cards, markers on the cards) ───
  function renderTrack() {
    const cards = state.track.cards.map(c => {
      const discovered = c.kind !== 'tumult' || c.positions.some(p => state.track.regions[p].faceUp);
      const img = discovered ? c.image : c.back;        // face-down Tumults show the real card back
      // Every Adventure card carries its own printed terrain icons, so no chips.
      // A flipped Tumult is rotated 180° so its printed icons line up with the
      // half order the engine assigned (single-type half toward the Hero side).
      const flip = c.flip ? ' flip' : '';
      return `<div class="adv-card ${c.kind}${flip}" data-positions="${c.positions.join(',')}" data-advimg="${img}">
        <img src="${img}" alt="${c.kind}" draggable="false">
      </div>`;
    }).join('');
    $('track').innerHTML = `<div class="adv-line">${cards}</div><div class="marker-layer" id="marker-layer"></div>`;
    placeMarkers();
  }

  // Markers rest ON the cards: region cards have an inner placeholder (toward the
  // track); a Tumult's two regions are the 1/4 and 3/4 points of its width. Your
  // marker sits low, the opponent's high (mirroring the table), each colour-ringed.
  function placeMarkers() {
    const trackEl = $('track'), line = trackEl.querySelector('.adv-line'), layer = $('marker-layer');
    if (!line || !layer) return;
    const tr = trackEl.getBoundingClientRect();
    const slot = new Array(E.TRACK_LEN);
    line.querySelectorAll('.adv-card').forEach(el => {
      const ps = el.dataset.positions.split(',').map(Number);
      const r = el.getBoundingClientRect();
      const y = r.top + r.height / 2 - tr.top;
      if (ps.length === 1) {
        const frac = el.classList.contains('hero') ? 0.66 : 0.34;   // inner placeholder, toward the track
        slot[ps[0]] = { x: r.left + r.width * frac - tr.left, y };
      } else {
        slot[ps[0]] = { x: r.left + r.width * 0.25 - tr.left, y };
        slot[ps[1]] = { x: r.left + r.width * 0.75 - tr.left, y };
      }
    });
    const out = [];
    for (const [pl, side] of [[state.you, 'you'], [state.opp, 'opp']]) {
      const hp = E.heroPos(pl), cp = E.compPos(pl), meet = hp === cp;
      const dy = side === 'you' ? 19 : -19;
      out.push(markerChip(slot[hp], side, 'hero', pl, meet, -9, dy));
      out.push(markerChip(slot[cp], side, 'comp', pl, meet, 9, dy));
    }
    layer.innerHTML = out.join('');
  }
  // Real punch-board Expedition marker for the player's faction, with a blue
  // (you) / red (opponent) ring so you can always tell whose marker it is.
  function markerChip(slot, side, role, pl, meet, dx, dy) {
    if (!slot) return '';
    const img = `assets/markers/exp_${pl.faction}_${role}.png`;
    const title = `${pl === state.you ? 'Your' : pl.name + "'s"} ${role === 'hero' ? 'Hero' : 'Companion'} Expedition`;
    return `<span class="trk-marker ${side} ${meet ? 'meet' : ''}" style="left:${Math.round(slot.x + dx)}px;top:${Math.round(slot.y + dy)}px" title="${title}"><img src="${img}" alt="${role}"></span>`;
  }

  // ─── EVENT WIRING ───────────────────────────────────────────────
  function wireHandlers() {
    $('btn-pass').addEventListener('click', () => {
      if (acting) return;
      if (pendingMana) {
        if (pendingMana.optional) { resolveMana([]); return; }                 // Morning: Skip
        if (pendingMana.selected.size === pendingMana.count)                   // Setup: Confirm N picks
          resolveMana(pendingMana.hand.filter(c => pendingMana.selected.has(c.uid)));
        return;
      }
      E.playerPass();
    });
    $('btn-afteryou').addEventListener('click', () => { if (!acting) E.playerAfterYou(); });
    $('board').addEventListener('click', onBoardClick);
    const hidePreview = () => { $('card-preview').style.display = 'none'; };
    $('board').addEventListener('mouseover', onHover);
    $('board').addEventListener('mouseout', hidePreview);
    // Show the same hover preview when scanning cards inside a dock-left dialog.
    document.querySelectorAll('.modal-overlay.dock-left').forEach(ov => {
      ov.addEventListener('mouseover', onHover);
      ov.addEventListener('mouseout', hidePreview);
    });
    $('you-deck').addEventListener('click', () => {});
    $('you-discard').addEventListener('click', () => showDiscard(state.you));
    $('opp-discard').addEventListener('click', () => showDiscard(state.opp));
    // The Discard viewer is read-only: a click anywhere (backdrop or cards) closes
    // it. Hovering still shows the big preview and the grid can be scrolled.
    $('discard-viewer').addEventListener('click', () => hide('discard-viewer'));
    $('target-cancel').addEventListener('click', cancelTarget);
    $('btn-quit').addEventListener('click', () => { localStorage.removeItem(STORAGE_KEY); location.replace('deck_select.html'); });
    $('btn-howto').addEventListener('click', () => show('howto-modal'));
    $('howto-close').addEventListener('click', () => hide('howto-modal'));
    $('log-font-inc').addEventListener('click', () => setLogFont(logFont + 0.08));
    $('log-font-dec').addEventListener('click', () => setLogFont(logFont - 0.08));
    $('gameover-again').addEventListener('click', () => location.reload());
    $('gameover-change').addEventListener('click', () => { localStorage.removeItem(STORAGE_KEY); location.replace('deck_select.html'); });
    document.addEventListener('click', (e) => { if (!e.target.closest('#context-menu') && !e.target.closest('.card')) closeMenu(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeMenu(); cancelTarget(); } });
  }

  function onHover(e) {
    const el = e.target.closest('[data-id],[data-advimg]');
    const prev = $('card-preview');
    if (!el) { prev.style.display = 'none'; return; }
    if (el.dataset.advimg) {                       // an Adventure card on the track
      prev.innerHTML = `<img src="${el.dataset.advimg}" alt="">`;
      prev.style.display = 'block'; return;
    }
    const data = CM.getCard(el.dataset.id);
    // Tokens (Booda, Brassbug, …) aren't in the card registry, so fall back to
    // the art already rendered inside the hovered card element.
    const img = (data && data.image) || el.querySelector('img')?.getAttribute('src');
    if (!img) { prev.style.display = 'none'; return; }
    prev.innerHTML = `<img src="${img}" alt="">`;
    prev.style.display = 'block';
  }

  function onBoardClick(e) {
    const cardEl = e.target.closest('.card');
    if (pendingMana) {                   // in-board Mana pick: click hand cards
      if (!cardEl) return;
      const card = pendingMana.hand.find(c => c.uid === +cardEl.dataset.uid);
      if (!card) return;
      if (pendingMana.optional) { resolveMana([card]); return; }   // Morning: one click buries it
      const sel = pendingMana.selected;                            // Setup: toggle, up to count
      if (sel.has(card.uid)) sel.delete(card.uid);
      else if (sel.size < pendingMana.count) sel.add(card.uid);
      render();
      return;
    }
    if (pending) {                       // resolving a target request
      if (!cardEl) return;
      const uid = +cardEl.dataset.uid;
      const cand = pending.candidates.find(c => c.uid === uid);
      if (cand) resolveTarget(cand);
      return;
    }
    if (!cardEl || acting) return;
    const myTurn = state.phase === 'afternoon' && state.current === state.you && state.awaitingHuman && !state.busy;
    if (!myTurn) return;
    const uid = +cardEl.dataset.uid, kind = cardEl.dataset.kind;
    if (kind === 'hand') {
      const card = state.you.hand.find(c => c.uid === uid);
      if (card) openPlayMenu(card, cardEl, false);
    } else if (kind === 'reserve') {
      const card = state.you.reserve.find(c => c.uid === uid);
      if (card) openPlayMenu(card, cardEl, true);
    }
  }

  function openPlayMenu(card, anchorEl, fromReserve) {
    const cost = CM.playCost(card, fromReserve);
    const affordable = E.canAfford(card, state.you, fromReserve);
    const opts = [{
      label: `Play${fromReserve ? ' from Reserve' : ''} (${cost} mana)`,
      disabled: !affordable,
      fn: async () => { acting = true; await E.playerPlay(card, fromReserve); acting = false; },
    }];
    showMenu(anchorEl, opts);
  }

  function showMenu(anchorEl, opts) {
    closeMenu();
    const menu = $('context-menu');
    menu.innerHTML = opts.map((o, i) => `<button class="menu-btn" data-i="${i}" ${o.disabled ? 'disabled' : ''}>${esc(o.label)}</button>`).join('');
    menu.querySelectorAll('button').forEach(b => b.addEventListener('click', (e) => {
      e.stopPropagation(); const o = opts[+b.dataset.i]; closeMenu(); if (!o.disabled) o.fn();
    }));
    const r = anchorEl.getBoundingClientRect();
    menu.style.display = 'flex';
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    let left = Math.max(8, Math.min(r.left + r.width / 2 - mw / 2, innerWidth - mw - 8));
    let top = r.top - mh - 8; if (top < 8) top = r.bottom + 8;
    menu.style.left = `${left}px`; menu.style.top = `${top}px`;
  }
  function closeMenu() { $('context-menu').style.display = 'none'; }

  // ─── HUMAN AGENT ────────────────────────────────────────────────
  const humanAgent = {
    chooseManaCards({ hand, count, optional, prompt }) {
      // Both Mana picks play out on the board (no modal): Setup's mandatory N-of-6
      // and Morning's optional add. The play area stays visible and the human clicks
      // hand cards. Morning (optional, 1 card) resolves on a single click; Setup
      // selects exactly N cards and Confirms via the bottom button.
      return new Promise(resolve => {
        pendingMana = { hand, resolve, count, optional, selected: new Set() };
        const base = prompt || (optional ? 'You may add a Mana Orb.' : 'Choose your Mana Orbs.');
        $('target-text').textContent = optional ? `${base} Click a card, or Skip.` : base;
        $('target-cancel').style.display = 'none';
        $('target-banner').style.display = 'flex';
        render();
      });
    },
    chooseDiscards({ cards, count, prompt, zone }) {
      return new Promise(resolve => openPick({
        title: zone === 'landmarks' ? 'Sacrifice Landmarks' : 'Cleanup — Discard',
        prompt, cards: [...cards], count, exact: true, optional: false,
        resolve: (picks) => resolve(picks),
      }));
    },
    chooseExpedition({ card, player, prompt }) {
      // Instead of a modal over the board, highlight the two lanes in place and
      // wait for the human to click one. The overlay is semi-transparent so the
      // cards, markers, and terrain totals underneath stay readable.
      return new Promise(resolve => {
        // Resulting terrain totals if this Character lands in lane `w`.
        const after = (w) => T.map(t => E.expeditionTotals(player, w)[t] + (card[t] || 0));
        pendingExp = { card, player, resolve, after };
        $('target-text').textContent = (prompt || `Place ${card.name}`) + ' — click a lane';
        $('target-cancel').style.display = 'none';
        $('target-banner').style.display = 'flex';
        render();
      });
    },
    confirm({ prompt }) {
      return openChoice('Confirm', prompt, [{ key: true, label: 'Yes' }, { key: false, label: 'No' }]);
    },
    chooseOption({ prompt, options }) {
      return openChoice('Choose one', prompt, options);
    },
    chooseTarget({ prompt, candidates, optional }) {
      return new Promise(resolve => {
        if (!candidates || !candidates.length) { resolve(null); return; }
        pending = { candidates, optional, resolve };
        $('target-text').textContent = prompt || 'Choose a target';
        $('target-cancel').style.display = optional ? '' : 'none';
        $('target-banner').style.display = 'flex';
        render();
      });
    },
    chooseCards({ prompt, cards, min, max }) {
      const count = max || 1;
      return new Promise(resolve => openPick({
        title: 'Choose', prompt, cards: [...cards], count,
        exact: (min || 0) === count, optional: !min, resolve,
      }));
    },
    // The Ouroboros — the dice popup has already shown both rolls; pick which to keep.
    chooseDie({ prompt, rolls }) {
      return openChoice('The Ouroboros', prompt || 'Choose which die to keep.',
        rolls.map((v, i) => ({ key: i, label: `Keep ${v}` }))).then(i => [rolls[i]]);
    },
  };

  // Generic single-choice modal (Yes/No, or pick one labelled option).
  function openChoice(title, prompt, options) {
    return new Promise(resolve => {
      $('choice-title').textContent = title;
      $('choice-prompt').textContent = prompt || '';
      const box = $('choice-actions');
      box.innerHTML = options.map((o, i) => `<button class="primary-btn choice-btn" data-i="${i}">${esc(o.label)}</button>`).join('');
      box.querySelectorAll('button').forEach(b => b.onclick = () => { hide('choice-modal'); resolve(options[+b.dataset.i].key); });
      show('choice-modal');
    });
  }

  // ─── PICK MODAL (choose N cards from a set) ─────────────────────
  function openPick({ title, prompt, cards, count, exact, optional, resolve }) {
    $('pick-title').textContent = title;
    $('pick-prompt').textContent = prompt || '';
    const grid = $('pick-grid');
    const selected = new Set();
    const refresh = () => {
      grid.querySelectorAll('.card').forEach(n => n.classList.toggle('picked', selected.has(+n.dataset.uid)));
      const ok = exact ? selected.size === count : selected.size <= count;
      $('pick-confirm').disabled = !ok;
      $('pick-count').textContent = `${selected.size}/${count} selected`;
    };
    grid.innerHTML = cards.map(c => cardImg(c, 'face')).join('');
    grid.querySelectorAll('.card').forEach(n => n.onclick = () => {
      const uid = +n.dataset.uid;
      if (selected.has(uid)) selected.delete(uid);
      else { if (selected.size >= count) { if (count === 1) selected.clear(); else return; } selected.add(uid); }
      refresh();
    });
    $('pick-skip').style.display = optional ? 'inline-block' : 'none';
    refresh();
    show('pick-modal');
    $('pick-confirm').onclick = () => {
      const ok = exact ? selected.size === count : selected.size <= count;
      if (!ok) return;
      hide('pick-modal');
      resolve(cards.filter(c => selected.has(c.uid)));
    };
    $('pick-skip').onclick = () => { hide('pick-modal'); resolve([]); };
  }

  // ─── TARGET BANNER (unused by v1 abilities, kept for extensibility) ──
  function resolveTarget(c) { const p = pending; hideBanner(); if (p) p.resolve(c); }
  function cancelTarget() { if (pending && pending.optional) { const p = pending; hideBanner(); p.resolve(null); } }
  function hideBanner() { $('target-banner').style.display = 'none'; pending = null; render(); }
  function applyTargetHighlights() {
    const set = new Set(pending ? pending.candidates.map(c => c.uid) : []);
    document.querySelectorAll('#board .card').forEach(n => n.classList.toggle('targetable', set.has(+n.dataset.uid)));
  }

  // ─── EXPEDITION LANE PICK (overlay on the two own lanes) ────────
  function applyExpeditionPick() {
    document.querySelectorAll('.exp-pick-overlay').forEach(n => n.remove());
    if (!pendingExp) return;
    const add = (zoneId, which, name) => {
      const zone = $(zoneId); if (!zone) return;
      const ov = document.createElement('div');
      ov.className = 'exp-pick-overlay';
      ov.innerHTML = `<span class="epo-name">${name}</span>` +
        `<span class="epo-tot">→ ${pendingExp.after(which).join(' / ')}</span>`;
      ov.onclick = (e) => { e.stopPropagation(); resolveExpedition(which); };
      zone.appendChild(ov);
    };
    add('you-hero-exp', 'hero', 'Hero Expedition');
    add('you-comp-exp', 'companion', 'Companion Expedition');
  }
  function resolveExpedition(which) {
    const p = pendingExp; pendingExp = null;
    $('target-banner').style.display = 'none';
    document.querySelectorAll('.exp-pick-overlay').forEach(n => n.remove());
    render();
    if (p) p.resolve(which);
  }

  // ─── MORNING MANA PICK (in-board, no modal) ────────────────────
  // [card] buries that card as a Mana Orb; [] skips the optional add.
  function resolveMana(picks) {
    const p = pendingMana; pendingMana = null;
    $('target-banner').style.display = 'none';
    render();
    if (p) p.resolve(picks);
  }

  // ─── DISCARD VIEWER ─────────────────────────────────────────────
  function showDiscard(p) {
    if (p.discard.length === 0) return;
    $('discard-title').textContent = `${p === state.you ? 'Your' : p.name} Discard (${p.discard.length})`;
    $('discard-grid').innerHTML = p.discard.map(c => cardImg(c, 'face')).join('');
    show('discard-viewer');
  }

  // ─── LOG / MODAL HELPERS ────────────────────────────────────────
  function appendLog(entry) {
    const log = $('log');
    const div = document.createElement('div');
    div.className = `log-entry log-${entry.type}`;
    div.textContent = entry.message;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }
  function setLogFont(rem) {
    logFont = Math.max(0.6, Math.min(1.3, Math.round(rem * 100) / 100));
    $('log').style.fontSize = `${logFont}rem`;
  }
  function show(id) { $(id).style.display = 'flex'; }
  function hide(id) { $(id).style.display = 'none'; $('card-preview').style.display = 'none'; }

  // ─── ANIMATION HOOK ─────────────────────────────────────────────
  async function onEvent(evt) {
    if (evt.type === 'dice') { await showDice(evt.rolls, evt.player); return; }
    if (evt.type === 'play' && evt.charState) pulse(evt.charState.card.uid, 'pulse-play');
    await new Promise(r => setTimeout(r, 60));
  }
  // Animated dice popup. Shown before any Ouroboros "keep which die" choice so the
  // player sees every rolled face first.
  const DIE_FACES = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
  async function showDice(rolls, player) {
    const overlay = $('dice-overlay'), box = $('dice-box');
    if (!overlay || !box) return;
    const side = player === state.you ? 'you' : 'opp';
    box.innerHTML = rolls.map(r => `<span class="die ${side}">${DIE_FACES[r - 1] || '?'}</span>`).join('');
    overlay.classList.add('show');
    await new Promise(r => setTimeout(r, 750));
    overlay.classList.remove('show');
  }
  function pulse(uid, cls) {
    const n = document.querySelector(`#board .card[data-uid="${uid}"]`);
    if (n) { n.classList.add(cls); setTimeout(() => n.classList.remove(cls), 320); }
  }

  // ─── GAME OVER ──────────────────────────────────────────────────
  function maybeGameOver() {
    if (!state.winner) return;
    const won = state.winner === state.you;
    $('gameover-title').textContent = won ? 'Victory!' : `${state.opp.name} wins`;
    $('gameover-title').style.color = won ? 'var(--good)' : 'var(--opp)';
    $('gameover-sub').textContent = won
      ? `Your Expeditions met after ${state.day} day${state.day === 1 ? '' : 's'}.`
      : `${state.opp.name}'s Expeditions met first. You travelled ${E.totalDistance(state.you)}/7.`;
    show('gameover');
  }

  return { init };
})();

window.addEventListener('DOMContentLoaded', UI.init);
