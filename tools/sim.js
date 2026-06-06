// sim.js — headless engine smoke test (bot vs bot). Run: node tools/sim.js [N]
//
// Loads the browser engine modules into one VM context with fs-backed fetch and
// stubbed Image/timers, then plays N full games across random deck pairings.
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..');

global.fetch = async (url) => {
  const txt = fs.readFileSync(path.join(ROOT, url), 'utf8');
  return { ok: true, status: 200, json: async () => JSON.parse(txt), text: async () => txt };
};
global.Image = class { set src(v) { if (this.onload) this.onload(); } };
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
// Make engine delays effectively instant but still async (no deep recursion).
global.setTimeout = (fn) => { Promise.resolve().then(fn); return 0; };

const src = ['js/version.js', 'js/cards.js', 'js/scripts.js', 'js/game.js', 'js/bot.js']
  .map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
vm.runInThisContext(src, { filename: 'engine-bundle.js' });

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/decks.json'), 'utf8')).decks;

async function playOne(verbose) {
  const a = manifest[Math.floor(Math.random() * manifest.length)];
  let b = manifest[Math.floor(Math.random() * manifest.length)];
  const state = await GameEngine.setupGame({
    changeCallback: () => {}, eventHook: null,
    humanDeckFile: a.file, botDeckFile: b.file,
    humanAgent: BotAI.agent, botAgent: BotAI.agent,
  });
  state.you.isHuman = false;             // drive both sides with the bot
  state.you.name = a.factionName;
  await GameEngine.startGame();
  if (verbose) for (const e of state.log) console.log(`  [${e.type}] ${e.message}`);
  return {
    a: a.factionName, b: b.factionName,
    winner: state.winner ? (state.winner === state.you ? a.factionName : b.factionName) : 'NONE',
    youWon: state.winner === state.you, days: state.day,
    yDist: state.you.heroDist + state.you.compDist, oDist: state.opp.heroDist + state.opp.compDist,
  };
}

(async () => {
  const N = parseInt(process.argv[2] || '40', 10);
  const verbose = process.argv.includes('-v');
  let errors = 0, totalDays = 0, none = 0;
  const wins = {};
  for (let i = 0; i < N; i++) {
    try {
      const r = await playOne(verbose && i === 0);
      totalDays += r.days;
      if (r.winner === 'NONE') none++;
      wins[r.winner] = (wins[r.winner] || 0) + 1;
      if (i < 8 || verbose) console.log(`Game ${i + 1}: ${r.a} vs ${r.b} → ${r.winner} (Day ${r.days}, dist ${r.yDist}/${r.oDist})`);
    } catch (e) {
      errors++; console.error(`Game ${i + 1} ERROR:`, e.stack || e);
      if (errors > 3) break;
    }
  }
  console.log(`\n${N} games — errors: ${errors}, no-winner: ${none}, avg days: ${(totalDays / N).toFixed(1)}`);
  console.log('Wins by faction:', wins);
  process.exit(errors ? 1 : 0);
})();
