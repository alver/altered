// test_support.js — headless unit test for Support abilities ({D} quick actions).
// Drives each Support effect directly through the engine (the bot never fires them,
// so the bot-vs-bot sim only smoke-tests enumeration). Run: node tools/test_support.js
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..');

global.fetch = async (url) => ({
  ok: true, status: 200,
  json: async () => JSON.parse(fs.readFileSync(path.join(ROOT, url), 'utf8')),
  text: async () => fs.readFileSync(path.join(ROOT, url), 'utf8'),
});
global.Image = class { set src(v) { if (this.onload) this.onload(); } };
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
global.setTimeout = (fn) => { Promise.resolve().then(fn); return 0; };

const src = ['js/version.js', 'js/cards.js', 'js/scripts.js', 'js/game.js', 'js/bot.js']
  .map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
vm.runInThisContext(src, { filename: 'engine-bundle.js' });

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/decks.json'), 'utf8')).decks;
const byFac = (f) => manifest.find(d => d.id === f);
const CM = CardManager;
const inst = (id) => CM.instantiate(CM.getCard(id));
const mkChar = (id) => ({ card: inst(id), exhausted: false, boosts: 0, counters: {}, fleeting: false, anchored: false, asleep: false, expedition: 'hero', enteredDay: 1 });

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };

async function main() {
  const state = await GameEngine.setupGame({
    changeCallback: () => {}, eventHook: null,
    humanDeckFile: byFac('AX').file, botDeckFile: byFac('BR').file,
    humanAgent: BotAI.agent, botAgent: BotAI.agent,
  });
  const you = state.you;
  const reset = () => {
    for (const k of ['reserve', 'hand', 'discard', 'heroExp', 'compExp', 'pendingMods', 'mana']) you[k].length = 0;
    you.passed = false; you.playedCharThisAfternoon = true;           // skip firstCharBoost
    for (let i = 0; i < 12; i++) you.mana.push({ exhausted: false, card: null });
    state.phase = GameEngine.PHASES.AFTERNOON; state.current = you; state.firstPlayer = you;
    state.opp.passed = false;
  };
  const QA = () => GameEngine.availableQuickActions(you);
  const sup = (prefix) => QA().find(a => a.kind === 'support' && a.label.startsWith(prefix));

  // 1. Foundry Mechanic — next Permanent costs 1 less (cost mod + consumption).
  reset();
  const fm = inst('ALT_CORE_B_AX_07_C'); you.reserve.push(fm);
  const perm = inst('ALT_CORE_B_AX_24_C');                            // Brassbug Hub, cost 3
  const cBefore = GameEngine.minPlayCost(perm, you, false);
  let a = sup('Foundry Mechanic'); ok(a && a.canRun, 'Foundry: support available');
  await a.run();
  ok(!you.reserve.includes(fm) && you.discard.includes(fm), 'Foundry: discarded as cost');
  ok(GameEngine.minPlayCost(perm, you, false) === cBefore - 1, 'Foundry: minPlayCost dropped by 1');
  you.hand.push(perm);
  const manaBefore = CM.readyMana(you);
  await GameEngine.playCard(you, perm, false);
  ok(CM.readyMana(you) === manaBefore - (perm.handCost - 1), 'Foundry: paid base-1 mana');
  ok(!you.pendingMods.some(m => m.kind === 'cost'), 'Foundry: cost mod consumed');

  // 2. Issun-bōshi — next Character gains 1 boost (boost mod + consumption).
  reset();
  you.reserve.push(inst('ALT_CORE_B_BR_05_C'));
  a = sup('Issun-bōshi'); ok(a && a.canRun, 'Issun: support available');
  await a.run();
  ok(you.pendingMods.some(m => m.kind === 'boost'), 'Issun: boost mod set');
  const ch = inst('ALT_CORE_B_LY_07_C'); you.hand.push(ch);          // vanilla 2-cost body
  await GameEngine.playCard(you, ch, false);
  const placed = [...you.heroExp, ...you.compExp].find(cs => cs.card === ch);
  ok(placed && placed.boosts === 1, 'Issun: played Character gained 1 boost');
  ok(!you.pendingMods.some(m => m.kind === 'boost'), 'Issun: boost mod consumed');

  // 3. Studious Disciple — next Spell costs 1 less (and ONLY spells).
  reset();
  you.reserve.push(inst('ALT_CORE_B_YZ_04_C'));
  const spell = inst('ALT_CORE_A_BR_26_C');                          // Physical Training, cost 2
  const sBefore = GameEngine.minPlayCost(spell, you, false);
  await sup('Studious Disciple').run();
  ok(GameEngine.minPlayCost(spell, you, false) === sBefore - 1, 'Studious: spell cost dropped by 1');
  const permX = inst('ALT_CORE_B_AX_24_C');
  ok(GameEngine.minPlayCost(permX, you, false) === permX.handCost, 'Studious: does not reduce a Permanent');

  // 4. The Hatter — Anchor a target Character (cost ≤3).
  reset();
  const hatter = inst('ALT_CORE_B_LY_18_C'); you.reserve.push(hatter);
  ok(sup('The Hatter') && !sup('The Hatter').canRun, 'Hatter: canRun false with no target');
  const tgt = mkChar('ALT_CORE_B_LY_07_C'); you.heroExp.push(tgt);   // cost 2 body in play
  const h = sup('The Hatter'); ok(h && h.canRun, 'Hatter: canRun true with a ≤3 target');
  await h.run();
  ok(tgt.anchored === true, 'Hatter: target gained Anchored');
  ok(you.discard.includes(hatter), 'Hatter: discarded as cost');

  // 5. Hathor — return another Reserve card to hand.
  reset();
  const hathor = inst('ALT_CORE_B_LY_07_C'); you.reserve.push(hathor);
  ok(sup('Hathor') && !sup('Hathor').canRun, 'Hathor: canRun false with only itself');
  const other = inst('ALT_CORE_B_AX_24_C'); you.reserve.push(other);
  const hh = sup('Hathor'); ok(hh && hh.canRun, 'Hathor: canRun true with another card');
  await hh.run();
  ok(you.hand.includes(other) && !you.reserve.includes(other), 'Hathor: other card moved Reserve→hand');
  ok(you.discard.includes(hathor) && !you.reserve.includes(hathor), 'Hathor: discarded as cost');

  // 6. Sakarabru — draw a card.
  reset();
  you.deck.push(inst('ALT_CORE_B_AX_24_C'));
  you.reserve.push(inst('ALT_CORE_B_YZ_18_R1'));
  const handBefore = you.hand.length;
  const sa = sup('Sakarabru'); ok(sa && sa.canRun, 'Sakarabru: support available');
  await sa.run();
  ok(you.hand.length === handBefore + 1, 'Sakarabru: drew a card');

  // 7. Alice — After You: only as First Player, flagged endsTurn.
  reset();
  you.reserve.push(inst('ALT_CORE_B_YZ_13_C'));
  let al = sup('Alice'); ok(al && al.canRun && al.endsTurn, 'Alice: canRun + endsTurn as First Player');
  state.firstPlayer = state.opp;
  al = sup('Alice'); ok(al && !al.canRun, 'Alice: canRun false when not First Player');

  console.log(`\nSupport tests — pass: ${pass}, fail: ${fail}`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e.stack || e); process.exit(1); });
