// scripts.js — Hand-authored card abilities for the complex cards, keyed by
// card reference id. Loaded after cards.js, before game.js.
//
// A script is consulted by the engine in preference to the regex-detected
// `card.ability`. Each handler is `async (ctx) => {}` where ctx is:
//   { card, self, controller, opponent, state, agent, api, event }
//     • self  — the in-play state object (charState / landmarkState / heroState)
//     • event — payload for reactive on.* handlers
// Trigger keys:  join {J}, hand {H}, reserve {R}, play (spell, any zone), atNoon.
// Reactive:      on: { playPermanent, characterJoins }
// Quick actions: quickActions(ctx) => [{ label, kind, canRun, run }]
// Support:       support(ctx)  (cost = discard the Reserve card; AXIOM unused)

const CardScripts = (() => {
  const CM = CardManager;
  const SCRIPTS = {};
  const def = (id, spec) => { SCRIPTS[id] = spec; };

  // Token defs (tokens aren't in any deck). Their art is resolved by name in
  // CardManager.makeToken (CM.TOKEN_ART), so no image field is needed here.
  const BRASSBUG = { name: 'Brassbug', forest: 2, mountain: 2, water: 2, subtype: 'Robot' };
  const BOODA = { name: 'Booda', forest: 2, mountain: 2, water: 2, subtype: 'Companion' };

  // Ask for an Expedition (own Hero/Companion) and drop a Brassbug into it.
  async function createRobot(ctx, where) {
    let which = where;
    if (where === 'target') {
      which = await ctx.controller.agent.chooseExpedition({
        card: ctx.card, player: ctx.controller,
        prompt: 'Create a Brassbug 2/2/2 Robot in which Expedition?',
      });
    }
    await ctx.api.createToken(ctx.controller, BRASSBUG, which || 'hero');
    ctx.api.log(`${ctx.api.who(ctx.controller)} ${ctx.controller.isHuman ? 'create' : 'creates'} a Brassbug 2/2/2 Robot token.`, 'action');
  }

  // {H} Sabotage — discard up to one card from an opponent's Reserve (shared).
  async function sabotage(ctx) {
    const cand = ctx.api.targets({ controller: ctx.controller, side: 'opp', zone: 'reserve' });
    if (!cand.length) return;
    const t = await ctx.controller.agent.chooseTarget({
      card: ctx.card, player: ctx.controller, optional: true, candidates: cand,
      prompt: 'Sabotage — discard up to one card from an opponent’s Reserve.',
    });
    if (!t) return;
    ctx.api.discardFromReserve(t);
    ctx.api.log(`${ctx.card.name} sabotages ${t.card.name} from a Reserve.`, 'action');
  }

  // ─── Support ability helpers ───────────────────────────────────
  // A Support ability ({D}) is a quick action usable only while the card is in
  // your Reserve: you discard it as the cost (the engine pays that — see
  // availableQuickActions in game.js), then resolve the effect. A script's
  // support(ctx) returns { label, canRun, effect, endsTurn? }.
  const TYPE_PERMANENT = (c) => c.type === 'permanent' || c.type === 'landmark';
  const TYPE_SPELL = (c) => c.type === 'spell';
  const TYPE_CHARACTER = (c) => c.type === 'character';

  // "The next <type> you play this turn costs 1 less" — a transient cost mod.
  const supNextCostsLess = (name, typeLabel, match) => (ctx) => ({
    label: `${name} — next ${typeLabel} costs 1 less (discard)`,
    canRun: true,
    effect: async () => {
      ctx.controller.pendingMods.push({ kind: 'cost', match, amount: 1, label: name });
      ctx.api.log(`${name}: your next ${typeLabel} this turn costs 1 less.`, 'action');
    },
  });

  // "The next Character you play this turn gains N boost" — a transient boost mod.
  const supBoostNextChar = (name, n) => (ctx) => ({
    label: `${name} — next Character gains ${n} boost (discard)`,
    canRun: true,
    effect: async () => {
      ctx.controller.pendingMods.push({ kind: 'boost', match: TYPE_CHARACTER, amount: n, label: name });
      ctx.api.log(`${name}: your next Character this turn gains ${n} boost${n > 1 ? 's' : ''}.`, 'action');
    },
  });

  // "Target Character with Hand Cost ≤3 gains Anchored." (The Hatter, Muna Druid)
  const supAnchorTarget = (name) => (ctx) => {
    const cand = ctx.api.targets({ controller: ctx.controller, side: 'any', kind: 'character', maxHandCost: 3, payable: true });
    return {
      label: `${name} — Anchor a Character cost ≤3 (discard)`,
      canRun: cand.length > 0,
      effect: async () => {
        const t = await ctx.api.resolveTarget({
          agent: ctx.controller.agent, requester: ctx.controller, candidates: cand,
          optional: true, intent: 'buff', prompt: 'Give Anchored to which Character (Hand Cost ≤3)?',
        });
        if (!t) return;
        t.charState.anchored = true;
        ctx.api.log(`${name}: ${t.card.name} gains Anchored.`, 'action');
      },
    };
  };

  // ─── Hero: Sierra & Oddball ────────────────────────────────────
  // "When you play a Permanent with Hand Cost 3+ — you may exhaust me to
  //  create a Brassbug 2/2/2 Robot token in target Expedition."
  def('ALT_CORE_B_AX_01_C', {
    on: {
      async playPermanent(ctx) {
        const e = ctx.event;
        if (e.controller !== ctx.controller) return;       // only YOUR permanents
        if ((e.card.handCost || 0) < 3) return;
        if (ctx.self.exhausted) return;
        const yes = await ctx.controller.agent.confirm({
          card: ctx.card, player: ctx.controller,
          prompt: `${ctx.card.name}: exhaust your Hero to create a Brassbug 2/2/2 Robot in target Expedition?`,
        });
        if (!yes) return;
        ctx.self.exhausted = true;
        ctx.api.log(`${ctx.card.name} exhausts to create a Brassbug.`, 'action');
        await createRobot(ctx, 'target');
      },
    },
  });

  // ─── Axiom Scrambler: {H} Sabotage ─────────────────────────────
  def('ALT_CORE_B_AX_15_C', { hand: sabotage });
  def('ALT_CORE_B_AX_15_R1', { hand: sabotage });

  // ─── Kelon Elemental: {H} put a card from hand in Reserve ──────
  def('ALT_CORE_B_AX_04_C', {
    async hand(ctx) {
      if (!ctx.controller.hand.length) return;
      const picks = await ctx.controller.agent.chooseCards({
        card: ctx.card, player: ctx.controller, cards: [...ctx.controller.hand], min: 1, max: 1,
        prompt: 'Put a card from your hand into your Reserve.',
      });
      const c = picks && picks[0]; if (!c) return;
      ctx.api.moveHandToReserve(ctx.controller, c);
      ctx.api.log(`${ctx.api.who(ctx.controller)} ${ctx.controller.isHuman ? 'put' : 'puts'} a card from hand into Reserve.`, 'action');
    },
  });

  // ─── Three Little Pigs: {J} conditional boost ──────────────────
  const pigs = (n) => ({
    async join(ctx) {
      if (ctx.controller.landmarks.length >= 2) {
        ctx.self.boosts = (ctx.self.boosts || 0) + n;
        ctx.api.log(`${ctx.card.name} gains ${n} boost${n > 1 ? 's' : ''} (you control 2+ Landmarks).`, 'action');
      }
    },
  });
  def('ALT_CORE_B_AX_12_C', pigs(1));
  def('ALT_CORE_B_AX_12_R1', pigs(2));

  // ─── Kelon Burst: spell — choose one (bounce / destroy) ────────
  def('ALT_CORE_B_AX_23_C', {
    async play(ctx) {
      const chars = ctx.api.targets({ controller: ctx.controller, side: 'any', kind: 'character', maxHandCost: 4, payable: true });
      const perms = ctx.api.targets({ controller: ctx.controller, side: 'any', kind: 'permanent', maxHandCost: 4 });
      const options = [];
      if (chars.length) options.push({ key: 'bounce', label: 'Send a Character (cost ≤4) to Reserve' });
      if (perms.length) options.push({ key: 'destroy', label: 'Discard a Permanent (cost ≤4)' });
      if (!options.length) { ctx.api.log(`${ctx.card.name} fizzles — no legal target.`, 'system'); return; }
      const key = options.length === 1 ? options[0].key
        : await ctx.controller.agent.chooseOption({ card: ctx.card, player: ctx.controller, prompt: 'Kelon Burst — choose one:', options });
      if (key === 'bounce') {
        const t = await ctx.api.resolveTarget({ agent: ctx.controller.agent, requester: ctx.controller, candidates: chars, intent: 'remove', prompt: 'Send which Character to Reserve?' });
        if (t) { await ctx.api.bounceToReserve(t); ctx.api.log(`${ctx.card.name} sends ${t.card.name} to Reserve.`, 'action'); }
      } else if (key === 'destroy') {
        const t = await ctx.api.resolveTarget({ agent: ctx.controller.agent, requester: ctx.controller, candidates: perms, intent: 'remove', prompt: 'Discard which Permanent?' });
        if (t) { ctx.api.destroyPermanent(t); ctx.api.log(`${ctx.card.name} discards ${t.card.name}.`, 'action'); }
      }
    },
  });

  // ─── Kelonic Generator: quick action {1},{T}: Draw ─────────────
  def('ALT_CORE_B_AX_27_R1', {
    quickActions(ctx) {
      return [{
        label: 'Kelonic Generator — Draw (1⚡, exhaust)', kind: 'draw',
        canRun: !ctx.self.exhausted && ctx.api.readyMana(ctx.controller) >= 1,
        run: async () => {
          ctx.api.spendMana(ctx.controller, 1);
          ctx.self.exhausted = true;
          const d = ctx.api.draw(ctx.controller, 1);
          if (d.length) ctx.api.log(`${ctx.api.who(ctx.controller)} ${ctx.controller.isHuman ? 'draw' : 'draws'} a card (Kelonic Generator).`, 'draw');
        },
      }];
    },
  });

  // ─── Brassbug Hive: {J} + At Noon token; rare boosts joining Robots ──
  const hive = {
    async join(ctx) { await createRobot(ctx, 'target'); },
    async atNoon(ctx) { await createRobot(ctx, 'target'); },
  };
  def('ALT_CORE_B_AX_30_C', hive);
  def('ALT_CORE_B_AX_30_R1', {
    ...hive,
    on: {
      async characterJoins(ctx) {
        const cs = ctx.event.charState;
        if (ctx.event.controller !== ctx.controller) return;
        if (!CM.hasSubtype(cs.card, 'Robot')) return;
        cs.boosts = (cs.boosts || 0) + 1;
        ctx.api.log(`Brassbug Hive: ${cs.card.name} gains 1 boost.`, 'action');
      },
    },
  });

  // ─── Brassbug Hub: {J} gain 3 Kelon counters; At Noon spend one (per Noon) ──
  def('ALT_CORE_B_AX_24_C', {
    async join(ctx) {
      ctx.self.counters.kelon = (ctx.self.counters.kelon || 0) + 3;
      ctx.api.log(`${ctx.card.name} gains 3 Kelon counters.`, 'action');
    },
    // Once per Noon: optionally pay 1⚡ + spend one Kelon counter for a Brassbug.
    async atNoon(ctx) {
      if ((ctx.self.counters.kelon || 0) < 1 || ctx.api.readyMana(ctx.controller) < 1) return;
      const yes = await ctx.controller.agent.confirm({
        card: ctx.card, player: ctx.controller,
        prompt: `Brassbug Hub: pay 1⚡ and spend a Kelon counter to create a Brassbug? (${ctx.self.counters.kelon} left)`,
      });
      if (!yes) return;
      ctx.api.spendMana(ctx.controller, 1);
      ctx.self.counters.kelon--;
      await createRobot(ctx, 'target');
    },
  });

  // ══════════════════════ BRAVOS (Kojo & Booda) ══════════════════════

  // Hero — At Noon, if First Player, make a Booda 2/2/2 Companion token.
  def('ALT_CORE_B_BR_01_C', {
    async atNoon(ctx) {
      if (ctx.state.firstPlayer !== ctx.controller) return;
      await ctx.api.createToken(ctx.controller, BOODA, 'companion');
      ctx.api.log(`${ctx.card.name}: create a Booda 2/2/2 in your Companion Expedition.`, 'action');
    },
  });

  // Bravos Tracer — {J} I gain Fleeting.
  const tracer = {
    async join(ctx) { ctx.self.fleeting = true; ctx.api.log(`${ctx.card.name} gains Fleeting.`, 'action'); },
  };
  def('ALT_CORE_B_BR_07_C', tracer);
  def('ALT_CORE_B_BR_07_R1', tracer);

  // Haven Bouncer — {H} Sabotage / {R} I gain 1 boost.
  def('ALT_CORE_B_BR_15_C', {
    hand: sabotage,
    async reserve(ctx) { ctx.self.boosts = (ctx.self.boosts || 0) + 1; ctx.api.log(`${ctx.card.name} gains 1 boost.`, 'action'); },
  });

  // Sun Wukong (rare) — {R} I gain 2 boosts and lose Fleeting.
  def('ALT_CORE_B_BR_18_R1', {
    async reserve(ctx) {
      ctx.self.boosts = (ctx.self.boosts || 0) + 2;
      ctx.self.fleeting = false;
      ctx.api.log(`${ctx.card.name} gains 2 boosts and loses Fleeting.`, 'action');
    },
  });

  // Atlas — [Gigantic]. Handled by the engine via card.keywords (no script needed).

  // Dorothy Gale — {J} You may send target Character to Reserve.
  def('ALT_CORE_B_YZ_16_R1', {
    async join(ctx) {
      const cand = ctx.api.targets({ controller: ctx.controller, side: 'any', kind: 'character', payable: true });
      if (!cand.length) return;
      const yes = await ctx.controller.agent.confirm({ card: ctx.card, player: ctx.controller, prompt: `${ctx.card.name}: send a Character to Reserve?` });
      if (!yes) return;
      const t = await ctx.api.resolveTarget({ agent: ctx.controller.agent, requester: ctx.controller, candidates: cand, intent: 'remove', prompt: 'Send which Character to Reserve?' });
      if (!t) return;
      await ctx.api.bounceToReserve(t);
      ctx.api.log(`${ctx.card.name} sends ${t.card.name} to Reserve.`, 'action');
    },
  });

  // Shenlong — [Tough 1]. Handled by the engine via card.keywords (no script needed).

  // Intimidation — spell, Fleeting: return target Character OR Permanent (cost ≤4) to owner's hand.
  def('ALT_CORE_B_BR_28_C', {
    async play(ctx) {
      const chars = ctx.api.targets({ controller: ctx.controller, side: 'any', kind: 'character', maxHandCost: 4, payable: true });
      const perms = ctx.api.targets({ controller: ctx.controller, side: 'any', kind: 'permanent', maxHandCost: 4 });
      const cand = [...chars, ...perms];
      if (!cand.length) { ctx.api.log(`${ctx.card.name} fizzles — no legal target.`, 'system'); return; }
      const t = await ctx.api.resolveTarget({ agent: ctx.controller.agent, requester: ctx.controller, candidates: cand, intent: 'remove', prompt: 'Return which card to its owner’s hand?' });
      if (!t) return;
      await ctx.api.returnToHand(t);
      ctx.api.log(`${ctx.card.name} returns ${t.card.name} to its owner’s hand.`, 'action');
    },
  });

  // Physical Training — spell: target Character (yours) gains 3 boosts; rare also draws.
  const physTrain = (draws) => ({
    async play(ctx) {
      const cand = ctx.api.targets({ controller: ctx.controller, side: 'me', kind: 'character' });
      if (cand.length) {
        const t = await ctx.api.resolveTarget({ agent: ctx.controller.agent, requester: ctx.controller, candidates: cand, intent: 'buff', prompt: 'Give 3 boosts to which Character?' });
        if (t) { t.charState.boosts = (t.charState.boosts || 0) + 3; ctx.api.log(`${ctx.card.name}: ${t.card.name} gains 3 boosts.`, 'action'); }
      } else {
        ctx.api.log(`${ctx.card.name} — no Character to boost.`, 'system');
      }
      if (draws) {
        const d = ctx.api.draw(ctx.controller, 1);
        if (d.length) ctx.api.log(`${ctx.api.who(ctx.controller)} ${ctx.controller.isHuman ? 'draw' : 'draws'} a card.`, 'draw');
      }
    },
  });
  def('ALT_CORE_A_BR_26_C', physTrain(false));
  def('ALT_CORE_B_BR_26_R1', physTrain(true));

  // The Spindle, Muna Bastion — Landmark: your Characters are Tough 2 (aura);
  // At Noon, a Character you control gains 1 boost.
  def('ALT_CORE_B_MU_30_R1', {
    aura: { toughControlled: 2 },
    async atNoon(ctx) {
      const cand = ctx.api.targets({ controller: ctx.controller, side: 'me', kind: 'character' });
      if (!cand.length) return;
      const t = await ctx.api.resolveTarget({ agent: ctx.controller.agent, requester: ctx.controller, candidates: cand, intent: 'buff', prompt: `${ctx.card.name}: give 1 boost to which Character?` });
      if (!t) return;
      t.charState.boosts = (t.charState.boosts || 0) + 1;
      ctx.api.log(`${ctx.card.name}: ${t.card.name} gains 1 boost.`, 'action');
    },
  });

  // ══════════════════════ LYRA (Nevenka & Blotch) ══════════════════════
  // LYRA is the dice deck. Every roll goes through ctx.api.rollDie / rollDice,
  // which honour The Ouroboros (roll +1 die, keep the one you choose) on their own.

  // Hero — ↻ : target a Character you control, then roll a die:
  //   6+ → Anchored, 2-5 → +1 boost, 1 → send it to Reserve.
  def('ALT_CORE_B_LY_01_C', {
    quickActions(ctx) {
      const cand = ctx.api.targets({ controller: ctx.controller, side: 'me', kind: 'character' });
      return [{
        label: 'Nevenka & Blotch — roll on a Character (exhaust Hero)', kind: 'dice',
        canRun: !ctx.self.exhausted && cand.length > 0,
        run: async () => {
          const t = await ctx.api.resolveTarget({
            agent: ctx.controller.agent, requester: ctx.controller, candidates: cand,
            optional: true, intent: 'buff', prompt: 'Roll on which Character you control?',
          });
          if (!t) return;                                  // cancelled — Hero not exhausted
          ctx.self.exhausted = true;
          const r = await ctx.api.rollDie(ctx.controller);
          const cs = t.charState;
          if (r >= 6) { cs.anchored = true; ctx.api.log(`🎲 ${t.card.name} → ${r}: gains Anchored.`, 'action'); }
          else if (r >= 2) { cs.boosts = (cs.boosts || 0) + 1; ctx.api.log(`🎲 ${t.card.name} → ${r}: gains 1 boost.`, 'action'); }
          else { await ctx.api.bounceToReserve(t); ctx.api.log(`🎲 ${t.card.name} → 1: sent to Reserve.`, 'action'); }
        },
      }];
    },
  });

  // Ouroboros Trickster — ⟐ roll: 4+ → hi boosts, else 1 boost.
  const trickster = (hi) => ({
    async join(ctx) {
      const r = await ctx.api.rollDie(ctx.controller);
      const n = r >= 4 ? hi : 1;
      ctx.self.boosts = (ctx.self.boosts || 0) + n;
      ctx.api.log(`🎲 ${ctx.card.name} → ${r}: gains ${n} boost${n > 1 ? 's' : ''}.`, 'action');
    },
  });
  def('ALT_CORE_B_LY_06_C', trickster(2));
  def('ALT_CORE_B_LY_06_R1', trickster(3));

  // Lyra Cloth Dancer — ✋ you may give target Character Fleeting (disruption when
  // aimed at an enemy: it is discarded at Rest instead of returning to Reserve).
  def('ALT_CORE_B_LY_14_C', {
    async hand(ctx) {
      const cand = ctx.api.targets({ controller: ctx.controller, side: 'any', kind: 'character', payable: true });
      if (!cand.length) return;
      const yes = await ctx.controller.agent.confirm({ card: ctx.card, player: ctx.controller, prompt: `${ctx.card.name}: give a Character Fleeting?` });
      if (!yes) return;
      const t = await ctx.api.resolveTarget({ agent: ctx.controller.agent, requester: ctx.controller, candidates: cand, optional: true, intent: 'remove', prompt: 'Give Fleeting to which Character?' });
      if (!t) return;
      t.charState.fleeting = true;
      ctx.api.log(`${ctx.card.name}: ${t.card.name} gains Fleeting.`, 'action');
    },
  });

  // Tanuki — ✋ Sabotage. Rare also: ♺ roll, on 4+ Sabotage.
  def('ALT_CORE_B_LY_09_C', { hand: sabotage });
  def('ALT_CORE_B_LY_09_R1', {
    hand: sabotage,
    async reserve(ctx) {
      const r = await ctx.api.rollDie(ctx.controller);
      ctx.api.log(`🎲 ${ctx.card.name} → ${r}.`, 'action');
      if (r >= 4) await sabotage(ctx);
    },
  });

  // Ouroboros Croupier — ✋ roll: 4+ draw a card, else Resupply.
  def('ALT_CORE_B_LY_17_C', {
    async hand(ctx) {
      const r = await ctx.api.rollDie(ctx.controller);
      if (r >= 4) {
        const d = ctx.api.draw(ctx.controller, 1);
        if (d.length) ctx.api.log(`🎲 ${ctx.card.name} → ${r}: ${ctx.controller.isHuman ? 'you draw' : 'draws'} a card.`, 'draw');
      } else {
        ctx.api.log(`🎲 ${ctx.card.name} → ${r}: Resupply.`, 'action');
        await CM.getHandler('resupply')(ctx);
      }
    },
  });

  // Asmodeus — ⟐ roll: 4+ → Anchored, else +3 boosts.
  const asmodeus = {
    async join(ctx) {
      const r = await ctx.api.rollDie(ctx.controller);
      if (r >= 4) { ctx.self.anchored = true; ctx.api.log(`🎲 ${ctx.card.name} → ${r}: gains Anchored.`, 'action'); }
      else { ctx.self.boosts = (ctx.self.boosts || 0) + 3; ctx.api.log(`🎲 ${ctx.card.name} → ${r}: gains 3 boosts.`, 'action'); }
    },
  };
  def('ALT_CORE_B_LY_20_C', asmodeus);
  def('ALT_CORE_B_LY_20_R1', asmodeus);

  // All In! — spell: roll, target Character you control gains X boosts (X = result).
  def('ALT_CORE_B_LY_25_C', {
    async play(ctx) {
      const cand = ctx.api.targets({ controller: ctx.controller, side: 'me', kind: 'character' });
      if (!cand.length) { ctx.api.log(`${ctx.card.name} fizzles — no Character to boost.`, 'system'); return; }
      const t = await ctx.api.resolveTarget({ agent: ctx.controller.agent, requester: ctx.controller, candidates: cand, intent: 'buff', prompt: 'All In! — boost which Character?' });
      if (!t) return;
      const r = await ctx.api.rollDie(ctx.controller);
      t.charState.boosts = (t.charState.boosts || 0) + r;
      ctx.api.log(`🎲 All In! → ${r}: ${t.card.name} gains ${r} boost${r > 1 ? 's' : ''}.`, 'action');
    },
  });

  // Paint Prison — spell (Fleeting): may discard a Reserve card to cut cost; return
  // target Character or Permanent to the top of its owner's deck.
  const paintPrison = (reduce) => ({
    costReduction: { perReserveDiscard: reduce, max: 1 },
    async play(ctx) {
      const chars = ctx.api.targets({ controller: ctx.controller, side: 'any', kind: 'character', payable: true });
      const perms = ctx.api.targets({ controller: ctx.controller, side: 'any', kind: 'permanent' });
      const cand = [...chars, ...perms];
      if (!cand.length) { ctx.api.log(`${ctx.card.name} fizzles — no legal target.`, 'system'); return; }
      const t = await ctx.api.resolveTarget({ agent: ctx.controller.agent, requester: ctx.controller, candidates: cand, intent: 'remove', prompt: 'Return which card to the top of its owner’s deck?' });
      if (!t) return;
      await ctx.api.returnToTopOfDeck(t);
      ctx.api.log(`${ctx.card.name} returns ${t.card.name} to the top of its owner’s deck.`, 'action');
    },
  });
  def('ALT_CORE_B_LY_26_C', paintPrison(2));
  def('ALT_CORE_B_LY_26_R1', paintPrison(1));

  // Off You Go! — spell: send target Character (Hand Cost ≤5) to Reserve.
  def('ALT_CORE_B_YZ_21_R1', {
    async play(ctx) {
      const cand = ctx.api.targets({ controller: ctx.controller, side: 'any', kind: 'character', maxHandCost: 5, payable: true });
      if (!cand.length) { ctx.api.log(`${ctx.card.name} fizzles — no legal target.`, 'system'); return; }
      const t = await ctx.api.resolveTarget({ agent: ctx.controller.agent, requester: ctx.controller, candidates: cand, intent: 'remove', prompt: 'Send which Character (cost ≤5) to Reserve?' });
      if (!t) return;
      await ctx.api.bounceToReserve(t);
      ctx.api.log(`${ctx.card.name} sends ${t.card.name} to Reserve.`, 'action');
    },
  });

  // Kadigiran Mage-Dancer — when you play a Spell, +1 boost; At Dusk, if 3+ boosts, draw.
  def('ALT_CORE_B_YZ_07_R1', {
    on: {
      async playSpell(ctx) {
        if (ctx.event.controller !== ctx.controller) return;          // only YOUR spells
        ctx.self.boosts = (ctx.self.boosts || 0) + 1;
        ctx.api.log(`${ctx.card.name} gains 1 boost (you played a Spell).`, 'action');
      },
    },
    async atDusk(ctx) {
      if ((ctx.self.boosts || 0) < 3) return;
      const d = ctx.api.draw(ctx.controller, 1);
      if (d.length) ctx.api.log(`${ctx.card.name}: 3+ boosts at Dusk — ${ctx.controller.isHuman ? 'you draw' : 'draws'} a card.`, 'draw');
    },
  });

  // The Ouroboros, Lyra Bastion — dice modifier: roll +1 die, ignore one of your
  // choice (consumed by the engine's rollDice via hasDiceMod).
  def('ALT_CORE_B_LY_30_R1', { diceMod: 'ouroboros' });

  // ══════════════════════ MUNA (Teija & Nauraa) ══════════════════════
  // Plants, persistence (self-Anchor), boosts, and a little disruption (Asleep /
  // mass-Fleeting). The Hero's "the first Character you play each Afternoon gains a
  // boost" is the generic firstCharBoost passive applied in game.js playCard.

  // ⟐ I gain Anchored — Spindle Harvesters, Sneezer Shroom, Coniferal Coneman.
  const selfAnchor = {
    async join(ctx) { ctx.self.anchored = true; ctx.api.log(`${ctx.card.name} gains Anchored.`, 'action'); },
  };
  def('ALT_CORE_B_MU_06_C', selfAnchor);    // Spindle Harvesters
  def('ALT_CORE_B_MU_08_C', selfAnchor);    // Sneezer Shroom
  def('ALT_CORE_B_MU_20_C', selfAnchor);    // Coniferal Coneman
  def('ALT_CORE_B_MU_20_R1', selfAnchor);   // Coniferal Coneman (rare)

  // Sneezer Shroom (rare) — ⟐ Anchored; At Noon I gain 1 boost.
  def('ALT_CORE_B_MU_08_R1', {
    ...selfAnchor,
    async atNoon(ctx) { ctx.self.boosts = (ctx.self.boosts || 0) + 1; ctx.api.log(`${ctx.card.name} gains 1 boost (At Noon).`, 'action'); },
  });

  // Yong-Su, Verdant Weaver — ⟐ if you control 2+ Plants, I gain 2 boosts. (Yong-Su
  // is a Druid, not a Plant, so it never counts itself.)
  const yongSu = {
    async join(ctx) {
      const plants = [...ctx.controller.heroExp, ...ctx.controller.compExp]
        .filter(cs => CM.hasSubtype(cs.card, 'Plant')).length;
      if (plants < 2) return;
      ctx.self.boosts = (ctx.self.boosts || 0) + 2;
      ctx.api.log(`${ctx.card.name} gains 2 boosts (you control ${plants} Plants).`, 'action');
    },
  };
  def('ALT_CORE_B_MU_10_C', yongSu);
  def('ALT_CORE_B_MU_10_R1', yongSu);

  // Kitsune — ✋ Each player draws a card.
  def('ALT_CORE_B_MU_05_C', {
    async hand(ctx) {
      for (const p of [ctx.controller, ctx.opponent]) {
        const d = ctx.api.draw(p, 1);
        if (d.length) ctx.api.log(`${ctx.api.who(p)} ${p.isHuman ? 'draw' : 'draws'} a card (Kitsune).`, 'draw');
      }
    },
  });

  // Daughter of Yggdrasil — ✋ Target opponent draws a card (the drawback; the body
  // is a 5/5/3 Plant that fuels Yong-Su).
  def('ALT_CORE_B_MU_12_C', {
    async hand(ctx) {
      const d = ctx.api.draw(ctx.opponent, 1);
      if (d.length) ctx.api.log(`${ctx.api.who(ctx.opponent)} ${ctx.opponent.isHuman ? 'draw' : 'draws'} a card (Daughter of Yggdrasil).`, 'draw');
    },
  });

  // Parvati — ⟐ a Character you control gains Anchored.
  def('ALT_CORE_B_MU_18_R1', {
    async join(ctx) {
      const cand = ctx.api.targets({ controller: ctx.controller, side: 'me', kind: 'character' });
      if (!cand.length) return;
      const t = await ctx.api.resolveTarget({ agent: ctx.controller.agent, requester: ctx.controller, candidates: cand, intent: 'buff', prompt: `${ctx.card.name}: give Anchored to which Character?` });
      if (!t) return;
      t.charState.anchored = true;
      ctx.api.log(`${ctx.card.name}: ${t.card.name} gains Anchored.`, 'action');
    },
  });

  // Nurture — spell: up to two Characters you control each gain N boosts.
  const nurture = (n) => ({
    async play(ctx) {
      let cand = ctx.api.targets({ controller: ctx.controller, side: 'me', kind: 'character' });
      if (!cand.length) { ctx.api.log(`${ctx.card.name} fizzles — no Character to boost.`, 'system'); return; }
      for (let i = 0; i < 2 && cand.length; i++) {
        const t = await ctx.api.resolveTarget({
          agent: ctx.controller.agent, requester: ctx.controller, candidates: cand, optional: true, intent: 'buff',
          prompt: `${ctx.card.name} — give ${n} boost${n > 1 ? 's' : ''} to ${i === 0 ? 'a Character (up to two)' : 'a second Character (optional)'}.`,
        });
        if (!t) break;
        t.charState.boosts = (t.charState.boosts || 0) + n;
        ctx.api.log(`${ctx.card.name}: ${t.card.name} gains ${n} boost${n > 1 ? 's' : ''}.`, 'action');
        cand = cand.filter(c => c.uid !== t.uid);
      }
    },
  });
  def('ALT_CORE_B_MU_27_C', nurture(1));
  def('ALT_CORE_B_MU_27_R1', nurture(2));

  // Beauty Sleep — spell: target Character gains Asleep (its stats are ignored at the
  // next Dusk; it then stays in play and loses Asleep at Night).
  def('ALT_CORE_B_MU_28_C', {
    async play(ctx) {
      const cand = ctx.api.targets({ controller: ctx.controller, side: 'any', kind: 'character', payable: true });
      if (!cand.length) { ctx.api.log(`${ctx.card.name} fizzles — no legal target.`, 'system'); return; }
      const t = await ctx.api.resolveTarget({ agent: ctx.controller.agent, requester: ctx.controller, candidates: cand, intent: 'remove', prompt: 'Put which Character to sleep?' });
      if (!t) return;
      t.charState.asleep = true;
      ctx.api.log(`${ctx.card.name}: ${t.card.name} gains Asleep.`, 'action');
    },
  });

  // Meditation Training — spell: a Character you control with Hand Cost ≤3 gains Anchored.
  const meditation = {
    async play(ctx) {
      const cand = ctx.api.targets({ controller: ctx.controller, side: 'me', kind: 'character', maxHandCost: 3 });
      if (!cand.length) { ctx.api.log(`${ctx.card.name} fizzles — no Character (Hand Cost ≤3) to Anchor.`, 'system'); return; }
      const t = await ctx.api.resolveTarget({ agent: ctx.controller.agent, requester: ctx.controller, candidates: cand, intent: 'buff', prompt: 'Give Anchored to which Character (Hand Cost ≤3)?' });
      if (!t) return;
      t.charState.anchored = true;
      ctx.api.log(`${ctx.card.name}: ${t.card.name} gains Anchored.`, 'action');
    },
    // Support: the next Character you play this turn gains 1 boost.
    support: supBoostNextChar('Meditation Training', 1),
  };
  def('ALT_CORE_A_MU_25_C', meditation);
  def('ALT_CORE_A_MU_25_R1', meditation);

  // Lyra Cloth Dancer (the RARE printing the Muna deck runs) — ✋ Each Character
  // controlled by target player gains Fleeting. (The common LY_14_C, single-target,
  // is scripted separately in the LYRA section.)
  def('ALT_CORE_B_LY_14_R1', {
    async hand(ctx) {
      const options = [
        { key: 'opp', label: `${ctx.api.who(ctx.opponent)} — their Characters gain Fleeting` },
        { key: 'me', label: 'You — your Characters gain Fleeting' },
      ];
      const key = await ctx.controller.agent.chooseOption({ card: ctx.card, player: ctx.controller, prompt: `${ctx.card.name}: whose Characters gain Fleeting?`, options });
      const target = key === 'me' ? ctx.controller : ctx.opponent;
      let n = 0;
      for (const cs of [...target.heroExp, ...target.compExp]) if (!cs.fleeting) { cs.fleeting = true; n++; }
      ctx.api.log(`${ctx.card.name}: ${n} Character${n === 1 ? '' : 's'} controlled by ${ctx.api.who(target)} gain Fleeting.`, 'action');
    },
  });

  // ══════════════════════ ORDIS (Sigismar & Wingspan) ══════════════════════
  // The Soldier/token deck: muster Ordis Recruit 1/1/1 tokens everywhere, then pay
  // them off (The Monolith boosts every joiner; Kakoba/Charge! scale with the swarm;
  // Jeanne d'Arc replaces herself with Recruits whenever she leaves an Expedition).

  const RECRUIT = { name: 'Ordis Recruit', forest: 1, mountain: 1, water: 1, subtype: 'Soldier' };
  // Drop a Recruit into a specific Expedition ('hero' | 'companion'); no prompt.
  async function makeRecruit(ctx, which, controller) {
    const p = controller || ctx.controller;
    await ctx.api.createToken(p, RECRUIT, which);
    ctx.api.log(`${ctx.api.who(p)} ${p.isHuman ? 'create' : 'creates'} an Ordis Recruit 1/1/1 Soldier token.`, 'action');
  }

  // Hero — At Noon, create a Recruit in your Hero Expedition (not on Day 1).
  def('ALT_CORE_B_OR_01_C', {
    async atNoon(ctx) {
      if (ctx.state.day <= 1) return;                      // "Ignore my ability during the first Day."
      await makeRecruit(ctx, 'hero');
    },
  });

  // Ordis Cadets — ⟐ create a Recruit in my Expedition.
  def('ALT_CORE_B_OR_06_C', { async join(ctx) { await makeRecruit(ctx, ctx.self.expedition); } });
  // Ordis Gatekeeper — ⟐ create a Recruit in your OTHER Expedition.
  def('ALT_CORE_B_OR_13_C', {
    async join(ctx) { await makeRecruit(ctx, ctx.self.expedition === 'companion' ? 'hero' : 'companion'); },
  });
  // Ordis Carrier — Landmark: At Noon create a Recruit in your Companion Expedition.
  def('ALT_CORE_B_OR_30_C', { async atNoon(ctx) { await makeRecruit(ctx, 'companion'); } });

  // The Monolith, Ordis Bastion — Landmark: when a Character joins your Expeditions,
  // it gains 1 boost.
  def('ALT_CORE_B_OR_28_C', {
    on: {
      async characterJoins(ctx) {
        if (ctx.event.controller !== ctx.controller) return;
        const cs = ctx.event.charState;
        cs.boosts = (cs.boosts || 0) + 1;
        ctx.api.log(`The Monolith: ${cs.card.name} gains 1 boost.`, 'action');
      },
    },
  });

  // Kakoba, Legion Commander — ⟐ if you control 3+ OTHER Characters, I gain N boosts.
  const kakoba = (n) => ({
    async join(ctx) {
      const others = [...ctx.controller.heroExp, ...ctx.controller.compExp].filter(cs => cs !== ctx.self).length;
      if (others < 3) return;
      ctx.self.boosts = (ctx.self.boosts || 0) + n;
      ctx.api.log(`${ctx.card.name} gains ${n} boosts (you control ${others} other Characters).`, 'action');
    },
  });
  def('ALT_CORE_B_OR_15_C', kakoba(2));
  def('ALT_CORE_B_OR_15_R1', kakoba(3));

  // Monolith Rune-Scribe (rare) — ✋ if you control a token, Resupply.
  def('ALT_CORE_B_OR_07_R1', {
    async hand(ctx) {
      const hasToken = [...ctx.controller.heroExp, ...ctx.controller.compExp].some(cs => cs.card.token);
      if (!hasToken) { ctx.api.log(`${ctx.card.name}: no token controlled — no Resupply.`, 'system'); return; }
      await CM.getHandler('resupply')(ctx);
    },
  });

  // Ordis Spy — ✋ Sabotage; the rare also ♺ creates a Recruit in my Expedition.
  def('ALT_CORE_B_OR_14_C', { hand: sabotage });
  def('ALT_CORE_B_OR_14_R1', {
    hand: sabotage,
    async reserve(ctx) { await makeRecruit(ctx, ctx.self.expedition); },
  });

  // Jeanne d'Arc — when I leave the Expedition zone, muster Recruits in BOTH of your
  // Expeditions (common: 1 each; rare: 2 each). Fired by the engine on Rest/bounce/etc.
  const jeanne = (per) => ({
    async onLeave(ctx) {
      ctx.api.log(`${ctx.card.name} leaves — Ordis Recruits muster in your Expeditions.`, 'action');
      for (const which of ['hero', 'companion']) for (let i = 0; i < per; i++) await makeRecruit(ctx, which);
    },
  });
  def('ALT_CORE_B_OR_17_C', jeanne(1));
  def('ALT_CORE_B_OR_17_R1', jeanne(2));

  // Charge! — spell (Fleeting): Characters you control each gain 1 boost.
  def('ALT_CORE_B_OR_23_C', {
    async play(ctx) {
      const chars = [...ctx.controller.heroExp, ...ctx.controller.compExp];
      if (!chars.length) { ctx.api.log(`${ctx.card.name} fizzles — no Characters to boost.`, 'system'); return; }
      for (const cs of chars) cs.boosts = (cs.boosts || 0) + 1;
      ctx.api.log(`${ctx.card.name}: your ${chars.length} Character${chars.length === 1 ? '' : 's'} gain 1 boost.`, 'action');
    },
  });

  // Sticky Note Seals — spell (Fleeting): choose one — send a Character (Hand Cost ≥4)
  // to Reserve, or discard a Permanent (Hand Cost ≥4).
  def('ALT_CORE_B_OR_25_C', {
    async play(ctx) {
      const chars = ctx.api.targets({ controller: ctx.controller, side: 'any', kind: 'character', minHandCost: 4, payable: true });
      const perms = ctx.api.targets({ controller: ctx.controller, side: 'any', kind: 'permanent', minHandCost: 4 });
      const options = [];
      if (chars.length) options.push({ key: 'bounce', label: 'Send a Character (Hand Cost ≥4) to Reserve' });
      if (perms.length) options.push({ key: 'destroy', label: 'Discard a Permanent (Hand Cost ≥4)' });
      if (!options.length) { ctx.api.log(`${ctx.card.name} fizzles — no legal target.`, 'system'); return; }
      const key = options.length === 1 ? options[0].key
        : await ctx.controller.agent.chooseOption({ card: ctx.card, player: ctx.controller, prompt: 'Sticky Note Seals — choose one:', options });
      if (key === 'bounce') {
        const t = await ctx.api.resolveTarget({ agent: ctx.controller.agent, requester: ctx.controller, candidates: chars, intent: 'remove', prompt: 'Send which Character (≥4) to Reserve?' });
        if (t) { await ctx.api.bounceToReserve(t); ctx.api.log(`${ctx.card.name} sends ${t.card.name} to Reserve.`, 'action'); }
      } else {
        const t = await ctx.api.resolveTarget({ agent: ctx.controller.agent, requester: ctx.controller, candidates: perms, intent: 'remove', prompt: 'Discard which Permanent (≥4)?' });
        if (t) { ctx.api.destroyPermanent(t); ctx.api.log(`${ctx.card.name} discards ${t.card.name}.`, 'action'); }
      }
    },
  });

  // Open the Gates — spell: create four Recruits, distributed as you choose among your
  // Expeditions (own lanes only — see the no-enemy-seeding limitation).
  def('ALT_CORE_B_OR_26_R1', {
    async play(ctx) {
      for (let i = 0; i < 4; i++) {
        const which = await ctx.controller.agent.chooseExpedition({ card: ctx.card, player: ctx.controller, prompt: `Open the Gates — place Recruit ${i + 1} of 4 in which Expedition?` });
        await makeRecruit(ctx, which || 'hero');
      }
    },
  });

  // ══════════════════════ YZMIR (Akesha & Taru) ══════════════════════
  // The control / disruption deck: bounce, backwards movement, hard discard, card
  // draw, sabotage, and the Hero's "After You" tempo (its turn-flow lives in game.js;
  // here it just carries the `afterYou` marker the engine looks for).
  def('ALT_CORE_B_YZ_01_C', { afterYou: true });

  // Baba Yaga — ✋ Draw a card. (Card text is localised, so not auto-detected.)
  const drawOne = {
    async hand(ctx) {
      const d = ctx.api.draw(ctx.controller, 1);
      if (d.length) ctx.api.log(`${ctx.api.who(ctx.controller)} ${ctx.controller.isHuman ? 'draw' : 'draws'} a card (${ctx.card.name}).`, 'draw');
    },
  };
  def('ALT_CORE_B_YZ_11_C', drawOne);
  def('ALT_CORE_B_YZ_11_R1', drawOne);

  // Tooth Fairy — ✋ Sabotage.
  def('ALT_CORE_B_YZ_06_R1', { hand: sabotage });

  // Dorothy Gale (common) — ✋ you may send target Character to Reserve. (The rare
  // YZ_16_R1, the same effect on ⟐, is scripted in the BRAVOS section.)
  def('ALT_CORE_B_YZ_16_C', {
    async hand(ctx) {
      const cand = ctx.api.targets({ controller: ctx.controller, side: 'any', kind: 'character', payable: true });
      if (!cand.length) return;
      const yes = await ctx.controller.agent.confirm({ card: ctx.card, player: ctx.controller, prompt: `${ctx.card.name}: send a Character to Reserve?` });
      if (!yes) return;
      const t = await ctx.api.resolveTarget({ agent: ctx.controller.agent, requester: ctx.controller, candidates: cand, optional: true, intent: 'remove', prompt: 'Send which Character to Reserve?' });
      if (!t) return;
      await ctx.api.bounceToReserve(t);
      ctx.api.log(`${ctx.card.name} sends ${t.card.name} to Reserve.`, 'action');
    },
  });

  // Off You Go! (common) — spell: send target Character (Hand Cost ≤3) to Reserve.
  // (The rare YZ_21_R1, ≤5, is scripted in the LYRA section.)
  def('ALT_CORE_B_YZ_21_C', {
    async play(ctx) {
      const cand = ctx.api.targets({ controller: ctx.controller, side: 'any', kind: 'character', maxHandCost: 3, payable: true });
      if (!cand.length) { ctx.api.log(`${ctx.card.name} fizzles — no legal target.`, 'system'); return; }
      const t = await ctx.api.resolveTarget({ agent: ctx.controller.agent, requester: ctx.controller, candidates: cand, intent: 'remove', prompt: 'Send which Character (cost ≤3) to Reserve?' });
      if (!t) return;
      await ctx.api.bounceToReserve(t);
      ctx.api.log(`${ctx.card.name} sends ${t.card.name} to Reserve.`, 'action');
    },
  });

  // Sakarabru — ✋ the opponent's Expedition facing me (same lane) moves back a region.
  const sakarabru = {
    async hand(ctx) {
      const which = ctx.self.expedition;
      const moved = ctx.api.moveExpeditionBackwards(ctx.opponent, which);
      if (moved) ctx.api.log(`${ctx.card.name}: ${ctx.api.who(ctx.opponent)}'s ${which} Expedition retreats one region.`, 'action');
      else ctx.api.log(`${ctx.card.name}: ${ctx.api.who(ctx.opponent)}'s ${which} Expedition is already at its start.`, 'system');
    },
    // Support: draw a card.
    support: (ctx) => ({
      label: 'Sakarabru — draw a card (discard)',
      canRun: true,
      effect: async () => {
        const d = ctx.api.draw(ctx.controller, 1);
        if (d.length) ctx.api.log(`Sakarabru: ${ctx.controller.isHuman ? 'you draw' : 'draws'} a card.`, 'draw');
      },
    }),
  };
  def('ALT_CORE_B_YZ_18_C', sakarabru);
  def('ALT_CORE_B_YZ_18_R1', sakarabru);

  // Monolith Archivist — Defender unless you control 2+ OTHER Bureaucrats. The engine's
  // evalMove consults this predicate; a Defender pins its Expedition at Dusk.
  def('ALT_CORE_B_OR_10_R1', {
    defender(ctx) {
      const bureaucrats = [...ctx.controller.heroExp, ...ctx.controller.compExp]
        .filter(cs => cs !== ctx.self && CM.hasSubtype(cs.card, 'Bureaucrat')).length;
      return bureaucrats < 2;
    },
  });

  // Spy Craft — spell (Fleeting): Sabotage, then Resupply.
  def('ALT_CORE_B_YZ_22_C', {
    async play(ctx) {
      await sabotage(ctx);
      await CM.getHandler('resupply')(ctx);
    },
  });

  // Banishing Gate — spell (Fleeting): discard target Character or Permanent (hard
  // removal — the Character goes to its owner's Discard, not Reserve).
  def('ALT_CORE_B_YZ_24_C', {
    async play(ctx) {
      const chars = ctx.api.targets({ controller: ctx.controller, side: 'any', kind: 'character', payable: true });
      const perms = ctx.api.targets({ controller: ctx.controller, side: 'any', kind: 'permanent' });
      const cand = [...chars, ...perms];
      if (!cand.length) { ctx.api.log(`${ctx.card.name} fizzles — no legal target.`, 'system'); return; }
      const t = await ctx.api.resolveTarget({ agent: ctx.controller.agent, requester: ctx.controller, candidates: cand, intent: 'remove', prompt: 'Discard which Character or Permanent?' });
      if (!t) return;
      if (t.zone === 'expedition') await ctx.api.discardCharacter(t);
      else ctx.api.destroyPermanent(t);
      ctx.api.log(`${ctx.card.name} discards ${t.card.name}.`, 'action');
    },
  });

  // Kraken's Wrath — spell (Fleeting): send to Reserve up to three Characters with a
  // total Hand Cost ≤5.
  def('ALT_CORE_B_YZ_26_C', {
    async play(ctx) {
      let budget = 5, n = 0;
      for (let i = 0; i < 3; i++) {
        const cand = ctx.api.targets({ controller: ctx.controller, side: 'any', kind: 'character', maxHandCost: budget, payable: true });
        if (!cand.length) break;
        const t = await ctx.api.resolveTarget({ agent: ctx.controller.agent, requester: ctx.controller, candidates: cand, optional: true, intent: 'remove', prompt: `Kraken's Wrath — send a Character to Reserve (≤${budget} cost budget left).` });
        if (!t) break;
        await ctx.api.bounceToReserve(t);
        budget -= (t.card.handCost || 0); n++;
        ctx.api.log(`${ctx.card.name} sends ${t.card.name} to Reserve.`, 'action');
        if (budget <= 0) break;
      }
      if (!n) ctx.api.log(`${ctx.card.name} fizzles — no legal target.`, 'system');
    },
  });

  // Beauty Sleep (rare printing the Yzmir deck runs) — Target Character gains Asleep;
  // you may also give it 2 boosts (only ever useful on your own Character, so the boost
  // is offered for own targets). The common MU_28_C is the boost-less version above.
  def('ALT_CORE_B_MU_28_R1', {
    async play(ctx) {
      const cand = ctx.api.targets({ controller: ctx.controller, side: 'any', kind: 'character', payable: true });
      if (!cand.length) { ctx.api.log(`${ctx.card.name} fizzles — no legal target.`, 'system'); return; }
      const t = await ctx.api.resolveTarget({ agent: ctx.controller.agent, requester: ctx.controller, candidates: cand, intent: 'remove', prompt: 'Put which Character to sleep?' });
      if (!t) return;
      t.charState.asleep = true;
      ctx.api.log(`${ctx.card.name}: ${t.card.name} gains Asleep.`, 'action');
      if (t.owner === ctx.controller) {
        const yes = await ctx.controller.agent.confirm({ card: ctx.card, player: ctx.controller, prompt: `${ctx.card.name}: also give ${t.card.name} 2 boosts?` });
        if (yes) { t.charState.boosts = (t.charState.boosts || 0) + 2; ctx.api.log(`${ctx.card.name}: ${t.card.name} gains 2 boosts.`, 'action'); }
      }
    },
  });

  // ══════════════════════ SUPPORT-ONLY CARDS ══════════════════════
  // These commons/rares carry no in-play ability — their only printed text is a
  // Support ability ({D}: discard from Reserve). (Sakarabru & Meditation Training
  // carry their Support inline above, alongside their main effect.)

  // AXIOM — Foundry Mechanic: next Permanent you play this turn costs 1 less.
  const foundryMechanic = { support: supNextCostsLess('Foundry Mechanic', 'Permanent', TYPE_PERMANENT) };
  def('ALT_CORE_B_AX_07_C', foundryMechanic);
  def('ALT_CORE_B_AX_07_R1', foundryMechanic);

  // AXIOM (rare) — Jian, Assembly Overseer: re-activate the join ({J}) abilities
  // of a target Permanent you control.
  def('ALT_CORE_B_AX_10_R1', {
    support(ctx) {
      const cand = ctx.api.targets({ controller: ctx.controller, side: 'me', kind: 'permanent' });
      return {
        label: 'Jian — re-trigger a Permanent’s join ability (discard)',
        canRun: cand.length > 0,
        effect: async () => {
          const t = await ctx.api.resolveTarget({
            agent: ctx.controller.agent, requester: ctx.controller, candidates: cand,
            optional: true, intent: 'buff', prompt: 'Re-activate which Permanent’s join ability?',
          });
          if (!t) return;
          ctx.api.log(`Jian: re-activates ${t.card.name}'s join ability.`, 'action');
          await ctx.api.activateJoin(t.landmarkState, ctx.controller);
        },
      };
    },
  });

  // BRAVOS — Issun-bōshi / Haven Warrior (rare): next Character gains 1 boost.
  def('ALT_CORE_B_BR_05_C', { support: supBoostNextChar('Issun-bōshi', 1) });
  def('ALT_CORE_B_BR_17_R1', { support: supBoostNextChar('Haven Warrior', 1) });

  // LYRA — Hathor: return another card from your Reserve to your hand.
  def('ALT_CORE_B_LY_07_C', {
    support(ctx) {
      const p = ctx.controller;
      return {
        label: 'Hathor — return another Reserve card to hand (discard)',
        canRun: p.reserve.length >= 2,                 // Hathor + at least one other card
        effect: async () => {
          const pool = p.reserve.filter(c => c !== ctx.card);   // Hathor is already discarded by the engine
          if (!pool.length) return;
          const picks = await p.agent.chooseCards({
            player: p, cards: pool, min: 1, max: 1, purpose: 'returnToHand',
            prompt: 'Return which card from your Reserve to your hand?',
          });
          const card = (picks && picks[0]) || pool[0];
          ctx.api.returnReserveToHand(p, card);
          ctx.api.log(`Hathor: ${card.name} returns from Reserve to your hand.`, 'action');
        },
      };
    },
  });

  // LYRA — The Hatter / MUNA — Muna Druid: Anchor a target Character (cost ≤3).
  def('ALT_CORE_B_LY_18_C', { support: supAnchorTarget('The Hatter') });
  def('ALT_CORE_B_MU_13_C', { support: supAnchorTarget('Muna Druid') });

  // YZMIR — Studious Disciple: next Spell you play this turn costs 1 less.
  def('ALT_CORE_B_YZ_04_C', { support: supNextCostsLess('Studious Disciple', 'Spell', TYPE_SPELL) });

  // YZMIR — Alice: After You (end your turn as if you played a card, without
  // passing). Usable only as First Player while your opponent hasn't passed.
  const aliceAfterYou = (ctx) => ({
    label: 'Alice — After You (discard)',
    canRun: ctx.state.firstPlayer === ctx.controller && !ctx.opponent.passed,
    endsTurn: true,
    effect: async () => {
      ctx.api.log('Alice: After You — you let your opponent act first.', 'phase');
    },
  });
  def('ALT_CORE_B_YZ_13_C', { support: aliceAfterYou });
  def('ALT_CORE_B_YZ_13_R1', { support: aliceAfterYou });

  return {
    def,
    get: (id) => SCRIPTS[id] || null,
    has: (id) => Object.prototype.hasOwnProperty.call(SCRIPTS, id),
    ids: () => Object.keys(SCRIPTS),
  };
})();

if (typeof module !== 'undefined') module.exports = CardScripts;
