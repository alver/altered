// bot.js — Simple, "dumb" heuristic opponent.
//
// The bot is always state.opp. It drives the same engine actions the human does
// and answers its own prompts through BotAI.agent. Each Afternoon turn it plays
// exactly one card or passes (after any free quick actions).

const BotAI = (() => {
  const CM = CardManager;
  const delay = (ms) => new Promise(r => setTimeout(r, ms));

  // Monolith Archivist is a Defender in this deck (no other Bureaucrats), so playing it
  // would pin a lane — the simple bot avoids it (and manas it off as low value).
  const SELF_LOCK = 'ALT_CORE_B_OR_10_R1';
  // Rough desirability of a card (higher = keep / play sooner).
  function value(card) {
    if (card.id === SELF_LOCK) return 0;
    if (card.type === 'character') return (card.forest + card.mountain + card.water) - card.handCost * 0.5;
    if ((card.ability && Object.keys(card.ability).length) || CardScripts.get(card.id)) return 3;   // does something
    return 1;
  }
  function power(card) { return card.type === 'character' ? card.forest + card.mountain + card.water : 0; }
  function csPower(cs) { return CM.power(cs); }                    // base + boosts
  const hasEffect = (card) => (card.ability && Object.keys(card.ability).length) || !!CardScripts.get(card.id);

  // ─── ONE AFTERNOON TURN ────────────────────────────────────────
  async function takeAfternoonTurn(state, E) {
    const p = state.current;
    const opp = E.opponentOf(p);

    // Free quick action: draw if the hand is thin and mana is spare.
    const qa = E.availableQuickActions(p).find(a => a.canRun && a.kind === 'draw');
    if (qa && p.hand.length <= 1 && CM.readyMana(p) >= 2) { await qa.run(); E.notify(); await delay(160); }

    const myChars = [...p.heroExp, ...p.compExp];
    const enemyChars = [...opp.heroExp, ...opp.compExp];

    // Free dice quick action: Nevenka rolls on a Character we control (mostly
    // upside — boost or Anchored, only a 1-in-6 bounce to Reserve).
    const dice = E.availableQuickActions(p).find(a => a.canRun && a.kind === 'dice');
    if (dice && myChars.length) { await dice.run(); E.notify(); await delay(200); }

    const affordable = p.hand.filter(c => E.canAfford(c, p, false));
    // Removal/disruption spells aimed at an enemy blocker (Kelon Burst, Intimidation,
    // Off You Go!, Paint Prison; MU Beauty Sleep zeroes its stats next Dusk). Lyra Cloth
    // Dancer is a Character, so its mass-Fleeting fires when the bot plays it normally.
    const isRemoval = (c) => c.type === 'spell' && (c.id.startsWith('ALT_CORE_B_AX_23') || c.id.startsWith('ALT_CORE_B_BR_28') || c.id.startsWith('ALT_CORE_B_YZ_21') || c.id.startsWith('ALT_CORE_B_LY_26') || c.id.startsWith('ALT_CORE_B_MU_28') || c.id.startsWith('ALT_CORE_B_YZ_24') || c.id.startsWith('ALT_CORE_B_YZ_26'));
    // Buff spells that grow our own board (Physical Training, All In!, Nurture,
    // Meditation Training, ORDIS Charge! — the last boosts the whole Soldier swarm).
    const isBuff = (c) => c.type === 'spell' && (c.id.startsWith('ALT_CORE_A_BR_26') || c.id.startsWith('ALT_CORE_B_BR_26') || c.id.startsWith('ALT_CORE_B_LY_25') || c.id.startsWith('ALT_CORE_B_MU_27') || c.id.startsWith('ALT_CORE_A_MU_25') || c.id.startsWith('ALT_CORE_B_OR_23'));
    const removal = affordable.find(isRemoval);

    // Answer a big enemy threat with a removal spell (cost-≤4 blocker).
    if (removal) {
      const threat = enemyChars.filter(cs => (cs.card.handCost || 0) <= 4).sort((a, b) => csPower(b) - csPower(a))[0];
      if (threat && csPower(threat) >= 6) { await E.playCard(p, removal, false); await delay(220); return; }
    }

    // ORDIS Sticky Note Seals hits a Character or Permanent with Hand Cost ≥4.
    const sticky = affordable.find(c => c.id.startsWith('ALT_CORE_B_OR_25'));
    if (sticky) {
      const bigThreat = enemyChars.filter(cs => (cs.card.handCost || 0) >= 4).sort((a, b) => csPower(b) - csPower(a))[0];
      const bigPerm = opp.landmarks.some(l => (l.card.handCost || 0) >= 4);
      if ((bigThreat && csPower(bigThreat) >= 6) || bigPerm) { await E.playCard(p, sticky, false); await delay(220); return; }
    }

    // ORDIS Open the Gates — four Recruits at once is a big tempo swing; take it.
    const openGates = affordable.find(c => c.id.startsWith('ALT_CORE_B_OR_26'));
    if (openGates) { await E.playCard(p, openGates, false); await delay(220); return; }

    // Strongest affordable character into the lane that needs it (skip the self-locking Defender).
    const chars = affordable.filter(c => c.type === 'character' && c.id !== SELF_LOCK).sort((a, b) => power(b) - power(a) || value(b) - value(a));
    if (chars.length) { await E.playCard(p, chars[0], false); await delay(220); return; }

    // Buff spell when we have a body to grow (Physical Training).
    const buff = affordable.find(isBuff);
    if (buff && myChars.length) { await E.playCard(p, buff, false); await delay(220); return; }

    // A useful Permanent (legacy ability OR card script) within the Landmark limit.
    const perm = affordable.find(c => (c.type === 'permanent' || c.type === 'landmark')
      && hasEffect(c) && p.landmarks.length < p.landmarkLimit);
    if (perm) { await E.playCard(p, perm, false); await delay(220); return; }

    // Spare removal if any legal target exists at all.
    if (removal) {
      const anyChar = [...enemyChars, ...myChars].some(cs => (cs.card.handCost || 0) <= 4);
      const anyPerm = [...opp.landmarks, ...p.landmarks].some(l => (l.card.handCost || 0) <= 4);
      if (anyChar || anyPerm) { await E.playCard(p, removal, false); await delay(220); return; }
    }

    // Low-risk utility: YZMIR Spy Craft (Sabotage + Resupply) is card-positive filler.
    const utility = affordable.find(c => c.id.startsWith('ALT_CORE_B_YZ_22'));
    if (utility) { await E.playCard(p, utility, false); await delay(220); return; }

    // Nothing worth doing — pass.
    p.passed = true;
    E.addLog(`${p.name} passes.`, 'phase');
    E.notify();
  }

  // ─── AGENT (answers the bot's own prompts) ─────────────────────
  const agent = {
    // Setup: bury the costliest cards as Mana, keep cheap plays. Morning: ramp
    // with the least valuable spare card.
    async chooseManaCards({ player, hand, count, optional }) {
      if (count >= 3) {  // setup — pick the `count` highest-cost cards for Mana
        return [...hand].sort((a, b) => b.handCost - a.handCost).slice(0, count);
      }
      // Morning: ramp toward ~6 Mana, manaing the lowest-value spare card.
      if (optional && (player.mana.length >= 6 || hand.length <= 1)) return [];
      const spare = [...hand].sort((a, b) => value(a) - value(b))[0];
      return spare ? [spare] : [];
    },

    // Place a character to best help a lane: bigger deficit vs the facing
    // Expedition wins, but we break ties toward the thinner lane so the bot
    // actually contests BOTH races instead of stacking one.
    async chooseExpedition({ card, player }) {
      const E = GameEngine;
      const them = E.opponentOf(player);
      const heroScore = (sum(E.expeditionTotals(them, 'hero')) - sum(E.expeditionTotals(player, 'hero'))) * 4 - player.heroExp.length;
      const compScore = (sum(E.expeditionTotals(them, 'companion')) - sum(E.expeditionTotals(player, 'companion'))) * 4 - player.compExp.length;
      return heroScore >= compScore ? 'hero' : 'companion';
    },

    // Discard / sacrifice the least valuable cards.
    async chooseDiscards({ cards, count }) {
      return [...cards].sort((a, b) => value(a) - value(b)).slice(0, count);
    },

    // Optional "You may …" — the AXIOM optionals (Hero exhaust, Hub spend) all
    // build robots, which is good value, so the simple bot says yes.
    async confirm() { return true; },

    // Modal choose-one — prefer bouncing a blocker over destroying a Permanent.
    async chooseOption({ options }) {
      return (options.find(o => o.key === 'bounce') || options[0]).key;
    },

    // Pick a target. For a buff, grow our own biggest body; otherwise hit the
    // opponent's biggest thing among the candidates.
    async chooseTarget({ candidates, player, intent }) {
      if (!candidates || !candidates.length) return null;
      let pool = candidates;
      if (intent !== 'buff') { const enemy = candidates.filter(c => c.owner !== player); if (enemy.length) pool = enemy; }
      return [...pool].sort((a, b) => (power(b.card) - power(a.card)) || ((b.card.handCost || 0) - (a.card.handCost || 0)) || (value(b.card) - value(a.card)))[0];
    },

    // Pick from a known list. For a cost-reduction discard (Paint Prison), shed
    // only as many cheap cards as needed to afford it; otherwise the least valuable.
    async chooseCards({ cards, max, purpose, need }) {
      if (purpose === 'costReduction') {
        const n = Math.min(need || 0, max || 0, cards.length);
        return [...cards].sort((a, b) => value(a) - value(b)).slice(0, n);
      }
      return [...cards].sort((a, b) => value(a) - value(b)).slice(0, max || 1);
    },

    // The Ouroboros lets us roll an extra die and keep the best — keep the highest.
    async chooseDie({ rolls, keep }) {
      return [...rolls].sort((a, b) => b - a).slice(0, keep || 1);
    },
  };

  function sum(tot) { return tot.forest + tot.mountain + tot.water; }

  return { takeAfternoonTurn, agent };
})();
