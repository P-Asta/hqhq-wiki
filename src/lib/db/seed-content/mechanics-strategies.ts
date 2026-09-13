import { slugifyTitle } from "@/lib/title";

import type { SeedArticle } from "../seed-data";

/**
 * Seed batch: mechanics + strategy articles (seed-content-plan.md §1
 * "Mechanics"/"Strategies"). Written to the §3 exemplar structure; every
 * number not held with high confidence carries {{Verify}} per the plan's
 * data-honesty rule. The [[Quota]] core article owns the quota-growth
 * formula — these pages link to it rather than restating it.
 *
 * Filing is wikitext-native (decisions-v2 O13): every article carries its
 * `[[Category:Mechanics]]` / `[[Category:Strategies]]` tag — no nav bucket.
 */

function article(title: string, wikitext: string): SeedArticle {
  return { title, slug: slugifyTitle(title), wikitext, translations: [] };
}

export const MECHANICS_STRATEGY_ARTICLES: readonly SeedArticle[] = [
  article(
    "Overtime bonus",
    `{{Infobox_mechanic
| name = Overtime bonus
| introduced = Initial Early Access release{{Verify|first version with overtime}}
| formula = overtime = (sold &minus; quota) / 5 + 15 &times; daysLeft
| related = [[Quota]], [[Selling at the Company]], [[High quota routing]]
}}
The '''overtime bonus''' is the extra payment ''The Company'' adds when a crew sells more scrap value than the current [[Quota|profit quota]] demands. Quota credits themselves are swallowed by the next quota, so overtime is the only income that actually accumulates — it is the engine of every high-quota bankroll, funding [[Teleporters|teleporters]], [[Jetpack|jetpacks]], and route costs for the rest of the run.<ref name="lethalwiki">Formula and payout behavior cross-checked against the community-maintained [https://lethal.wiki Lethal Company Wiki].</ref>

== The formula ==
The commonly documented payout is:

: <code>overtime = (amountSold &minus; quota) / 5 + 15 &times; daysLeftAfterFulfilling</code>{{Verify|exact constants, especially the flat 15-per-day term}}

* '''amountSold''' — the total scrap value handed over at the desk against this quota.
* '''quota''' — the current profit quota; see [[Quota]] for how it grows between deadlines.
* '''daysLeftAfterFulfilling''' — deadline days remaining at the moment the quota is met. Selling on deadline day zeroes this term.

The division by 5 means only about '''20%''' of surplus value returns as spendable credits — the other 80% simply disappears. That 20% is still the best income stream in the game, which is why high-quota crews treat every haul past the quota line as the real product of a deadline cycle.

== Worked examples ==
Deadline-day sales (days-left term = 0) unless noted:

{| class="wikitable"
! Quota !! Sold !! Surplus !! Days-left term !! Overtime paid
|-
| 500 || 700 || 200 || 0 || '''40'''
|-
| 500 || 1500 || 1000 || 0 || '''200'''
|-
| 1000 || 3000 || 2000 || 0 || '''400'''
|-
| 1000 || 3000 || 2000 || 2 days &rarr; +30{{Verify|flat term value}} || '''430'''
|}

Fulfilling early adds the small 15-per-day term, but the reduced pre-deadline buying rate costs far more than the term returns — deadline-day selling at 100% wins in every realistic case.{{Verify|break-even math against early selling}} See [[Selling at the Company]].

== Banking credits ==
Overtime is how a run stays solvent as route costs rise. The standard high-quota budget cycle: sell everything on deadline day, bank the overtime, then spend it immediately on the next cycle's needs — [[Teleporters|inverse teleporter]] charges, replacement [[Zap gun|zap guns]], flashlights, and the 700+ credit routes to [[Titan]] and [[Artifice]]. Because surplus converts at 20%, crews aim to '''oversell massively''' on each deadline rather than trickling value across quotas: the same scrap is worth the same overtime whenever it is sold, but holding it risks losing it to a wipe.

== High quota play ==
* Never sell just-enough. The quota is a floor, not a target — every credit of surplus is the run's actual income.
* Keep high-value scrap on the ship between deadlines and dump the entire hoard at 100% on deadline day; see [[High quota routing]] for the day-count economics.
* At extreme quotas the overtime from a single [[One-day quota|one-day clear]] can exceed a thousand credits, enough to refit the whole crew.{{Verify|late-game overtime magnitudes}}

== References ==
{{Reflist}}

[[Category:Mechanics]]
[[Category:High quota]]`,
  ),
  article(
    "Scrap value multiplier",
    `{{Infobox_mechanic
| name = Scrap value multiplier
| introduced = Present since Early Access; retuned in later patches{{Verify|which patches changed the multipliers}}
| formula = mapValue &asymp; baseValue &times; valueMultiplier
| related = [[Quota]], [[High quota routing]], [[Selling at the Company]]
}}
The '''scrap value multiplier''' is the hidden scaling that makes moons richer as the run goes on: as the [[Quota|profit quota]] rises, the game increases both the ''number'' of scrap items a moon spawns and the ''value'' rolled on each item. It is the reason late-run days on the same moon are worth several times an early-run day, and the reason the quota curve is survivable at all.<ref name="lethalwiki">Scaling behavior as documented by the community-maintained [https://lethal.wiki Lethal Company Wiki]; exact coefficients vary by version.</ref>

== How the scaling works ==
Each item's map value is drawn from its type's base range and then scaled by a global multiplier that grows with the current quota.{{Verify|exact multiplier formula and its quota coupling}} The scrap ''amount'' rolled for the day scales the same way, so both the count and the per-item value climb together.{{Verify|amount scaling}} The multiplier applies when the level generates — the value you scan inside the facility is already the scaled sell value, and it does not change after landing.

Practical consequences:

* A moon's listed min–max scrap counts (e.g. 28–31 on [[Titan]]) are the early-run floor; late-run days run past them.{{Verify|whether counts or only values scale}}
* Value scaling is multiplicative with the moon's base table, so it compounds fastest on moons whose tables are already rich.

== Interaction with moon choice ==
Because the multiplier is global, it never changes ''which'' moon is best — it widens the gap in favor of the best table:

{| class="wikitable"
! Quota band !! Moon !! Why the multiplier favors it
|-
| Early (&le; ~500){{Verify|band boundaries}} || [[Experimentation]] || Free route; scaling is still small, so minimizing cost beats maximizing table.
|-
| Mid || [[Titan]] || Dense high-base-value table starts compounding; short commute converts scaling into hauled credits.
|-
| Endgame || [[Artifice]] || Highest base table in the game; every point of multiplier is worth the most here.
|}

See [[High quota routing]] for the full rotation logic.

== Interaction with the buying rate ==
The multiplier sets what a day ''can'' produce; the Company's buying rate sets what you ''keep''. Selling before deadline day discounts scaled value exactly as hard as unscaled value, so the two systems together produce the standard discipline: farm scaled moons all cycle, then sell everything at 100% on deadline day ([[Selling at the Company]]). Fixed-value items such as the [[Apparatus]] (80 credits) do '''not''' scale, which is why the apparatus fades from cornerstone to rounding error as the run progresses.{{Verify|apparatus exempt from scaling}}

== High quota play ==
* Trust the scan, not the wiki table: scanned value is final sell value, already multiplied.
* Rising quotas partially fund themselves — plan routes around the scaled expectation, not early-run hauls; see [[Quota]].
* At extreme quotas, leaving low-value scrap unhauled is correct: slots and daylight are the scarce resources, not items.

== References ==
{{Reflist}}

[[Category:Mechanics]]
[[Category:High quota]]`,
  ),
  article(
    "Weather",
    `{{Infobox_mechanic
| name = Weather
| introduced = Initial Early Access release; Eclipsed added later{{Verify|version that added Eclipsed}}
| related = [[High quota routing]], [[Titan]], [[Artifice]]
}}
'''Weather''' is a per-moon daily modifier shown next to each destination in the terminal's moon list. It changes surface conditions only — interiors are unaffected — but because hauling happens on the surface, weather decides how expensive every ship-to-entrance round trip is, and therefore which moons a high-quota crew will route to on a given day.<ref name="lethalwiki">Weather effects cross-checked against the community-maintained [https://lethal.wiki Lethal Company Wiki].</ref>

== Weather types ==
{| class="wikitable"
! Weather !! Surface effect !! Spawn pressure !! HQ verdict
|-
| ''(none)'' || Baseline conditions. || Baseline. || Always accepted.
|-
| Rainy || Quicksand pits form on walk paths; they kill players who sink. || Baseline.{{Verify|rainy spawn changes}} || Accepted; learn the pit spots and walk around.
|-
| Foggy || Heavy fog cuts surface visibility to a few meters. || Baseline. || Accepted; hauling is by memorized routes anyway.
|-
| Flooded || Water level rises through the day, drowning low ground and slowing movement. || Baseline. || Accepted early, dangerous late — finish hauls before the afternoon.{{Verify|flood timing}}
|-
| Stormy || Lightning strikes metal objects and conductive items (see below). || Baseline. || Accepted with conductive-item discipline; kills careless runners.
|-
| Eclipsed || Permanent darkness; outdoor entities are active from landing. || Heavily increased outdoor spawning from the start of the day.{{Verify|eclipsed spawn mechanics}} || Usually rerouted; accepted only by confident crews on high-value days.
|}

== Stormy and conductive items ==
On a Stormy moon, lightning targets '''conductive''' (metal) items. A held or carried conductive item builds a strike over several seconds — the item glows and static crackles — then lightning hits its position.{{Verify|warning cue details}} The rules that keep runners alive:

* Drop the item the moment it starts sparking, step away, pick it up after the strike.
* Metal scrap (keys, [[Cash register|cash registers]], engine parts) and metal tools — the [[Zap gun]], shovels, [[Jetpack|jetpacks]] — are conductive; a struck jetpack explodes, so jetpacks stay home on Stormy days.{{Verify|full conductive list}}
* Stage conductive scrap just inside the facility door and ferry it in short, spaced trips at day's end.

== Eclipsed ==
Eclipsed replaces the daytime safety window entirely: [[Eyeless Dog|Eyeless Dogs]], [[Old Bird|Old Birds]], and other night threats can be active at landing. Crews that do fight it treat the surface like a night run from minute one — [[Teleporters|teleporter]] extraction instead of walking, and a dedicated ship watcher. For most rotations the correct play is simply to route to a different moon that day; see [[High quota routing]].

== Weather in routing ==
Weather rerolls each day, so a bad forecast on the target moon is a scheduling problem, not a run-ender. Standard priorities: take clear/Foggy/Rainy days on the main farming moon, tolerate Stormy with discipline, spend Eclipsed days on gear-buying, [[Experimentation]] credit days, or [[Selling at the Company|selling]].{{Verify|community weather priority consensus}}

== References ==
{{Reflist}}

[[Category:Mechanics]]`,
  ),
  article(
    "Selling at the Company",
    `{{Infobox_mechanic
| name = Selling at the Company
| introduced = Initial Early Access release
| formula = payout = scrapValue &times; buyingRate
| related = [[Quota]], [[Overtime bonus]], [[The Company (71-Gordion)]]
}}
'''Selling at the Company''' converts hauled scrap into quota progress and [[Credits|credits]] at the desk on [[The Company (71-Gordion)]]. The Company buys at a '''rate that depends on how many deadline days remain''' — full price only on deadline day itself — which single-handedly dictates the rhythm of every high-quota run: farm for the whole cycle, sell once, sell late.<ref name="lethalwiki">Buying rates and desk behavior cross-checked against the community-maintained [https://lethal.wiki Lethal Company Wiki].</ref>

== Buying rate by days left ==
{| class="wikitable"
! Days left !! Buying rate !! 1000 scrap sells for
|-
| 3 || 30%{{Verify|intermediate buying rates}} || 300
|-
| 2 || 53%{{Verify|intermediate buying rates}} || 530
|-
| 1 || 77%{{Verify|intermediate buying rates}} || 770
|-
| 0 (deadline day) || '''100%''' || '''1000'''
|}

The rate applies to the scrap's map value — the number the scanner shows. Selling three days early therefore burns '''70%''' of everything on the desk. The only structural exception is a run that is about to wipe or a quota that cannot otherwise be met; see [[Quota]] for the deadline math.

== Desk mechanics ==
Items are sold by placing them '''on the desk counter''' and ringing the bell; a batch is bought when the counter is serviced, and the terminal confirms the total. Practical rules:

* Only items physically on the counter sell — items dropped on the floor beside it do not count.{{Verify|counter hitbox strictness}}
* The desk services a limited batch at a time; large hoards go up in several bell rings.{{Verify|per-batch item limit}}
* Something lives behind the desk. Lingering at the counter, spam-ringing the bell, or standing on the desk after ringing provokes it — it kills with a tentacle grab. Place, ring once, step back.{{Verify|exact provocation conditions}}
* The Company moon has no interior to loot and no quota timer pause; a sell trip still consumes a full day, which is exactly why it is folded into deadline day.

== Late-sell discipline ==
The whole cycle is built backward from the 100% day:

* Days 3–1: farm ([[High quota routing]]), store every item on the ship, sell '''nothing'''.
* Deadline day: route to the Company, transfer the entire hoard to the counter, fulfill the quota, and bank the [[Overtime bonus|overtime]] from the surplus.
* Keep one or two low-value items aboard as an emergency buffer against a short next cycle.{{Verify|buffer practice consensus}}

The seeded terminal shorthand ''The Company'' redirects here; the moon itself — layout, bell, catwalk — is covered at [[The Company (71-Gordion)]].

== References ==
{{Reflist}}

[[Category:Mechanics]]
[[Category:High quota]]`,
  ),
  article(
    "High quota routing",
    `'''High quota routing''' is the discipline of choosing which moon to fly each day of a deadline cycle so that scrap income stays ahead of the [[Quota|quota curve]] for as long as possible. A route is a plan for all three days of the cycle at once — moon order, gear purchases, and the deadline-day sell trip — not a per-day improvisation.<ref name="lethalwiki">Moon data underlying these bands from the community-maintained [https://lethal.wiki Lethal Company Wiki].</ref>

== Moon rotation by quota band ==
{| class="wikitable"
! Quota band !! Primary moon !! Role in the run
|-
| First quotas (&le; ~500){{Verify|band boundaries}} || [[Experimentation]] || Free route. Every credit saved is gear: [[Teleporters|teleporter]], then inverse teleporter, then utility. Quota is trivially met while the kit is assembled.
|-
| Mid game (~500–2000){{Verify|band boundaries}} || [[Titan]] || The core grind. Shortest ship-to-door commute converts the rising [[Scrap value multiplier]] into hauled credits; [[Rend]] and [[Dine]] substitute on bad Titan weather.
|-
| End game (2000+) || [[Artifice]] || Highest-value table in the game. [[Old Bird]] surface play is the price of admission; from here the route only leaves for the sell trip.
|-
| Deadline day || [[The Company (71-Gordion)]] || Sell the entire hoard at 100% ([[Selling at the Company]]) and bank the [[Overtime bonus|overtime]].
|}

== Day structure and ship-leave timing ==
A farming day has three phases: the morning push (land, open the facility, establish the scrap chain), the midday ferry (continuous hauls, ship inventory growing), and the evening cut. The cut is the routing decision that kills crews: interior spawn pressure keeps rising with the clock, and outdoor night entities activate around dusk. Standard discipline is to '''name the leave time at landing''' — commonly around 9–10 PM on the in-game clock{{Verify|community standard leave time}} — and honor it even mid-haul. The last act before leaving on a suitable day is the apparatus pull ([[Apparatus pulls]]); the ship lifts off as the blackout team boards.

== Role assignments ==
{| class="wikitable"
! Role !! Job
|-
| Ship watcher || Monitor and doors: calls entity positions, [[Jester]] wind-ups, and the leave time; operates the [[Teleporters|teleporter]] to extract downed or trapped runners.
|-
| Runners (2+) || Continuous loot chain from facility to a drop pile; never loot solo past the first [[Bracken]] sighting.
|-
| Inverse operator / deep runner || On inverse-equipped crews, dives to the far interior and feeds loot toward the main chain.
|}

Three players is the minimum for the watcher–runner split; four unlocks the deep-runner pattern that [[One-day quota]] clears are built on.

== Day-count economics ==
The run's real currency is '''days'''. Every quota consumes at most three, and one of them is the sell trip, so a cycle nets two farming days — or one, when travel or weather forces a reroute. The routing goal is therefore not "survive the day" but "never spend a day that banks nothing": a rerouted [[Weather|Eclipsed]] day becomes a gear-buy or [[Experimentation]] day, never a zero. Crews chasing records compress further and fill the whole quota in a single day ([[One-day quota]]), selling with two days of overtime term to spare.

== References ==
{{Reflist}}

[[Category:Strategies]]
[[Category:High quota]]`,
  ),
  article(
    "One-day quota",
    `A '''one-day quota''' is filling an entire [[Quota|profit quota]] — often several times over — in a single moon-day. It is the core compression technique of record-pace high-quota play: a quota cleared in one day leaves the rest of the cycle for pure surplus farming, and every surplus credit becomes [[Overtime bonus|overtime]] on deadline day.<ref name="lethalwiki">Moon values and equipment data from the community-maintained [https://lethal.wiki Lethal Company Wiki].</ref>

== Prerequisites ==
* '''Ship teleporter and inverse teleporter''' ([[Teleporters]]). The inverse deletes the walk-in; the regular teleporter deletes the walk-out for whoever is holding nothing. Without both, ferry time caps the day far below one-day pace.
* '''A workable moon and forecast.''' [[Artifice]] is the standard stage; [[Titan]] is the practice stage and the fallback when Artifice is banned by ruleset. Clear or Foggy [[Weather|weather]] preferred; Eclipsed attempts are stunt territory.
* '''Team of 3–4''' with fixed roles ([[High quota routing]]): ship watcher on the monitor full-time, runners on the surface chain, a deep runner on the inverse.
* '''Quota low enough to clear.''' The technique matters most in the mid bands; at extreme quotas even a perfect day may only part-fill, which still pays via overtime.

== Loadout ==
{| class="wikitable"
! Slot !! Item !! Why
|-
| Ship || Both teleporters, fully manned monitor || The entire tempo of the day.
|-
| Runners || Flashlight, [[Zap gun]] or stun grenade{{Verify|standard runner kit}} || Unstick teammates from [[Bracken]]/[[Coil-Head]] holds without fighting.
|-
| Deep runner || Empty inventory on the dive || Four slots of scrap per inverse cycle is the whole point.
|-
| Optional || [[Jetpack]] || Surface shortcuts on [[Artifice]]; skip on Stormy ([[Weather]]).
|}

== Execution ==
The day is one repeating loop. The deep runner inverse-drops into the interior, fills four slots, and moves toward the entrance; runners relay the pile to the ship while the watcher calls threats and [[Jester]] wind-ups. On a wind-up the whole interior team dips, resets, re-enters. The evening ends like any other farming day: an [[Apparatus pulls|apparatus pull]] on the way out, then lift-off at the called leave time.

== Benchmarks ==
Rough community reference points for a clean day:{{Verify|all benchmark figures}}

{| class="wikitable"
! Stage !! Haul (scrap value) !! Meaning
|-
| [[Titan]], 3 players || ~1500–2000 || Solid one-day pace; clears mid-band quotas outright.
|-
| [[Artifice]], 4 players || ~3000–4000+ || Standard record pace; multiple quotas of value in one day.
|}

Falling short is not failure — whatever was hauled still sells at 100% on deadline day and converts to overtime. The technique's real risk is the wipe that loses the ship's hoard, which is why the leave-time discipline from [[High quota routing]] applies doubly here.

== References ==
{{Reflist}}

[[Category:Strategies]]
[[Category:High quota]]`,
  ),
  article(
    "Apparatus pulls",
    `An '''apparatus pull''' is the deliberate, scheduled extraction of the facility's [[Apparatus]] at the end of a farming day. The item is a guaranteed '''80 credits''' every day on every moon, but pulling it blacks out the facility — so high-quota crews treat the pull as a closing ritual with its own timing, routing, and role assignment rather than an opportunistic grab.<ref name="lethalwiki">Apparatus behavior cross-checked against the community-maintained [https://lethal.wiki Lethal Company Wiki].</ref>

== What pulling does ==
The apparatus sits in a socket in its own room, powering the facility. Unplugging it immediately:

* kills the interior lights — the whole facility goes dark until the day ends;
* disables powered hazards: turrets and landmines shut off with the grid{{Verify|turret and landmine shutdown on pull}};
* opens or unlocks the facility's powered big doors{{Verify|big door behavior on pull}};
* is widely believed to raise interior spawn pressure for the rest of the day.{{Verify|spawn pressure increase}}

The blackout is permanent for the day. Nothing restores facility power, which is the entire reason the pull is scheduled last.

== Timing ==
The pull happens '''after the day's looting is finished and the ship is nearly loaded''' — ideally within the last few in-game hours before the crew's named leave time ([[High quota routing]]). Pulling early trades the rest of the day's looting for one 80-credit item, the worst exchange in the game.

{| class="wikitable"
! Situation !! Pull decision
|-
| Normal farming day || Pull last, just before the named leave time; ship loaded, team outside.
|-
| Turret-blocked wing still unlooted || Early pull is defensible: the blackout shuts the turrets down and opens the wing.{{Verify|turret shutdown tactic}}
|-
| [[Jester]] popped, interior abandoned || Pull on the way out — the looting the blackout costs is already lost.
|-
| Deadline-day sell trip || No pull; [[The Company (71-Gordion)]] has no facility, and the day is spent at the desk.
|}

== Blackout routing ==
The puller's escape is planned '''before''' touching the socket:

* Walk the exit route once with lights on; count doors and turns. The route is run from memory, not sight.
* Prefer the exit nearest the apparatus room — on [[Titan]] the fire-exit catwalk drop is the classic blackout escape.{{Verify|catwalk route from apparatus room}}
* A teammate at the [[Teleporters|teleporter]] is the safety net: if the puller is grabbed or lost in the dark, they are teleported out, dropping the apparatus — retrievable by the next dive.
* Everyone else is '''already outside''' at pull time. A dark facility with [[Coil-Head|Coil-Heads]] active is no place for stragglers.

== Who pulls ==
The pull goes to the crew's most route-confident runner — by convention the deep runner, who knows the interior best by day's end. The ship watcher calls the pull ("appy out, lights going") so the surface team expects the dark facility and holds the ship at the door. On [[Artifice]] and other [[Old Bird]] moons the watcher also confirms the surface is clear before the puller exits, since the escape ends with a run to the ship in the open.

The item itself — fixed value, weight, socket respawn behavior — is covered at [[Apparatus]].

== References ==
{{Reflist}}

[[Category:Strategies]]
[[Category:High quota]]`,
  ),
];
