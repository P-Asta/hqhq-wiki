# Seed Content Plan — EN pages, wikitext templates, parser fixtures, first KO translation

Status: draft for review · Date: 2026-08-30 · Owner: content research
Applies to: the MediaWiki-wikitext parser/renderer for hqhq-wiki (Lethal Company HIGH QUOTA wiki).

This document is three things at once:

1. The **seed page inventory** (~25 EN pages) mapped onto the existing store (`wiki-data/categories.json` ids).
2. The **seed template inventory** in actual, ready-to-store MediaWiki wikitext (`Template:` pages).
3. Three **complete example articles** + one **KO translation** that double as **parser integration-test fixtures**. Each fenced `wikitext` block below is preceded by a stable `<!-- fixture:... -->` marker so the test harness can extract blocks verbatim.

Data honesty rule: any numeric value I could not state with high confidence is tagged `{{Verify}}` (template defined below) and listed in the verification checklist at the end. Verify against https://lethal.wiki before shipping; do not silently strip the tags.

---

## 0. Conventions and store mapping

- **Slugs**: lowercase kebab-case, no namespace prefix for articles (`titan`, `high-quota-routing`). Template pages use the slug prefix `template-` and the display title `Template:X` (e.g. slug `template-infobox-moon`, title `Template:Infobox_moon`). Page ids follow the existing pattern: `page-<category>-<slug>` (e.g. `page-moons-titan`).
- **Store categories**: `moons`, `entities`, `equipment`, `scrap`, `mechanics` exist in `wiki-data/categories.json`. **Proposed addition**: `strategies` (sortOrder 55, EN "Strategies", KO "전략", description "High-quota routing, rulesets, and run planning."). Until added, strategy pages can live under `mechanics` with tag `strategy`.
- **Dual categorization**: the store `category` field is canonical for navigation; in-article `[[Category:...]]` tags feed the parser's category index and must stay consistent with the store field (seed content keeps them aligned; CI can diff them).
- **Locales**: `en` seeds everything below; `ko` is already active in `wiki-data/languages.json` — the abridged Titan translation in section 4 seeds `translations/ko`.
- **Version tabs**: the existing Markdown `:::version-tabs` block (see `docs/version-tabs.md`) is a Markdown-era feature. Wikitext seed content expresses version differences with `{{Version}}` boxes instead; a wikitext-native version-tab construct is out of scope for this plan.

### Parser feature budget exercised by these fixtures

The fresh parser must support exactly this set (nothing more is required by the seed content):

- `== Headings ==` (levels 2-3), `'''bold'''`, `''italic''`
- Internal links `[[Page]]`, piped `[[Page|label]]`, red links (target page absent)
- External links `[https://example.org label]`
- Wikitables (`{|` ... `|}`) with `!` headers and `|-` rows, `class="wikitable"`
- Raw HTML subset inside templates: `table`, `tr`, `th`, `td`, `div`, `sup`, `br` tags with `style`, `class`, `title` attributes (sanitized allowlist)
- Template transclusion `{{Name|a=1|b=2}}`, positional params (`{{{1|}}}`), named params with defaults (`{{{param|fallback}}}`)
- Parser functions: `{{#if:...}}`, `{{#ifeq:...}}`, `{{#switch:...}}` (incl. fall-through cases `|A|B=x` and `#default`)
- Nested transclusion inside template arguments (e.g. `{{Verify}}` inside an infobox param value — explicit stress test)
- `<ref>...</ref>`, named refs `<ref name="x">`, re-use `<ref name="x" />`, and `<references />`
- `[[Category:X]]` (renders nothing inline; registers membership), `[[File:name.png|260px|alt]]` (may render a placeholder box until the media pipeline lands)
- **Not required**: Lua/Scribunto, the `{{!}}` magic word (infoboxes use HTML tables precisely to avoid pipe-escaping inside `#if`), `includeonly`/`noinclude` tags (see note on `Template:Stub`), `{{PAGENAME}}` and other magic words (all templates take an explicit `name` param).

---

## 1. Seed page inventory (~25 initial EN pages)

"Core" rows = the initial 25. Rows marked *(wave 1.5)* are the first follow-ups and bring the listed total to 28.

### Moons (store category `moons`)

| Slug | Title | Tags | Scope (1 line) |
|---|---|---|---|
| `titan` | 8-Titan | moon, tier3, high-quota | Classic HQ workhorse; stairs/fire-exit routing, scrap density, entity pool. **Full seed article in section 3.** |
| `artifice` | 68-Artifice | moon, tier3, high-quota | Highest-value moon (v50+); Old Bird surface play, routing, why it defines modern HQ pace. |
| `rend` | 85-Rend | moon, tier3 | Snow moon; long dark walk to entrance, Jester/Nutcracker pool, when it beats Dine. |
| `dine` | 7-Dine | moon, tier3 | Snow moon; fire-exit-first routing, mansion odds, mid-tier HQ alternative. |
| `experimentation` | 41-Experimentation | moon, tier1 | Free starter moon; early-run credit farming and gear-buy day patterns. |
| `embrion` | 5-Embrion | moon, tier3 | *(wave 1.5)* Radiation moon; niche HQ use, apparatus-heavy interior notes. |
| `gordion` | The Company (71-Gordion) | moon, selling | Selling floor: desk behavior, counter item placement, bell etiquette, deadline-day flow. |

### Entities (store category `entities`)

| Slug | Title | Tags | Scope (1 line) |
|---|---|---|---|
| `jester` | Jester | entity, indoor, run-ender | Wind-up timer, dip discipline, reset-by-exiting. **Full seed article in section 3.** |
| `bracken` | Bracken | entity, indoor | Stare mechanics, anger meter, corner-checking while looting fast. |
| `coil-head` | Coil-Head | entity, indoor | Line-of-sight freezing, escort strats, door buffering on long hauls. |
| `nutcracker` | Nutcracker | entity, indoor | Shotgun drops (free weapon economy), scan-step behavior, kill routes. |
| `old-bird` | Old Bird | entity, outdoor | Artifice surface control: spawn counts, aggro ranges, ship-camping counterplay. |
| `masked` | Masked | entity, indoor | *(wave 1.5)* Mimic identification and wipe prevention on large lobbies. |

### Equipment (store category `equipment`)

| Slug | Title | Tags | Scope (1 line) |
|---|---|---|---|
| `jetpack` | Jetpack | equipment, movement | 700-credit mobility; fuel/explosion rules, Artifice/Titan flight lines. |
| `teleporters` | Teleporters | equipment, ship-upgrade | Regular + inverse TP: cooldowns, item-drop rules, inverse-dive loops that anchor HQ scrap ferrying. |
| `zap-gun` | Zap gun | equipment, utility | Beam-steering minigame, which entities it holds, battery discipline. |
| `cruiser` | Company Cruiser | equipment, vehicle | *(wave 1.5)* Cargo hauling, ramming entities, boost/self-destruct quirks. |

### Scrap (store category `scrap`)

| Slug | Title | Tags | Scope (1 line) |
|---|---|---|---|
| `apparatus` | Apparatus | scrap, fixed-value | Fixed 80-credit pull; power-off consequences (lights, doors, turrets) and when to pull it. |
| `gold-bar` | Gold bar | scrap, high-value | Top value-per-slot scrap; spawn moons and value range. |
| `cash-register` | Cash register | scrap, heavy | Extreme weight vs. value tradeoff; when hauling it is worth the time. |

### Mechanics (store category `mechanics`)

| Slug | Title | Tags | Scope (1 line) |
|---|---|---|---|
| `quota` | Quota | mechanics, formula, high-quota | Profit-quota growth formula, deadline, buying rates, expected progression. **Full seed article in section 3.** |
| `overtime-bonus` | Overtime bonus | mechanics, formula | Exact overtime payout math and how HQ runs bank credits with it. |
| `scrap-value-multiplier` | Scrap value multiplier | mechanics, formula | How map scrap value/amount scale as the quota rises; interaction with moon choice. |
| `weather` | Weather | mechanics | All weather types incl. Eclipsed; spawn-pressure effects; which weathers HQ runs actually accept. |
| `company-selling` | Selling at the Company | mechanics, selling | Buying-rate-by-day table, desk mechanics, deadline-day 100% selling. |

### Strategies (proposed store category `strategies`; interim: `mechanics` + tag `strategy`)

| Slug | Title | Tags | Scope (1 line) |
|---|---|---|---|
| `high-quota-routing` | High quota routing | strategy, routing | Moon rotation per quota band, ship-leave timing, role assignments (ship watcher, runners). |
| `one-day-quota` | One-day quota | strategy | Filling a full quota in a single moon-day: prerequisites, loadouts, benchmarks. |
| `apparatus-pulls` | Apparatus pulls | strategy | End-of-day appy timing, blackout routing, who pulls and when (vs. the `apparatus` item page). |

Count: 25 core + 3 wave-1.5 = 28 listed.

---
## 2. Seed template inventory (store as `Template:` pages)

Design decisions, applied consistently:

- Infobox templates use **raw HTML tables**, not `{|` wikitable syntax. Reason: conditional rows (`{{#if:...|<tr>...</tr>}}`) would otherwise need the `{{!}}` pipe-escape magic word, which we deliberately keep out of the parser budget.
- Only inline styles plus three documented classes: `.infobox`, `.notice`, `.reflist` (the site stylesheet may enhance them, but pages must remain readable with no CSS at all).
- Every template takes an explicit `name` param — no `{{PAGENAME}}` dependency.
- `Template:Verify` and `Template:Stub` add a `[[Category:...]]` directly. In stock MediaWiki this would be wrapped in `includeonly` tags; we skip that so the parser does not need includeonly support. Side effect: the template pages themselves appear in those maintenance categories — accepted and documented here.

### 2.1 `Template:Infobox_moon` (slug `template-infobox-moon`)

Params: `name`, `image`, `cost`, `tier` (1/2/3), `risk` (D..S++/Safe), `layout_size`, `map_multiplier`, `min_scrap`, `max_scrap`, `weather`, `interior`, `indoor_power`, `outdoor_power`. All optional except `name`; omitted params drop their row.

<!-- fixture:template-infobox-moon -->
```wikitext
<table class="infobox" style="float:right; clear:right; width:290px; margin:0 0 1em 1.5em; border:1px solid #a2a9b1; background:#f8f9fa; border-collapse:collapse; font-size:88%; line-height:1.5;">
<tr><th colspan="2" style="background:#1f2a44; color:#ffffff; padding:6px 8px; font-size:112%; text-align:center;">{{{name|Unnamed moon}}}</th></tr>
{{#if:{{{image|}}}|<tr><td colspan="2" style="text-align:center; padding:6px; background:#ffffff;">[[File:{{{image}}}|260px|{{{name|}}}]]</td></tr>}}
{{#if:{{{cost|}}}|<tr><th style="text-align:left; vertical-align:top; padding:4px 8px; width:46%; background:#eef1f5;">Route cost</th><td style="padding:4px 8px;">{{#ifeq:{{{cost}}}|0|Free|{{{cost}}} credits}}</td></tr>}}
{{#if:{{{tier|}}}|<tr><th style="text-align:left; vertical-align:top; padding:4px 8px; background:#eef1f5;">Tier</th><td style="padding:4px 8px;">{{#switch:{{{tier}}}|1=Tier 1 (starter)|2=Tier 2 (mid)|3=Tier 3 (endgame)|#default={{{tier}}}}}</td></tr>}}
{{#if:{{{risk|}}}|<tr><th style="text-align:left; vertical-align:top; padding:4px 8px; background:#eef1f5;">Risk level</th><td style="padding:4px 8px;"><b style="color:#{{#switch:{{{risk}}}|S++|S+|S=b3261e|A=c4690c|B=8a7a00|C=2e7d32|D=1565c0|Safe=5b6570|#default=333333}};">{{{risk}}}</b></td></tr>}}
{{#if:{{{layout_size|}}}|<tr><th style="text-align:left; vertical-align:top; padding:4px 8px; background:#eef1f5;">Interior size</th><td style="padding:4px 8px;">{{{layout_size}}}</td></tr>}}
{{#if:{{{map_multiplier|}}}|<tr><th style="text-align:left; vertical-align:top; padding:4px 8px; background:#eef1f5;">Map size multiplier</th><td style="padding:4px 8px;">&times;{{{map_multiplier}}}</td></tr>}}
{{#if:{{{min_scrap|}}}{{{max_scrap|}}}|<tr><th style="text-align:left; vertical-align:top; padding:4px 8px; background:#eef1f5;">Scrap items</th><td style="padding:4px 8px;">{{{min_scrap|?}}} &ndash; {{{max_scrap|?}}}</td></tr>}}
{{#if:{{{weather|}}}|<tr><th style="text-align:left; vertical-align:top; padding:4px 8px; background:#eef1f5;">Possible weather</th><td style="padding:4px 8px;">{{{weather}}}</td></tr>}}
{{#if:{{{interior|}}}|<tr><th style="text-align:left; vertical-align:top; padding:4px 8px; background:#eef1f5;">Interior types</th><td style="padding:4px 8px;">{{{interior}}}</td></tr>}}
{{#if:{{{indoor_power|}}}|<tr><th style="text-align:left; vertical-align:top; padding:4px 8px; background:#eef1f5;">Max indoor power</th><td style="padding:4px 8px;">{{{indoor_power}}}</td></tr>}}
{{#if:{{{outdoor_power|}}}|<tr><th style="text-align:left; vertical-align:top; padding:4px 8px; background:#eef1f5;">Max outdoor power</th><td style="padding:4px 8px;">{{{outdoor_power}}}</td></tr>}}
</table>
```

### 2.2 `Template:Infobox_entity` (slug `template-infobox-entity`)

Params: `name`, `image`, `hp` (number or "Invulnerable"), `power_level`, `max_spawn`, `speed`, `danger` (Low/Moderate/High/Extreme), `stunnable` (yes/no), `killable` (yes/no), `locations`, `type` (Indoor/Outdoor/Daytime).

<!-- fixture:template-infobox-entity -->
```wikitext
<table class="infobox" style="float:right; clear:right; width:290px; margin:0 0 1em 1.5em; border:1px solid #a2a9b1; background:#f8f9fa; border-collapse:collapse; font-size:88%; line-height:1.5;">
<tr><th colspan="2" style="background:#4a1f2a; color:#ffffff; padding:6px 8px; font-size:112%; text-align:center;">{{{name|Unnamed entity}}}</th></tr>
{{#if:{{{image|}}}|<tr><td colspan="2" style="text-align:center; padding:6px; background:#ffffff;">[[File:{{{image}}}|260px|{{{name|}}}]]</td></tr>}}
{{#if:{{{type|}}}|<tr><td colspan="2" style="text-align:center; padding:2px 8px; font-style:italic; background:#f0e6e8;">{{{type}}} entity</td></tr>}}
{{#if:{{{hp|}}}|<tr><th style="text-align:left; vertical-align:top; padding:4px 8px; width:46%; background:#f3eded;">HP</th><td style="padding:4px 8px;">{{{hp}}}</td></tr>}}
{{#if:{{{power_level|}}}|<tr><th style="text-align:left; vertical-align:top; padding:4px 8px; background:#f3eded;">Power level</th><td style="padding:4px 8px;">{{{power_level}}}</td></tr>}}
{{#if:{{{max_spawn|}}}|<tr><th style="text-align:left; vertical-align:top; padding:4px 8px; background:#f3eded;">Max spawned</th><td style="padding:4px 8px;">{{{max_spawn}}}</td></tr>}}
{{#if:{{{speed|}}}|<tr><th style="text-align:left; vertical-align:top; padding:4px 8px; background:#f3eded;">Speed</th><td style="padding:4px 8px;">{{{speed}}}</td></tr>}}
{{#if:{{{danger|}}}|<tr><th style="text-align:left; vertical-align:top; padding:4px 8px; background:#f3eded;">Danger</th><td style="padding:4px 8px;"><b style="color:#{{#switch:{{{danger}}}|Extreme=b3261e|High=c4690c|Moderate=8a7a00|Low=2e7d32|#default=333333}};">{{{danger}}}</b></td></tr>}}
{{#if:{{{stunnable|}}}|<tr><th style="text-align:left; vertical-align:top; padding:4px 8px; background:#f3eded;">Stunnable</th><td style="padding:4px 8px;">{{#ifeq:{{{stunnable}}}|yes|Yes|{{#ifeq:{{{stunnable}}}|no|No|{{{stunnable}}}}}}}</td></tr>}}
{{#if:{{{killable|}}}|<tr><th style="text-align:left; vertical-align:top; padding:4px 8px; background:#f3eded;">Killable</th><td style="padding:4px 8px;">{{#ifeq:{{{killable}}}|yes|Yes|{{#ifeq:{{{killable}}}|no|'''No'''|{{{killable}}}}}}}</td></tr>}}
{{#if:{{{locations|}}}|<tr><th style="text-align:left; vertical-align:top; padding:4px 8px; background:#f3eded;">Found on</th><td style="padding:4px 8px;">{{{locations}}}</td></tr>}}
</table>
```

### 2.3 `Template:Infobox_item` (slug `template-infobox-item`)

Params: `name`, `image`, `type` (Equipment/Scrap/Ship upgrade), `price` (store credits; equipment), `value_min`, `value_max` (scrap sell value), `weight` (lb), `conductive` (yes/no), `two_handed` (yes/no), `battery` (e.g. duration or "None").

<!-- fixture:template-infobox-item -->
```wikitext
<table class="infobox" style="float:right; clear:right; width:290px; margin:0 0 1em 1.5em; border:1px solid #a2a9b1; background:#f8f9fa; border-collapse:collapse; font-size:88%; line-height:1.5;">
<tr><th colspan="2" style="background:#1f4433; color:#ffffff; padding:6px 8px; font-size:112%; text-align:center;">{{{name|Unnamed item}}}</th></tr>
{{#if:{{{image|}}}|<tr><td colspan="2" style="text-align:center; padding:6px; background:#ffffff;">[[File:{{{image}}}|260px|{{{name|}}}]]</td></tr>}}
{{#if:{{{type|}}}|<tr><td colspan="2" style="text-align:center; padding:2px 8px; font-style:italic; background:#e8f0ec;">{{#switch:{{{type}}}|Equipment=Purchasable equipment|Scrap=Scrap item|Ship upgrade=Ship upgrade|#default={{{type}}}}}</td></tr>}}
{{#if:{{{price|}}}|<tr><th style="text-align:left; vertical-align:top; padding:4px 8px; width:46%; background:#ecf3ef;">Store price</th><td style="padding:4px 8px;">{{{price}}} credits</td></tr>}}
{{#if:{{{value_min|}}}{{{value_max|}}}|<tr><th style="text-align:left; vertical-align:top; padding:4px 8px; width:46%; background:#ecf3ef;">Sell value</th><td style="padding:4px 8px;">{{#ifeq:{{{value_min|}}}|{{{value_max|}}}|{{{value_min}}} (fixed)|{{{value_min|?}}} &ndash; {{{value_max|?}}}}} credits</td></tr>}}
{{#if:{{{weight|}}}|<tr><th style="text-align:left; vertical-align:top; padding:4px 8px; background:#ecf3ef;">Weight</th><td style="padding:4px 8px;">{{{weight}}} lb</td></tr>}}
{{#if:{{{conductive|}}}|<tr><th style="text-align:left; vertical-align:top; padding:4px 8px; background:#ecf3ef;">Conductive</th><td style="padding:4px 8px;">{{#ifeq:{{{conductive}}}|yes|'''Yes''' (drop it in [[Weather|storms]])|No}}</td></tr>}}
{{#if:{{{two_handed|}}}|<tr><th style="text-align:left; vertical-align:top; padding:4px 8px; background:#ecf3ef;">Two-handed</th><td style="padding:4px 8px;">{{#ifeq:{{{two_handed}}}|yes|Yes|No}}</td></tr>}}
{{#if:{{{battery|}}}|<tr><th style="text-align:left; vertical-align:top; padding:4px 8px; background:#ecf3ef;">Battery</th><td style="padding:4px 8px;">{{{battery}}}</td></tr>}}
</table>
```

### 2.4 `Template:Infobox_mechanic` (slug `template-infobox-mechanic`) — small bonus template

Not in the original template list, added so that mechanics articles (the Quota fixture) also exercise an infobox. Params: `name`, `image`, `introduced`, `formula`, `related`.

<!-- fixture:template-infobox-mechanic -->
```wikitext
<table class="infobox" style="float:right; clear:right; width:290px; margin:0 0 1em 1.5em; border:1px solid #a2a9b1; background:#f8f9fa; border-collapse:collapse; font-size:88%; line-height:1.5;">
<tr><th colspan="2" style="background:#3c3363; color:#ffffff; padding:6px 8px; font-size:112%; text-align:center;">{{{name|Unnamed mechanic}}}</th></tr>
{{#if:{{{image|}}}|<tr><td colspan="2" style="text-align:center; padding:6px; background:#ffffff;">[[File:{{{image}}}|260px|{{{name|}}}]]</td></tr>}}
{{#if:{{{introduced|}}}|<tr><th style="text-align:left; vertical-align:top; padding:4px 8px; width:40%; background:#edecf3;">Introduced</th><td style="padding:4px 8px;">{{{introduced}}}</td></tr>}}
{{#if:{{{formula|}}}|<tr><th style="text-align:left; vertical-align:top; padding:4px 8px; background:#edecf3;">Formula</th><td style="padding:4px 8px; font-family:monospace; font-size:95%;">{{{formula}}}</td></tr>}}
{{#if:{{{related|}}}|<tr><th style="text-align:left; vertical-align:top; padding:4px 8px; background:#edecf3;">Related</th><td style="padding:4px 8px;">{{{related}}}</td></tr>}}
</table>
```

### 2.5 `Template:Stub` (slug `template-stub`)

<!-- fixture:template-stub -->
```wikitext
<div class="notice" style="border:1px dashed #8a94a6; background:#f4f6fa; padding:8px 12px; margin:8px 0; font-size:92%;">'''This article is a stub.''' It was seeded with minimal content — you can help the high-quota community by expanding it with verified data.</div>[[Category:Stubs]]
```

### 2.6 `Template:Version` (slug `template-version`)

Params: `version` (e.g. "v50", "v64+"), `note`. Renders a version-specific note box; used instead of Markdown-era version tabs.

<!-- fixture:template-version -->
```wikitext
<div class="notice" style="border-left:4px solid #4a6fb3; background:#eef3fb; padding:6px 10px; margin:8px 0; font-size:92%;">'''Version note{{#if:{{{version|}}}|&nbsp;({{{version}}})}}:''' {{{note|This section describes version-specific behavior.}}}</div>
```

### 2.7 `Template:Reflist` (slug `template-reflist`)

<!-- fixture:template-reflist -->
```wikitext
<div class="reflist" style="font-size:88%; line-height:1.5; margin-top:4px;"><references /></div>
```

### 2.8 `Template:Verify` (slug `template-verify`)

Optional positional param `{{{1}}}` = short hint about what needs checking. Tags the page into a maintenance category.

<!-- fixture:template-verify -->
```wikitext
<sup class="notice" style="color:#b3261e; font-weight:bold; white-space:nowrap;" title="This value has not been verified against the current game version{{#if:{{{1|}}}|&#58; {{{1}}}}}.">[verify]</sup>[[Category:Pages with unverified data]]
```

---
## 3. Example articles (seed content + parser integration-test fixtures)

Each article deliberately exercises: its matching infobox, `==` sections, a wikitable with real data, internal links including at least one **intentional red link** (target outside the seed inventory — noted per article), an external community link, `<ref>` + `<references/>` (via `{{Reflist}}`), `[[Category:]]` tags, and bold/italic. `{{Verify}}` marks numbers to be checked (section 6).

### 3.1 Article: `titan` — "8-Titan"

Intentional red links in the seed set: `[[Fancy lamp]]`, `[[Snare Flea]]`, `[[Eclipsed]]`.

<!-- fixture:article-titan-en -->
```wikitext
{{Infobox_moon
| name = 8-Titan
| image = moon-titan.png
| cost = 700
| tier = 3
| risk = S+
| layout_size = Large
| map_multiplier = 2.35{{Verify|map size multiplier}}
| min_scrap = 28
| max_scrap = 31
| weather = None, Foggy, Stormy, Eclipsed{{Verify|weather pool for snow moons}}
| interior = Factory (very common), Mansion (rare){{Verify|interior weights}}
| indoor_power = 18
| outdoor_power = 7{{Verify|outdoor power cap}}
}}
'''8-Titan''' is a tier-3 snow moon and, for most of the game's history, ''the'' standard farming moon of the high-quota community. At 700 credits it is the most expensive route below [[Artifice]], but it pays that back with the densest combination of scrap count, scrap value, and ship-to-entrance proximity in the pre-v50 rotation.<ref name="lethalwiki">Moon data cross-checked against the community-maintained [https://lethal.wiki Lethal Company Wiki].</ref>

== Overview ==
Titan's surface is a narrow, frozen platform complex. The ship lands directly beside the facility structure, and the '''main entrance''' sits at the top of a long staircase only a short climb away — the fastest ship-to-door commute of any paid moon.{{Verify|fastest commute claim}} Outside threats such as [[Eyeless Dog|Eyeless Dogs]] have very little walkable area, which concentrates the danger ''inside'' the facility.

== Layout and routing ==
* '''Main route''': ship &rarr; staircase &rarr; main entrance. Safe under most weather; the stairs are the only chokepoint.
* '''Fire exit''': opens onto a high catwalk. Dropping from the catwalk toward the ship is a one-way shortcut used to end hauls quickly; climbing back up requires the stairs or an [[Extension ladder]].{{Verify|catwalk drop routing}}
* The interior is almost always the '''Factory''' layout; Mansion rolls are rare on Titan.{{Verify|interior weights}} With max indoor power 18, late-day interiors get crowded — plan dips (see [[Jester]]).

== Scrap ==
Titan spawns 28&ndash;31 scrap items per day, skewed toward high-value pieces. Typical notable finds:

{| class="wikitable"
! Item !! Typical value (credits) !! Notes
|-
| [[Gold bar]] || ~155 average{{Verify|gold bar average value}} || Best value per inventory slot in the game.
|-
| [[Cash register]] || ~150 average{{Verify|cash register value}} || Extremely heavy; usually hauled last or left.
|-
| [[Fancy lamp]] || ~100 average{{Verify|fancy lamp value}} || Fragile-looking but safe to drop; two-handed.
|-
| [[Apparatus]] || 80 (fixed) || Standard end-of-day pull; see [[Apparatus pulls]].
|}

== Entities ==
Titan's indoor pool contains every classic run-ender at high spawn weight:

{| class="wikitable"
! Entity !! Power !! Threat profile
|-
| [[Jester]] || 3 || The clock every Titan day runs on; forces full-team dips once wound.
|-
| [[Bracken]] || 3{{Verify|Bracken power level}} || Punishes solo corridor looting.
|-
| [[Coil-Head]] || 1 || Cheap to spawn; multiple Coil-Heads plus a Jester is the classic wipe recipe.
|-
| [[Nutcracker]] || 1{{Verify|Nutcracker power level}} || Shotgun drop makes it a net resource for confident teams.
|-
| [[Eyeless Dog]] || 2{{Verify|dog power level}} || Outside only; mostly a non-issue on the platform but lethal at the ship door.
|-
| [[Snare Flea]] || 1 || Ceiling ambusher on the stair-side entrance tiles.
|}

== High quota play ==
Before v50, Titan was simply where high quota happened: short commute, top-tier scrap table, and an easy [[Apparatus]] pull. Since [[Artifice]] arrived (v50) Titan is the ''secondary'' moon in most modern routes, but it remains the standard on rulesets and older patches where Artifice is banned or unavailable, and it is still the best practice ground for [[One-day quota]] pacing. An ''Eclipsed'' Titan is generally rerouted rather than fought.{{Verify|community consensus on Eclipsed Titan}} See [[High quota routing]] for when Titan enters the rotation.

== Version notes ==
{{Version|version=v40&ndash;v49|note=Titan has been available since the initial Early Access release; scrap counts and enemy pools were retuned several times before v50.{{Verify|retuning history}}}}
{{Version|version=v50+|note=[[Artifice]] outclasses Titan on raw scrap value, moving Titan to a secondary/practice role in most high-quota routes.}}

== External links ==
* [https://lethal.wiki Lethal Company Wiki] — community reference for raw moon data.
* [https://www.reddit.com/r/lethalcompany/ r/lethalcompany] — general community hub where high-quota clips and routes are shared.

== References ==
{{Reflist}}

[[Category:Moons]]
[[Category:Tier 3 moons]]
```

### 3.2 Article: `jester` — "Jester"

Intentional red links in the seed set: `[[Stun grenade]]`, `[[Apparatus room]]`.

<!-- fixture:article-jester-en -->
```wikitext
{{Infobox_entity
| name = Jester
| image = entity-jester.png
| hp = Invulnerable
| power_level = 3
| max_spawn = 1
| speed = Slow (roaming) / far above sprint speed (popped)
| danger = Extreme
| stunnable = yes
| killable = no
| locations = [[Rend]], [[Dine]], [[Titan]], [[Artifice]]
| type = Indoor
}}
The '''Jester''' is an invulnerable indoor entity resembling a walking jack-in-the-box. It is ''the'' defining threat of tier-3 moons: it cannot be killed, and once its crank finishes winding it chases players at a speed no loadout can outrun in open corridors. High-quota play on [[Rend]], [[Dine]], and [[Titan]] is structured almost entirely around the Jester's timer.<ref name="lethalwiki">Behavior cross-checked against the community-maintained [https://lethal.wiki Lethal Company Wiki].</ref>

== Behavior ==
The Jester cycles through three phases:

{| class="wikitable"
! Phase !! Duration !! Behavior
|-
| '''Roaming''' || Variable || Follows players around the facility at a slow walk. Harmless; it can be walked past freely.
|-
| '''Winding''' || &asymp;35&ndash;45 seconds{{Verify|exact wind duration and randomness}} || Stops, plays ''Pop Goes the Weasel'', and turns its crank with accelerating music. This is the evacuation window.
|-
| '''Popped''' || Until no players remain inside || The head emerges and it pursues the nearest player far faster than sprint speed, killing on contact. It opens doors, including locked ones.{{Verify|locked door behavior}}
|}

== Counterplay ==
* It takes '''no damage''' from any weapon — do not spend swings on it.
* [[Stun grenade|Stun grenades]] and the [[Zap gun]]{{Verify|zap gun effectiveness on Jester}} halt it briefly; use them only to unstick a trapped teammate, not to extend looting.
* It '''cannot leave the facility'''. When every player exits, a popped Jester eventually winds down and returns to roaming — this full reset is the core of ''dip'' play.
* While it is winding, drop distant loot and commit to the nearest exit; dying deep in the [[Apparatus room]] costs the body ''and'' the haul.

== High quota relevance ==
On tier-3 moons the Jester functions as the day's clock. Standard practice: the ship watcher calls the Jester spawn from the monitor, runners keep looting through the roaming phase, and the first crank note triggers a coordinated dip. After the reset, the team re-enters and repeats. Mastering this loop is what separates mid quotas from record pace — see [[High quota routing]] and [[One-day quota]].

== Version notes ==
{{Version|version=v40+|note=Present since the initial Early Access release with behavior essentially unchanged; later patches adjusted spawn weights on individual moons.{{Verify|spawn weight history}}}}

== External links ==
* [https://lethal.wiki Lethal Company Wiki] — entity data reference.
* [https://www.reddit.com/r/lethalcompany/ r/lethalcompany] — community discussion of Jester dips and timings.

== References ==
{{Reflist}}

[[Category:Entities]]
[[Category:Indoor entities]]
```

### 3.3 Article: `quota` — "Quota"

Intentional red links in the seed set: `[[Deadline]]`, `[[Credits]]`.

<!-- fixture:article-quota-en -->
```wikitext
{{Infobox_mechanic
| name = Profit quota
| introduced = Initial Early Access release
| formula = Q' = Q + 100 &times; (1 + F&sup2;/16) &times; R
| related = [[Overtime bonus]], [[Scrap value multiplier]], [[Selling at the Company]], [[One-day quota]]
}}
The '''profit quota''' is the amount of scrap value ''The Company'' demands every three days. It starts at '''130''' [[Credits|credits]] and grows quadratically each time it is fulfilled, which is the entire reason the high-quota discipline exists: the run does not end until the crew fails a quota.<ref name="decomp">Formula as commonly documented from decompiled game code (TimeOfDay.SetNewProfitQuota); see the community-maintained [https://lethal.wiki Lethal Company Wiki] for the current-version values.</ref>

== How the quota grows ==
When a quota is fulfilled, the next quota is computed as:

: <code>newQuota = oldQuota + 100 &times; (1 + F&sup2;/16) &times; R</code>

where '''F''' is the number of quotas fulfilled so far and '''R''' is a random multiplier drawn between roughly 0.5 and 1.5, weighted toward 1.{{Verify|randomizer curve shape}} The result is truncated to an integer. Because F is ''squared'', growth accelerates forever — the formula guarantees every run eventually fails.

Expected progression with average rolls (R = 1):

{| class="wikitable"
! Quotas fulfilled (F) !! Increase (avg roll) !! New quota
|-
| 0 || &mdash; || 130
|-
| 1 || 106 || 236
|-
| 2 || 125 || 361
|-
| 3 || 156 || 517
|-
| 4 || 200 || 717
|-
| 5 || 256 || 973
|-
| 6 || 325 || 1298
|-
| 7 || 406 || 1704
|-
| 8 || 500 || 2204
|-
| 9 || 606 || 2810
|-
| 10 || 725 || 3535
|}

Real runs deviate from this table because of the random multiplier; high-quota record tracking therefore reports ''quotas cleared'' alongside raw credit totals.

== Deadline and selling ==
Each quota comes with a 3-day [[Deadline]]. Scrap sold at [[The Company (71-Gordion)|the Company]] is bought at a rate that improves as the deadline approaches:

{| class="wikitable"
! Days left !! Buying rate
|-
| 3 || 30%{{Verify|buying rate table}}
|-
| 2 || 53%{{Verify|buying rate table}}
|-
| 1 || 77%{{Verify|buying rate table}}
|-
| 0 (deadline day) || '''100%'''
|}

High-quota runs therefore ''always'' sell on deadline day at 100% — selling early burns value for nothing. See [[Selling at the Company]].

== Overtime bonus ==
Selling more than the quota pays an '''overtime bonus''', commonly documented as:

: <code>overtime = (amountSold &minus; quota) / 5 + 15 &times; daysLeftAfterFulfilling</code>{{Verify|overtime formula, esp. the days term}}

Details and edge cases live on the [[Overtime bonus]] page.

== High quota play ==
* The loop is: route moons by quota band ([[High quota routing]]), fill each quota in as few days as possible (ideally a [[One-day quota]]), sell everything at 100% on deadline day, and bank the surplus.
* Rising quotas also raise the map [[Scrap value multiplier]], so later moons are worth more per item — the game partially funds its own difficulty curve.{{Verify|multiplier scaling behavior and cap}}
* Fixed-value income such as the [[Apparatus]] (80 credits) matters early, and becomes rounding error at high F.

== Version notes ==
{{Version|version=v40+|note=The growth formula above has been stable across Early Access versions; individual patches changed scrap spawning far more than quota math.{{Verify|formula stability across versions}}}}

== External links ==
* [https://lethal.wiki Lethal Company Wiki] — mechanics reference.
* [https://www.reddit.com/r/lethalcompany/ r/lethalcompany] — where community high-quota results are posted.

== References ==
{{Reflist}}

[[Category:Mechanics]]
[[Category:High quota]]
```

---
## 4. KO translation seed: `titan` (abridged)

Seeds the translation system: store under page `page-moons-titan`, `translations/ko`. It is deliberately abridged (marked `{{Stub}}`) so the KO revision is a genuinely shorter document than the EN head — a realistic fixture for translation-status UI ("outdated/partial" states). Template names and params stay in English (templates are locale-neutral); link labels are localized via pipes. `[[Category:Moons]]` is kept as the EN store id; category label localization already lives in `wiki-data/categories.json`.

<!-- fixture:article-titan-ko -->
```wikitext
{{Stub}}
{{Infobox_moon
| name = 8-타이탄
| image = moon-titan.png
| cost = 700
| tier = 3
| risk = S+
| layout_size = 대형
| map_multiplier = 2.35{{Verify|맵 크기 배수}}
| min_scrap = 28
| max_scrap = 31
| indoor_power = 18
}}
'''8-타이탄'''(8-Titan)은 3티어 설원 위성으로, [[Artifice|아티피스]]가 추가되기 전까지 하이 쿼터(high quota) 커뮤니티의 표준 파밍 위성이었다. 항로 비용은 700 크레딧이며 위험 등급은 '''S+'''이다.<ref name="lethalwiki">수치는 커뮤니티 위키 [https://lethal.wiki Lethal Company Wiki] 기준으로 검증 필요.</ref>

== 개요 ==
함선은 시설 바로 옆 플랫폼에 착륙하며, 긴 계단을 오르면 바로 '''정문'''이다. 유료 위성 중 함선과 입구 사이 왕복 시간이 가장 짧다.{{Verify|최단 동선 주장}} 하루에 스크랩이 28&ndash;31개 스폰되고 [[Gold bar|금괴]] 등 고가치 아이템 비중이 높다. 내부는 대부분 ''공장(Factory)'' 구조이다.

== 하이 쿼터 관점 ==
* v50 이전에는 사실상 유일한 표준 파밍 위성이었고, [[Artifice|아티피스]] 등장 이후에는 보조 위성 및 [[One-day quota|원데이 쿼터]] 연습 무대로 쓰인다.
* 실내 최대 파워 18로 후반 스폰 압박이 강하므로 [[Jester|제스터]] 타이머 중심의 딥(dip) 운영이 필수다.
* 하루를 마칠 때는 [[Apparatus|어퍼레이터스]](고정 80 크레딧)를 뽑는 것이 정석이다.

== 참고 ==
{{Reflist}}

[[Category:Moons]]
```

---

## 5. Fixture coverage matrix

Which parser feature each fixture exercises (T = template fixtures 2.1-2.8, A1 = Titan EN, A2 = Jester, A3 = Quota, K = Titan KO):

| Feature | T | A1 | A2 | A3 | K |
|---|---|---|---|---|---|
| `==` / `===` headings | — | yes | yes | yes | yes |
| Bold / italic | 2.2, 2.3, 2.5 | yes | yes | yes | yes |
| Internal link, piped link | 2.1, 2.3 | yes | yes | yes | yes |
| **Red link** (target absent from seed set) | — | Fancy lamp, Snare Flea, Eclipsed | Stun grenade, Apparatus room | Deadline, Credits | — |
| External link | — | yes | yes | yes | yes |
| `<ref>` named + `<references/>` via `{{Reflist}}` | 2.7 | yes | yes | yes | yes |
| Wikitable `{| ... |}` | — | 2 tables | 1 table | 2 tables | — |
| HTML table (infobox) | 2.1-2.4 | yes | yes | yes | yes |
| `{{#if:}}` incl. concatenated-params test | all infoboxes | via infobox | via infobox | via infobox | via omitted params |
| `{{#ifeq:}}` | 2.1, 2.2, 2.3 | cost != 0 path | stunnable/killable paths | — | — |
| `{{#switch:}}` incl. fall-through + `#default` | 2.1, 2.2, 2.3 | risk=S+ fall-through | danger=Extreme | — | risk=S+ |
| Positional param `{{{1|}}}` | 2.8 | via `{{Verify|...}}` | yes | yes | yes (Korean arg text) |
| Nested template in template arg | — | `{{Verify}}` inside infobox params | yes | yes | yes |
| Nested template in `{{Version}}` note param | — | yes | yes | yes | — |
| `[[Category:]]` | 2.5, 2.8 | 2 tags | 2 tags | 2 tags | 1 tag + Stub-injected + Verify-injected |
| `[[File:...|260px|alt]]` | 2.1-2.4 | yes | yes | — (no image param) | yes |
| HTML entities (`&ndash;` `&times;` `&asymp;` `&sup2;`) | 2.1 | yes | yes | yes | yes |
| `<code>`, `:` indented line | — | — | — | yes | — |
| Multibyte (CJK) text through the full pipeline | — | — | — | — | yes |

Renderer edge cases these fixtures intentionally trigger:

1. `{{Verify|...}}` inside an infobox **param value** — argument containing a pipe inside a nested template call must not split the outer template's params.
2. `{{Version|note=...{{Verify|...}}...}}` — nested transclusion two levels deep with punctuation in args.
3. Quota infobox `formula` param contains `&times;` and `&sup2;` entities inside a monospace-styled cell.
4. KO fixture: omitted infobox params (no `weather`, no `interior`) must cleanly drop rows via `#if`.
5. `{{Stub}}` and `{{Verify}}` inject categories from inside templates — category collection must run post-expansion.

## 6. Verification checklist (every `{{Verify}}` above)

Check against https://lethal.wiki (and current patch notes) before removing tags. My confidence noted per item.

| # | Fixture | Claim | Confidence |
|---|---|---|---|
| 1 | Titan | Map size multiplier 2.35 | medium |
| 2 | Titan | Weather pool for snow moons (no Rainy/Flooded) | medium-high |
| 3 | Titan | Interior weights (Factory very common, Mansion rare) | medium |
| 4 | Titan | Max outdoor power 7 (indoor 18 is high confidence) | medium |
| 5 | Titan | "Fastest ship-to-door commute of paid moons" | medium-high |
| 6 | Titan | Catwalk-drop fire-exit routing details | medium |
| 7 | Titan | Gold bar ~155 / Cash register ~150 / Fancy lamp ~100 averages | low-medium |
| 8 | Titan | Bracken power 3, Nutcracker power 1, Eyeless Dog power 2 | medium |
| 9 | Titan | Community consensus on rerouting Eclipsed Titan | medium |
| 10 | Jester | Wind duration 35-45 s and its randomness | medium |
| 11 | Jester | Popped Jester opens locked doors | medium |
| 12 | Jester | Zap gun effectiveness on Jester | low |
| 13 | Quota | Randomizer curve shape (0.5-1.5 weighted to 1) | medium-high |
| 14 | Quota | Buying rates 30/53/77/100 by days left | medium |
| 15 | Quota | Overtime formula, especially the 15-per-day term | medium |
| 16 | Quota | Scrap value multiplier scaling with quota + cap | low-medium |
| 17 | Quota | Formula stability across v40-v70 | medium |

High-confidence values shipped **without** tags (spot-check anyway): Titan cost 700 / risk S+ / scrap 28-31 / indoor power 18; Jester power 3, max 1, invulnerable; quota start 130, 3-day deadline, base increase 100, steepness 16, 100% rate on deadline day; Apparatus fixed 80.

## 7. Next steps

1. Add the `strategies` category to `wiki-data/categories.json` (section 0).
2. Land the 8 template pages, then the 3 EN articles, then the KO Titan revision (in that order — articles transclude templates).
3. Wire the fixture extractor: pull each ` ```wikitext ` block by its `<!-- fixture:id -->` marker into parser integration tests (golden-HTML snapshots + category/red-link assertions from section 5).
4. Run the section 6 verification pass against lethal.wiki, strip resolved `{{Verify}}` tags, and record sources in each article's References.
5. Backfill the remaining 22 inventory pages (section 1) using the three articles as structural exemplars.

---

## Addendum (critic)

From the pre-implementation completeness review (2026-08-31). Cross-references: `docs/engine/critique.md`.

- **Link-target ↔ slug mismatches.** Article links are written as wiki titles; the inventory's slugs are hand-assigned, and no title→slug rule is documented anywhere (critique.md O1 — decide before landing seeds). If the rule becomes `slug = slugify(normalized title)`, the bare moon links (`[[Titan]]`, `[[Artifice]]`, `[[Rend]]`, `[[Dine]]`) match the assigned slugs even though display titles are `8-Titan` / `68-Artifice` / `85-Rend` / `7-Dine`, but two entries collide outright: `[[Selling at the Company]]` → `selling-at-the-company` vs. assigned slug `company-selling`, and `[[The Company (71-Gordion)]]` → `the-company-71-gordion` vs. assigned slug `gordion`. Fix with redirects or by renaming those two slugs once O1 is decided.
- **Red-link list correction (Titan).** §3.1 also red-links `[[Eyeless Dog]]` and `[[Extension ladder]]`, both absent from the 28-page inventory. The §3.1 note and the §5 matrix row should read: A1 red links = Fancy lamp, Snare Flea, Eclipsed, Eyeless Dog, Extension ladder.
- **§0 store mapping is legacy.** The id scheme here (`page-moons-titan`, slug prefix `template-`, the store `category` field, `translations/ko`) describes the old file store; per reuse-audit §4 those files are one-off migration input. New addresses: articles → `pages(namespace='main', slug)`; templates → `pages(namespace='template', slug='infobox-moon', …)` (drop the `template-` slug prefix — the namespace column carries it); the KO Titan text → a `revisions` row with `locale='ko'` + `translated_from_rev_id` set to the EN basis revision. The store `category` navigation field has **no db-schema equivalent** — open (critique.md O3).
- **`[[File:…]]` before the media pipeline.** The spec (§5.9) renders a missing file as a red link to its File page; read this plan's "placeholder box" as exactly that — no extra placeholder construct exists.
- **Omitted infobox params.** Consecutive omitted params leave blank lines inside the raw `<table>`; rendering is defined by wikitext-spec Addendum A1 (D-14: no stray paragraphs inside p-rejecting elements). The KO fixture (omits `weather`, `interior`, `outdoor_power`, …) is the regression test for it.
- **Template locale.** "Templates are locale-neutral" (§4) is now normative engine behavior: transclusion always uses the template's EN head revision — db-schema Addendum A8.
