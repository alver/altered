#!/usr/bin/env python3
"""generate_data.py — build the Altered web-game's data/ and assets/ from the
local CORE card mirror in ../../cards.

For each of the six factions it assembles a ready-to-play starter deck
(1 Hero + 39 common cards of that faction), emits the engine card database,
a deck manifest, per-deck card lists, and copies each card's art.

It also auto-detects a small, SAFE subset of card abilities from the effect
text (Resupply, gain boosts, create a token, draw). Every other card is a
faithful stats card whose printed text is shown but not auto-resolved.

Run:  python3 tools/generate_data.py
"""
import json, os, re, glob, shutil, collections, unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)                                   # webgame/
CARDS = os.path.normpath(os.path.join(ROOT, '..', 'cards'))    # ../cards
DETAILS = os.path.join(CARDS, 'data', 'details', 'en-us')
IMAGES = os.path.join(CARDS, 'images', 'CORE')

DATA_OUT = os.path.join(ROOT, 'data')
ART_OUT = os.path.join(ROOT, 'assets', 'cards')

FACTIONS = {'AX': 'Axiom', 'BR': 'Bravos', 'LY': 'Lyra',
            'MU': 'Muna', 'OR': 'Ordis', 'YZ': 'Yzmir'}

TYPE_MAP = {
    'CHARACTER': 'character', 'SPELL': 'spell', 'HERO': 'hero',
    'PERMANENT': 'permanent', 'LANDMARK_PERMANENT': 'landmark', 'TOKEN': 'token',
}


# ─────────────────────────── effect parsing ────────────────────────────────
def strip_reminders(s):
    """Remove parenthetical reminder text, collapse whitespace."""
    s = re.sub(r'\([^()]*\)', '', s)
    return re.sub(r'\s+', ' ', s).strip(' .')


def detect_ability(raw):
    """Return {trigger: {code, ...}} for a few safe, fully-implemented patterns,
    plus a `fleeting` flag for auto-Fleeting spells. Anything we don't fully
    understand returns no ability so the card is played as a vanilla stats card.

    Complex cards (multi-clause, conditional, targeted, counters, quick actions)
    are NOT handled here — they are hand-authored in `js/scripts.js`, keyed by
    reference id, and the engine prefers a script over this auto-detected ability.
    So leaving a card with an empty ability here is fine if a script covers it.
    """
    fleeting = bool(re.search(r'\[\[Fleeting\]\]', raw))
    body = raw.replace('#', '')                 # drop rarity-shift markers (#N#)
    # Drop a leading "[[Fleeting]]. (reminder)" clause for auto-fleeting spells.
    body = re.sub(r'^\s*\[\[Fleeting\]\]\s*\.?', '', body)

    # Identify the trigger prefix.
    trigger = None
    m = re.match(r'\s*\{([JHR])\}', body)
    if m:
        trigger = {'J': 'join', 'H': 'hand', 'R': 'reserve'}[m.group(1)]
        body = body[m.end():]
    elif re.match(r'\s*At\s+Noon', body):
        trigger = 'atNoon'
        body = re.sub(r'^\s*At\s+Noon\s*[—\-]*', '', body)

    core = strip_reminders(body)

    ability = {}
    if trigger:
        # — Resupply —
        if re.fullmatch(r'\[Resupply\]', core, re.I):
            ability[trigger] = {'code': 'resupply'}
        # — Draw N —
        elif re.fullmatch(r'Draw a card', core, re.I):
            ability[trigger] = {'code': 'draw', 'n': 1}
        else:
            md = re.fullmatch(r'Draw (\d+) cards?', core, re.I)
            mb = re.fullmatch(r'I gain (\d+) boosts?(?:\[\])?', core, re.I)
            mt = re.fullmatch(
                r"Create a \[([A-Za-z'’ ]+?) (\d+)/(\d+)/(\d+)\] (\w+) token in (?:target|my|your) (?:companion |hero )?Expedition\.?",
                core, re.I)
            if md:
                ability[trigger] = {'code': 'draw', 'n': int(md.group(1))}
            elif mb:
                ability[trigger] = {'code': 'gain_boost', 'n': int(mb.group(1))}
            elif mt:
                ability[trigger] = {'code': 'create_token', 'token': {
                    'name': mt.group(1).strip(), 'forest': int(mt.group(2)),
                    'mountain': int(mt.group(3)), 'water': int(mt.group(4)),
                    'subtype': mt.group(5)}}
    return ability, fleeting


SYM = {
    '{J}': '⟐', '{H}': '✋', '{R}': '♺', '{T}': '↻', '{X}': 'X',
    '{V}': '🌲', '{M}': '⛰', '{O}': '💧', '{j}': '⟐', '{h}': '✋', '{r}': '♺',
}


def render_text(raw):
    """Human-readable effect text for display (symbols → glyphs)."""
    s = raw
    for k, v in SYM.items():
        s = s.replace(k, v)
    s = re.sub(r'\{(\d+)\}', lambda m: f'❲{m.group(1)}❳', s)   # mana costs
    s = re.sub(r'\[\[([^\]]+)\]\]', r'\1', s)                  # [[Keyword]]
    s = re.sub(r'\[([^\]]+)\]', r'\1', s)                      # [Action]/[Token]
    s = s.replace('boost[]', 'boost').replace('[]', '').replace('#', '')   # # marks rarity-shifted values
    return re.sub(r'\s+', ' ', s).strip()


# ─────────────────────────── load card pool ────────────────────────────────
RARMAP = {'COMMON': 'common', 'RARE': 'rare', 'UNIQUE': 'unique'}


def to_int(v):
    """Parse a stat/cost, tolerating the API's `#N#` rarity-shift notation."""
    if v in (None, ''):
        return 0
    m = re.sub(r'[^0-9-]', '', str(v))
    return int(m) if m not in ('', '-') else 0


def load_cards():
    """Load every CORE card (all rarities) so official decks — including rares
    and cross-faction inclusions — can be resolved by name."""
    have_img = set(os.listdir(IMAGES)) if os.path.isdir(IMAGES) else set()
    cards = {}
    for f in glob.glob(os.path.join(DETAILS, 'ALT_CORE_*.json')):
        d = json.load(open(f))
        ref = d['reference']
        if not ref.startswith('ALT_CORE_'):       # exclude COREKS dupes
            continue
        ctype = (d.get('cardType', {}) or {}).get('reference')
        if ctype not in TYPE_MAP or ctype in ('TOKEN', 'TOKEN_MANA'):
            continue
        if ref + '_en-us.jpg' not in have_img:
            continue
        fac = (d.get('mainFaction', {}) or {}).get('reference')
        if fac not in FACTIONS:
            continue
        el = d.get('elements', {}) or {}
        raw = (el.get('MAIN_EFFECT') or '').strip()
        echo = (el.get('ECHO_EFFECT') or '').strip()      # Support ability ({D}: discard from Reserve)
        ability, fleeting = detect_ability(raw)
        card = {
            'id': ref, 'name': d.get('name'), 'type': TYPE_MAP[ctype],
            'faction': fac, 'factionName': FACTIONS[fac],
            'rarity': RARMAP.get((d.get('rarity', {}) or {}).get('reference'), 'common'),
            'subtypes': [s.get('name') for s in (d.get('cardSubTypes') or [])],
            'handCost': to_int(el.get('MAIN_COST')), 'reserveCost': to_int(el.get('RECALL_COST')),
            'text': render_text(raw), 'rawEffect': raw,
            'ability': ability, 'fleeting': fleeting,
            'image': f'assets/cards/{ref}.jpg',
        }
        # Static keywords the engine understands. Gigantic = present in both
        # Expeditions. Tough N = opponents pay N to target it — only an INTRINSIC
        # keyword here (Characters); aura-granted Tough (e.g. The Spindle) is a
        # card script, so we skip non-Character "[Tough N]" (it's an aura clause).
        kw = {}
        if re.search(r'\[Gigantic\]', raw):
            kw['gigantic'] = True
        mtough = re.search(r'\[Tough\s+(\d+)\]', raw)
        if mtough and ctype == 'CHARACTER':
            kw['tough'] = int(mtough.group(1))
        if kw:
            card['keywords'] = kw
        # Support ability text (printed at the bottom of the card). Resolved by a
        # js/scripts.js `support` handler keyed by reference id; kept here for
        # faithful data / future display. Only set when the card actually has one.
        if echo:
            card['supportText'] = render_text(echo)
        if ctype == 'CHARACTER':
            card['forest'] = to_int(el.get('FOREST_POWER'))
            card['mountain'] = to_int(el.get('MOUNTAIN_POWER'))
            card['water'] = to_int(el.get('OCEAN_POWER'))
        if ctype == 'HERO':
            card['reserveLimit'] = to_int(el.get('RESERVE')) or 2
            card['landmarkLimit'] = to_int(el.get('PERMANENT')) or 2
            # Hero passive: "The first Character you play each Afternoon gains N boost"
            # (e.g. Teija & Nauraa). Applied by the engine when a character is played.
            m = re.search(r'first Character you play each Afternoon gains (\d+) boost', raw, re.I)
            if m:
                card['ability'] = {'firstCharBoost': int(m.group(1))}
        cards[ref] = card
    return cards


# ───────────────────── official CORE starter decklists ─────────────────────
# Each is the real box list: 1 Hero + 31 commons + 8 rares (39 deck cards).
# Entries are (quantity, card name, 'C'=Common / 'R'=Rare). A handful of rares
# are cross-faction inclusions (resolved by name to whichever faction owns them).
OFFICIAL_DECKS = {
    'AX': ('Sierra & Oddball', [
        (2, "Axiom Scrambler", "C"), (1, "Axiom Scrambler", "R"), (2, "Foundry Mechanic", "C"),
        (1, "Foundry Mechanic", "R"), (3, "Axiom Salvager", "C"), (3, "Kelon Elemental", "C"),
        (2, "Jian, Assembly Overseer", "C"), (1, "Jian, Assembly Overseer", "R"), (1, "The Frog Prince", "R"),
        (3, "Amelia Earhart", "C"), (2, "Three Little Pigs", "C"), (1, "Three Little Pigs", "R"),
        (3, "Foundry Armorer", "C"), (3, "Kelon Burst", "C"), (1, "The Ouroboros, Lyra Bastion", "R"),
        (1, "Kelonic Generator", "R"), (1, "Brassbug Hive", "R"), (2, "Brassbug Hive", "C"),
        (3, "Brassbug Hub", "C"), (3, "Axiom Reprocessor", "C")]),
    'BR': ('Kojo & Booda', [
        (2, "Ratatoskr", "C"), (1, "Ratatoskr", "R"), (3, "Issun-boshi", "C"), (2, "Bravos Tracer", "C"),
        (1, "Bravos Tracer", "R"), (3, "Bravos Pathfinder", "C"), (3, "Haven Trainee", "C"),
        (3, "Haven Bouncer", "C"), (2, "Haven Warrior", "C"), (1, "Haven Warrior", "R"),
        (2, "Sun Wukong", "C"), (1, "Sun Wukong", "R"), (3, "Kappa", "C"), (3, "Atlas", "C"),
        (1, "Dorothy Gale", "R"), (1, "Shenlong", "R"), (3, "Intimidation", "C"),
        (2, "Physical Training", "C"), (1, "Physical Training", "R"), (1, "The Spindle, Muna Bastion", "R")]),
    'LY': ('Nevenka & Blotch', [
        (2, "Ouroboros Trickster", "C"), (1, "Ouroboros Trickster", "R"), (2, "Esmeralda", "C"),
        (1, "Esmeralda", "R"), (3, "Lyra Skald", "C"), (3, "Hathor", "C"), (3, "Lyra Cloth Dancer", "C"),
        (3, "Lyra Chronicler", "C"), (2, "Tanuki", "C"), (1, "Tanuki", "R"), (3, "Ouroboros Croupier", "C"),
        (3, "The Hatter", "C"), (2, "Asmodeus", "C"), (1, "Asmodeus", "R"), (1, "Kadigiran Mage-Dancer", "R"),
        (3, "All In!", "C"), (2, "Paint Prison", "C"), (1, "Paint Prison", "R"), (1, "Off You Go!", "R"),
        (1, "The Ouroboros, Lyra Bastion", "R")]),
    'MU': ('Teija & Nauraa', [
        (1, "Yong-Su, Verdant Weaver", "R"), (1, "Coniferal Coneman", "R"), (3, "Spindle Harvesters", "C"),
        (3, "Kitsune", "C"), (2, "Sneezer Shroom", "C"), (1, "Sneezer Shroom", "R"), (1, "Lyra Cloth Dancer", "R"),
        (2, "Yong-Su, Verdant Weaver", "C"), (3, "Inari", "C"), (3, "Daughter of Yggdrasil", "C"),
        (3, "Muna Druid", "C"), (3, "Cernunnos", "C"), (1, "Parvati", "R"), (2, "Coniferal Coneman", "C"),
        (1, "Nurture", "R"), (3, "Beauty Sleep", "C"), (1, "Physical Training", "R"),
        (2, "Meditation Training", "C"), (1, "Meditation Training", "R"), (2, "Nurture", "C")]),
    'OR': ('Sigismar & Wingspan', [
        (1, "Jeanne d'Arc", "R"), (1, "Foundry Mechanic", "R"), (1, "Ratatoskr", "R"), (2, "Ordis Trooper", "C"),
        (1, "Ordis Trooper", "R"), (3, "Ordis Cadets", "C"), (2, "Monolith Rune-Scribe", "C"),
        (1, "Monolith Rune-Scribe", "R"), (3, "The Frog Prince", "C"), (3, "Ordis Gatekeeper", "C"),
        (2, "Ordis Spy", "C"), (1, "Ordis Spy", "R"), (2, "Kakoba, Legion Commander", "C"),
        (1, "Kakoba, Legion Commander", "R"), (2, "Jeanne d'Arc", "C"), (3, "Ordis Carrier", "C"),
        (3, "The Monolith, Ordis Bastion", "C"), (3, "Charge!", "C"), (3, "Sticky Note Seals", "C"),
        (1, "Open the Gates", "R")]),
    'YZ': ('Akesha & Taru', [
        (3, "Studious Disciple", "C"), (3, "Yzmir Stargazer", "C"), (3, "Lady of the Lake", "C"),
        (2, "Baba Yaga", "C"), (1, "Baba Yaga", "R"), (2, "Alice", "C"), (1, "Alice", "R"),
        (1, "Tooth Fairy", "R"), (1, "Monolith Archivist", "R"), (2, "Kadigiran Alchemist", "C"),
        (1, "Kadigiran Alchemist", "R"), (2, "Dorothy Gale", "C"), (1, "Dorothy Gale", "R"),
        (2, "Sakarabru", "C"), (1, "Sakarabru", "R"), (1, "Beauty Sleep", "R"), (3, "Off You Go!", "C"),
        (3, "Spy Craft", "C"), (3, "Banishing Gate", "C"), (3, "Kraken's Wrath", "C")]),
}


def _norm(s):
    s = s.replace(' and ', ' & ')
    s = unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode()
    return re.sub(r'[^a-z0-9]', '', s.lower())


def build_indexes(cards):
    name_idx = collections.defaultdict(lambda: collections.defaultdict(list))
    hero_idx = {}
    for ref, c in cards.items():
        nm = _norm(c['name'])
        if c['type'] == 'hero':
            if nm not in hero_idx or '_B_' in ref:        # prefer the booster printing
                hero_idx[nm] = ref
        else:
            name_idx[nm][c['rarity']].append(ref)
    return name_idx, hero_idx


def resolve_card(name, rar, name_idx):
    e = name_idx.get(_norm(name))
    if not e:
        raise SystemExit(f'UNRESOLVED name: {name!r}')
    want = 'common' if rar == 'C' else 'rare'
    refs = e.get(want) or e.get('rare') or e.get('common') or e.get('unique')
    if not refs:
        raise SystemExit(f'UNRESOLVED {name!r} ({rar})')
    if rar == 'R':                                          # prefer the rarity-shifted (_R1) printing
        r1 = [r for r in refs if r.endswith('_R1')]
        return r1[0] if r1 else sorted(refs)[0]
    return sorted(refs)[0]


# ─────────────────────────────── main ──────────────────────────────────────
def main():
    os.makedirs(DATA_OUT, exist_ok=True)
    os.makedirs(ART_OUT, exist_ok=True)
    cards = load_cards()
    name_idx, hero_idx = build_indexes(cards)
    print(f'Loaded {len(cards)} CORE cards.')

    used = set()
    manifest = []
    for fac, fname in FACTIONS.items():
        hero_name, lst = OFFICIAL_DECKS[fac]
        href = hero_idx[_norm(hero_name)]
        counts = collections.OrderedDict()
        for q, name, rar in lst:
            ref = resolve_card(name, rar, name_idx)
            counts[ref] = counts.get(ref, 0) + q
        deck_cards = [{'id': r, 'count': n} for r, n in counts.items()]
        total = sum(c['count'] for c in deck_cards)
        deck = {
            'id': fac, 'name': f'{fname} — {hero_name}', 'faction': fac,
            'factionName': fname, 'hero': href, 'cover': href, 'cards': deck_cards,
        }
        json.dump(deck, open(os.path.join(DATA_OUT, f'deck_{fac}.json'), 'w'), indent=1)
        manifest.append({'id': fac, 'name': deck['name'], 'faction': fac,
                         'factionName': fname, 'hero': href, 'cover': href,
                         'file': f'data/deck_{fac}.json'})
        used.add(href)
        used.update(c['id'] for c in deck_cards)
        rares = sum(c['count'] for c in deck_cards if cards[c['id']]['rarity'] != 'common')
        print(f'  {fac}: {hero_name} + {total} cards ({len(deck_cards)} distinct, {rares} rare).')

    # Card DB: every card referenced by any deck (+ the heroes).
    db = {ref: cards[ref] for ref in used if ref in cards}
    json.dump(db, open(os.path.join(DATA_OUT, 'cards.json'), 'w'), indent=1)
    json.dump({'decks': manifest}, open(os.path.join(DATA_OUT, 'decks.json'), 'w'), indent=1)

    # Token characters aren't in any deck, so they're never in `used` — but the
    # engine creates them in play (Brassbug, Booda) and shows their art. Copy it
    # here too so regeneration reproduces it. Keep in sync with CardScripts.tokens().
    TOKEN_ART = {'ALT_CORE_B_AX_31_C', 'ALT_CORE_B_BR_31_C', 'ALT_CORE_B_OR_31_C'}
    copied = 0
    for ref in used | TOKEN_ART:
        src = os.path.join(IMAGES, ref + '_en-us.jpg')
        dst = os.path.join(ART_OUT, ref + '.jpg')
        if os.path.exists(src) and not os.path.exists(dst):
            shutil.copyfile(src, dst)
            copied += 1
    print(f'Card DB: {len(db)} cards. Copied {copied} new images.')
    impl = sum(1 for c in db.values() if c['ability'])
    print(f'Auto-implemented abilities on {impl} cards.')


if __name__ == '__main__':
    main()
