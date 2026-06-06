# Altered TCG — Project Reference

A browser implementation of the **Altered** trading card game (Equinox). Human
player vs. a simple bot. Ships with the six **CORE** ("Beyond the Gates") faction
starter decks (1 Hero + 39 commons each), built from the real card data and art.
Pure HTML + CSS + vanilla JS — no build step, no dependencies.

## Running

```bash
cd webgame
python3 -m http.server 8914
# open http://localhost:8914/
```

A local server is required (the game loads JSON/images via `fetch()`).
`index.html` redirects to `deck_select.html` when no decks are chosen.

Handy URL params on `index.html` (used for testing): `?you=AX&bot=BR` deep-links a
matchup (factions `AX BR LY MU OR YZ`); add `&auto=1` to let the bot drive both
sides (a headless self-test of the whole render path).

## The decks

The six **official CORE starter decks** (1 Hero + 31 commons + 8 rares each),
authored in `tools/generate_data.py` as `OFFICIAL_DECKS` — the real box lists,
including the cross-faction rares (e.g. the Axiom deck's The Frog Prince is an
Ordis card, The Ouroboros a Lyra Bastion). The generator resolves each
`(qty, name, Common/Rare)` entry against the local CORE mirror (commons → `_C`,
rares → the rarity-shifted `_R1` printing, tolerating the API's `#N#` stat
notation) and copies the art. Regenerate with `python3 tools/generate_data.py`.

## Rules implemented (per `rules/rules.md`)

- **Goal / win:** each player leads a **Hero** and a **Companion** Expedition that
  travel toward each other along the shared 8-region **Tumult track** (Hero Region,
  six Tumult halves, Companion Region). You win the instant your two markers
  **meet** (combined distance ≥ 7). Both meeting the same Dusk → the further
  traveller wins (the Arena tiebreaker is not implemented; a tie falls to the
  First Player).
- **Setup:** draw 6, place 3 face-down as **Mana Orbs**, keep 3 as your hand.
- **Day cycle:** Morning (swap First Player, ready everything, draw 2, optionally
  add one Mana Orb) → Noon (`At Noon` abilities) → **Afternoon** (alternate, one
  card per turn, until both pass) → **Dusk** → Night.
- **Mana:** each ready Orb pays 1; playing a card exhausts its Hand Cost (Reserve
  Cost when played from Reserve).
- **Dusk:** for the region your marker is in, sum each terrain across your
  Expedition and compare to the facing enemy Expedition; beat it in **at least one**
  of that region's terrains (and >0) to advance one step. Each Expedition advances
  at most once. Newly entered Tumult regions flip face-up.
- **Night — Rest:** every Expedition character returns to your **Reserve**
  (**Fleeting** → Discard instead; **tokens** are removed; **Anchored** stays, then
  loses Anchored). **Cleanup:** discard down to the Reserve limit and sacrifice down
  to the Landmark limit (Hero-defined, default 2/2).
- **Reserve:** a face-up second hand; cards played from it cost their Reserve Cost
  and gain Fleeting (Permanents go to the Landmark zone and don't).
- **Statuses:** Fleeting, **Boost** counters (+1/+1/+1), **Anchored**, and **Asleep**
  are fully modelled (Anchored keeps a character out of one Night rest, then is lost;
  Asleep's stats are ignored at Dusk, then like Anchored it survives Rest and is lost).

### Abilities

Two layers resolve card text:

1. **Auto-detected safe subset** (`tools/generate_data.py` → `card.ability`, run
   from the registry in `cards.js`): **Resupply**, **gain N boosts**,
   **create a token**, **draw N** — fired on the right trigger (`{J}` join /
   `{H}` from hand / `{R}` from Reserve / `At Noon`).
2. **Hand-authored card scripts** (`js/scripts.js`, keyed by card reference id)
   for everything the regex can't express. A script wins over the legacy
   `card.ability` for any trigger it defines. Capabilities the engine now
   supports (all driven through the `agent` abstraction so human **and** bot use
   the same code):
   - **Event bus** — `GameEngine.dispatch(type, payload)` notifies every in-play
     card's reactive `on:{ … }` handler (`playPermanent`, `characterJoins`).
   - **Targeting** — `api.targets(spec)` gathers candidates (respecting the
     "controlled"/Reserve rules); `agent.chooseTarget` picks (human: the
     `#target-banner` board highlight; bot: a heuristic).
   - **Choices** — `agent.chooseOption` (modal "choose one"), `agent.confirm`
     (optional "you may"), `agent.chooseCards` (pick from a list, e.g. own hand).
   - **Interactive quick actions** — exhaust/support abilities taken before the
     play-or-pass step (`availableQuickActions` / `playerQuickAction`; a
     `quickActions(ctx)` script hook). The Hero can exhaust (`p.heroExhausted`).
   - **Counters** — on char/landmark state (`self.counters`).
   - **Keywords** (`card.keywords` from the generator): **Gigantic** (counts in
     both Expeditions — `expeditionTotals` adds the other lane; UI shows a faded
     ghost) and **Tough N** (`toughOf(card,owner)` = intrinsic + Landmark auras like
     The Spindle; opponents pay to target — `api.targets` annotates `toughCost`,
     `api.resolveTarget` charges it).
   - **Dice** — `api.rollDie(p)` / `api.rollDice(p,n)` roll d6s through the
     `agent.chooseDie` abstraction (human: animated `#dice-overlay` popup; bot:
     keep-best). **The Ouroboros, Lyra Bastion** (script `diceMod:'ouroboros'`,
     detected by `hasDiceMod`) rolls one extra die and ignores the one of your choice.
   - **Reserve-cost reduction** — a script's declarative `costReduction:{ perReserveDiscard,
     max }` (Paint Prison) is folded into `GameEngine.minPlayCost`/`canAfford` (so the
     card lights up when the discount makes it affordable) and applied interactively in
     `playCard` via `agent.chooseCards({ purpose:'costReduction', need })`.
   - **Hero `At Noon`** and **`At Dusk`** abilities (noon/dusk loops process
     `heroState(p)`, Landmarks, and Expedition characters); reactive **`playSpell`**
     fires on the event bus when a Spell is played.
   - **`onLeave`** — a script's "when I leave the Expedition zone" trigger
     (Jeanne d'Arc → muster tokens). `GameEngine.fireLeaveExpedition(cs, owner)`
     runs it from every departure path: Night Rest (after both lanes rest, so newly
     mustered tokens persist), `bounceToReserve`, `returnToHand`, `returnToTopOfDeck`,
     `discardCharacter`.
   - **`defender(ctx) => bool`** — a script's (possibly conditional) Defender state.
     `evalMove` consults it: a Defender pins its Expedition (can't advance at Dusk).
     Monolith Archivist is a Defender unless you control 2+ other Bureaucrats.
   - **Hero "After You"** (Akesha & Taru) — a turn-flow tempo tool. The Hero script
     just carries `{ afterYou: true }`; the engine's `canAfterYou(p)` /
     `playerAfterYou()` let the First Player exhaust the Hero to yield the turn to the
     opponent **without passing** (once per Day). UI: a dedicated `#btn-afteryou`.
   - Effect helpers on `api`: `createToken` (announces `characterJoins`),
     `bounceToReserve`, `destroyPermanent`, `discardCharacter` (hard-removal to
     Discard), `discardFromReserve`, `moveHandToReserve`, `returnToHand`,
     `returnToTopOfDeck` (the async ones fire `onLeave`), `moveExpeditionBackwards`
     (Sakarabru), `resolveTarget` (Tough-aware target + pay). `api.targets` filters by
     `maxHandCost`/`minHandCost` (Sticky Note Seals targets Hand Cost ≥4).

All six starter decks are fully implemented via scripts: **AXIOM (Sierra & Oddball)**,
**BRAVOS (Kojo & Booda)**, **LYRA (Nevenka & Blotch)**, **MUNA (Teija & Nauraa)**,
**ORDIS (Sigismar & Wingspan)**, and **YZMIR (Akesha & Taru)**. AXIOM:
Sierra's reactive token, Brassbug Hive/Hub + counters, Three Little Pigs, Sabotage,
Kelon Elemental, Kelon Burst, Kelonic Generator. BRAVOS: Kojo's Hero At-Noon Booda,
Gigantic (Atlas), Tough (Shenlong + The Spindle's aura), Intimidation's
return-to-hand, Physical Training, Dorothy's bounce, the `{R}` boosters, and Fleeting
toggles (Tracer/Sun Wukong). LYRA (the dice deck): Nevenka's Hero die quick-action
(Anchored / boost / Reserve), Trickster/Asmodeus/Croupier/All In! rolls, Tanuki's
`{R}` roll-to-Sabotage, Cloth Dancer's Fleeting-grant, Paint Prison (Reserve-discount
+ return-to-top-of-deck), Off You Go!, Kadigiran Mage-Dancer (spell boosts + At-Dusk
draw), and **The Ouroboros**. MUNA (Plants / persistence / boosts): Teija's
first-Character boost (the `firstCharBoost` Hero passive), self-Anchoring bodies
(Spindle Harvesters, Sneezer Shroom, Coniferal Coneman), Yong-Su's Plant-count
boost, Kitsune's shared draw, Daughter of Yggdrasil's give-opponent-a-card, Parvati
& Meditation Training's Anchored grants, Nurture's up-to-two boosts, **Beauty
Sleep**'s Asleep, and the rare **Lyra Cloth Dancer**'s mass-Fleeting.
ORDIS (Sigismar & Wingspan — the Soldier/token deck): the Hero's At-Noon Recruit
(skipped on Day 1), every Recruit-maker (Cadets/Gatekeeper/Carrier/Spy + **Open the
Gates**' four-token distribution), the **Ordis Recruit 1/1/1** token, **The Monolith**
(boosts every joining Character), **Kakoba** (3+ other Characters → boosts),
**Charge!**'s mass boost, **Jeanne d'Arc**'s `onLeave` muster, Rune-Scribe's
token-gated Resupply, Ordis Spy's Sabotage, and **Sticky Note Seals** (choose-one
removal of a Hand Cost ≥4 Character/Permanent). The lone exception is the
cross-faction **Foundry Mechanic**, whose support ability (`{D}`: next Permanent
costs 1 less) needs the unbuilt Reserve-support-quick-action + transient-cost
subsystem, so it stays a vanilla 1/1/2 body.
YZMIR (Akesha & Taru — the control / disruption deck): the Hero's **After You**
tempo, **Defender** (Monolith Archivist pins its lane), **Sakarabru**'s
backwards-movement, **Banishing Gate**'s hard discard, **Kraken's Wrath**'s
budget-limited multi-bounce (≤3 chars, total Hand Cost ≤5), Baba Yaga / Kadigiran
Alchemist, Tooth Fairy & Spy Craft (Sabotage, +Resupply), the Dorothy / Off You Go!
commons, and the rare **Beauty Sleep** (Asleep + optional 2 boosts on your own
Character). Every starter card now resolves through a script or the safe auto-subset;
only some unused **keywords** (e.g. Seasoned) remain informational.

## Architecture

```
webgame/
├── index.html            # Game board + modals
├── deck_select.html      # Faction selection
├── css/  base|board|cards|overlays|deck_select.css
├── data/                 # generated: cards.json, decks.json, deck_<FAC>.json
├── assets/cards/         # generated: <reference>.jpg art
├── assets/adventure/     # real Hero / Tumult / Companion cards (the track)
├── assets/markers/       # real punch-board chips: exp_<FAC>_{hero,comp}, first_player
├── js/
│   ├── version.js        # constants + localStorage reset
│   ├── cards.js          # CardManager: loading, stats(+boosts), cost, ability registry
│   ├── scripts.js        # CardScripts: hand-authored abilities for complex cards (by id)
│   ├── game.js           # GameEngine: Day phases, Dusk race, Night, win, event bus, quick actions
│   ├── bot.js            # BotAI: heuristic opponent + its prompt agent
│   ├── ui.js             # UI: rendering, input, modals, the human agent
│   └── deck_select.js    # selection controller
└── tools/
    ├── generate_data.py     # rebuilds data/ + assets/cards/ from ../cards
    ├── extract_adventure.py # pulls Hero/Tumult/Companion art from the P&P PDF
    ├── extract_markers.py   # pulls Expedition / First Player chips from the PunchBoard PDF
    └── sim.js               # headless bot-vs-bot smoke test
```

### Key patterns (mirrors the Lorcana reference project)

- **Agent abstraction.** Decisions go through an injected `agent`
  (`chooseManaCards` / `chooseExpedition` / `chooseDiscards` / `chooseTarget` /
  `chooseOption` / `confirm` / `chooseCards`); the human's agent (in `ui.js`)
  shows modals / the board target-banner, the bot's (in `bot.js`) answers with
  heuristics. The same engine code runs for both. Each player carries its own `.agent`.
- **Single render path.** `GameEngine.notify()` → `UI.render()` rebuilds every
  zone from live state.
- **Deck orientation.** A `deck` array's **last** element is the top (`pop()` draws).
- **Afternoon flow.** Non-interactive phases run as one async chain; the Afternoon
  pauses on a promise resolved by the human's `playerPlay` / `playerPass` /
  `playerAfterYou` (or the bot's single-action turn). Quick actions
  (`playerQuickAction`) resolve in place **without** ending the turn; **After You**
  ends the turn but, unlike Pass, doesn't set `passed` (the loop just hands over).

## Testing

```bash
node tools/sim.js 40        # 40 full bot-vs-bot games — expect 0 errors
node tools/sim.js 1 -v      # one game with the full phase log
# Real-browser self-test (needs the server running):
#   open index.html?you=AX&bot=BR&auto=1  — plays itself to the game-over screen
#   open index.html?you=LY&bot=LY&auto=1  — exercises the dice popup / The Ouroboros
#   open index.html?you=MU&bot=MU&auto=1  — exercises Asleep, self-Anchor, mass-Fleeting
#   open index.html?you=OR&bot=OR&auto=1  — exercises Recruit tokens, Jeanne's onLeave, The Monolith
#   open index.html?you=YZ&bot=AX        — pilot Yzmir to use the Hero's "After You" button
#     (the bot never uses After You / Defender, so play YZ by hand to exercise them)
```

## Limitations / TODO

- **All six starter decks are fully scripted.** New cards/sets can be added by
  scripting them in `js/scripts.js` (or relying on the auto-detected safe subset).
- Keyword `Seasoned` is not modelled yet. Gigantic, Tough N, **Defender**, the
  **dice** subsystem (with The Ouroboros), Asleep, and the **`onLeave`** trigger are
  implemented.
- Support abilities (discard-from-Reserve quick actions) are plumbed but not yet
  surfaced as quick actions; ORDIS's cross-faction **Foundry Mechanic** (`{D}`: next
  Permanent costs 1 less) is the first real consumer and remains unimplemented (a
  vanilla 1/1/2 body) pending that subsystem + a transient per-turn cost modifier.
- Token-makers target only the controller's own Expeditions (no enemy seeding).
- Arena tiebreaker not implemented.
- Bot is still simple: develops its strongest character, builds Landmarks, makes
  robots/Recruits, sabotages, bounces blockers (incl. Kraken's Wrath / Banishing
  Gate), uses the Hero (incl. LYRA's die quick-action), resolves its own dice, plays
  Off You Go!/Paint Prison/Sticky Note Seals as removal, MUNA's Nurture/Meditation
  Training + ORDIS's Charge! (buff), Beauty Sleep (disruption), Open the Gates
  (swarm), and Spy Craft (utility); it never plays from Reserve, barely uses other
  quick actions, **never uses YZMIR's "After You"** (a human-only tempo tool), and
  avoids the self-locking Defender (Monolith Archivist) — so YZMIR plays best
  human-piloted.
