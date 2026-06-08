// deck_select.js — pick your faction, then your opponent's.
(async () => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => (s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const decks = await CardManager.loadManifest();
  const db = await CardManager.loadCards();

  let human = null, bot = null;

  function heroArt(d) { const c = db[d.cover]; return c ? c.image : ''; }

  function render() {
    $('deck-grid').innerHTML = decks.map(d => {
      const isYou = human === d.id, isOpp = bot === d.id;
      const sel = isYou && isOpp ? 'sel-you sel-opp sel-both'
        : isYou ? 'sel-you' : isOpp ? 'sel-opp' : '';
      const badge = isYou && isOpp ? '<span class="pick-badge">You + Opp</span>'
        : isYou ? '<span class="pick-badge">You</span>'
        : isOpp ? '<span class="pick-badge">Opponent</span>' : '';
      return `<div class="deck-tile ${sel}" data-id="${d.id}" style="--fac:var(--${d.faction})">
        ${badge}
        <img src="${heroArt(d)}" alt="${esc(d.factionName)}">
        <div class="info">
          <div class="fac"><span class="fac-chip" style="background:var(--${d.faction})"></span>${esc(d.factionName)}</div>
          <div class="hero">${esc(db[d.hero] ? db[d.hero].name : '')}</div>
        </div>
      </div>`;
    }).join('');
    $('deck-grid').querySelectorAll('.deck-tile').forEach(n => n.onclick = () => choose(n.dataset.id));

    $('step-label').innerHTML = !human ? 'Choose <b>your</b> faction'
      : !bot ? 'Choose your <b>opponent\'s</b> faction' : 'Ready to play';
    const hName = human ? decks.find(d => d.id === human).factionName : '—';
    const bName = bot ? decks.find(d => d.id === bot).factionName : '—';
    $('chosen').innerHTML = `You: <b>${hName}</b> &nbsp;vs&nbsp; Opponent: <b>${bName}</b>`;
    $('btn-start').disabled = !(human && bot);
  }

  function choose(id) {
    if (!human) human = id;
    else if (!bot) bot = id;
    else { human = id; bot = null; }     // start over from "your" pick
    render();
  }

  $('btn-reset').onclick = () => { human = bot = null; render(); };
  $('btn-start').onclick = () => {
    if (!human || !bot) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ human, bot }));
    location.href = 'index.html';
  };
  render();
})();
