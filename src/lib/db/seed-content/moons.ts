import { slugifyTitle } from "@/lib/title";

import type { SeedArticle } from "../seed-data";

/**
 * Seed batch: remaining moon articles (seed-content-plan.md §1 "Moons").
 * Titles follow decisions O9 (bare canonical names; the number-prefixed forms
 * are seeded as redirects in seed-data.ts). Slugs are always
 * `slugifyTitle(title)` (O1). Structure mirrors the §3 Titan exemplar.
 *
 * Filing is wikitext-native (decisions-v2 O13): every article below ends in
 * `[[Category:Moons]]` plus its tier category — there is no nav bucket.
 */
function moon(title: string, wikitext: string): SeedArticle {
  return { title, slug: slugifyTitle(title), wikitext, translations: [] };
}

export const MOON_ARTICLES: readonly SeedArticle[] = [
  moon(
    "Artifice",
    `{{Infobox_moon
| name = 68-Artifice
| cost = 1500
| tier = 3
| risk = S++
| layout_size = Very large
| map_multiplier = 3.05{{Verify|map size multiplier}}
| min_scrap = 26{{Verify|scrap count range}}
| max_scrap = 31{{Verify|scrap count range}}
| weather = None, Foggy, Rainy, Stormy, Eclipsed{{Verify|weather pool}}
| interior = Factory, Mineshaft, Mansion{{Verify|interior weights}}
| indoor_power = 13{{Verify|indoor power cap}}
| outdoor_power = 13{{Verify|outdoor power cap}}
}}
'''68-Artifice''' is the highest-value moon in the game and the centerpiece of modern high-quota play. At '''1500 credits''' it is the most expensive route on the catalogue, and every serious route plan is built around paying that toll as early and as often as possible: no other moon matches its combination of scrap count, average scrap value, and haul-friendly surface.<ref name="lethalwiki">Moon data cross-checked against the community-maintained [https://lethal.wiki Lethal Company Wiki].</ref>

== Overview ==
Artifice was added to the game in the v45 update era{{Verify|exact patch that added Artifice}} as a ''hidden'' moon: it does not appear in the terminal catalogue on a fresh save, and the community's original discovery route ran through the cottage area on [[Adamance]], where the moon's name is hinted.{{Verify|unlock flow and hint location}} Once routed, it behaves like any other paid moon and stays routable for the rest of the save.

The surface is dominated by a large '''warehouse''' complex. The ship lands a short, flat walk away from it, and the '''main entrance''' sits inside the warehouse — an unusually sheltered commute, which is exactly what makes ferrying two dozen items per day realistic here.

== Old Birds and the surface ==
Artifice is the signature home of the [[Old Bird]]. Several can be active on the surface at once{{Verify|typical and maximum Old Bird counts}}, and they aggro on sight, sound, and light. Standard high-quota surface play:

* Runners hug the warehouse walls and kill flashlights outdoors; the warehouse interior itself blocks line of sight.
* One player baits patrolling Old Birds away from the ship lane before the heavy ferrying phase starts.
* A ship-camping Old Bird is the classic Artifice run-ender — counter it with [[Teleporters|inverse teleporter]] insertions and by keeping the ship doors shut between trips.
* An ''Eclipsed'' Artifice (see [[Weather]]) starts Old Birds early and is usually rerouted rather than fought.{{Verify|community consensus on Eclipsed Artifice}}

== Layout and routing ==
* '''Main route''': ship &rarr; warehouse &rarr; main entrance, with almost no exposed ground.
* '''Fire exit''': located to the right of the main entrance area{{Verify|fire exit placement}}, close enough that main-and-fire loops are practical for splitting the team across both doors.
* The map multiplier is the largest in the game{{Verify|map size multiplier}}, so deep interiors are long — bring [[Teleporters]] rather than walking bodies and loot out by hand.

== Interior ==
Artifice can roll all three interiors; exact odds shift by patch and should be checked before relying on them.{{Verify|current interior weights}}

{| class="wikitable"
! Interior !! Frequency !! High-quota notes
|-
| '''Mineshaft''' || Common{{Verify|interior weights}} || Added to the rotation in a later update{{Verify|patch that added the Mineshaft interior}}; the elevator is a chokepoint — assign one caller.
|-
| '''Factory''' || Common{{Verify|interior weights}} || Fastest loot-per-minute; standard [[Jester]] dip discipline applies.
|-
| '''Mansion''' || Least common{{Verify|interior weights}} || Highest ceiling per item; watch for [[Nutcracker]] shotgun pickups.
|}

== High quota play ==
Artifice defines the modern pace of high quota: its scrap table is rich enough that a coordinated crew can fill entire quota bands from a single day, making it the default anchor of [[High quota routing]] and the standard stage for [[One-day quota]] attempts. The rising [[Scrap value multiplier]] compounds its advantage — the more quotas you clear, the more each Artifice day is worth relative to [[Titan]]. The 1500-credit route cost is the only real argument against it, which is why early quotas are often farmed on [[Experimentation]] or [[Titan]] until the bank covers back-to-back Artifice days.

== Version notes ==
{{Version|version=v45 era|note=Artifice entered the game as a hidden moon in the v45 update era and quickly displaced [[Titan]] as the endgame farming standard.{{Verify|exact patch and rollout details}}}}

== References ==
{{Reflist}}

[[Category:Moons]]
[[Category:Tier 3 moons]]`,
  ),
  moon(
    "Rend",
    `{{Infobox_moon
| name = 85-Rend
| cost = 550
| tier = 3
| risk = A{{Verify|risk rating}}
| layout_size = Medium
| map_multiplier = 1.8{{Verify|map size multiplier}}
| min_scrap = 16{{Verify|scrap count range}}
| max_scrap = 20{{Verify|scrap count range}}
| weather = None, Foggy, Stormy, Eclipsed{{Verify|weather pool for snow moons}}
| interior = Mansion (dominant), Factory (rare){{Verify|interior weights}}
| indoor_power = 10{{Verify|indoor power cap}}
| outdoor_power = 6{{Verify|outdoor power cap}}
}}
'''85-Rend''' is a tier-3 snow moon whose identity is a trade: a cheap 550-credit route and a near-guaranteed '''Mansion''' interior, paid for with the longest, darkest surface walk in the rotation. It is the budget member of the classic snow-moon trio alongside [[Dine]] and [[Titan]], and a staple of mid-run quota bands.<ref name="lethalwiki">Moon data cross-checked against the community-maintained [https://lethal.wiki Lethal Company Wiki].</ref>

== The walk ==
The ship lands far from the facility on a dark, blizzard-swept plain. Visibility is short even in clear weather, and the direct line crosses featureless snow where players reliably get lost. The intended route follows the string of '''guide lights''' — small glowing posts staked between the ship and the entrance. High-quota crews treat the walk as a protocol, not a suggestion:

* Follow the lights both ways, every trip; shortcut attempts cost more time than they save the moment someone deviates.
* Outdoor threats are sparse{{Verify|outdoor spawn pool}}, but a [[Weather|Foggy]] or Eclipsed roll on top of the ambient darkness makes the lights the only navigation aid left.
* Drop a spare flashlight at the halfway point as a landmark for the return leg.

== Interior and entities ==
Rend rolls the Mansion interior on the overwhelming majority of days{{Verify|mansion weight}}, which makes its loot table unusually predictable: paintings, gold bars, and other dense valuables that reward a disciplined ferry chain. The indoor pool is the punishing part:

{| class="wikitable"
! Entity !! Threat profile
|-
| [[Jester]] || Spawns here at high weight; the day's clock, exactly as on [[Titan]].
|-
| [[Nutcracker]] || Mansion hallways favor its sightlines — but each kill is a free shotgun.
|-
| [[Bracken]] || Long corridors and single-runner wings are its ideal hunting ground.
|-
| [[Ghost Girl]] || Low probability, run-ending when she picks the wrong player.{{Verify|spawn chance}}
|}

== When Rend beats Dine ==
{| class="wikitable"
! Factor !! Rend !! [[Dine]]
|-
| Route cost || '''550''' || 600
|-
| Interior || Mansion, near-guaranteed{{Verify|interior weights}} || Mixed rolls{{Verify|interior weights}}
|-
| Commute || Long guided walk || Shorter, fire-exit-first
|-
| Scrap count || Lower{{Verify|scrap ranges}} || Higher{{Verify|scrap ranges}}
|}

Pick Rend when the crew wants ''predictability'': a known interior, a known loot profile, and a cheaper route on quota bands where 50 credits matter. Pick Dine when raw scrap count is the bottleneck. On deadline days, Rend's long walk argues for leaving early — count the return leg in your ship-leave timing (see [[High quota routing]]).

== Version notes ==
{{Version|version=v45+|note=Rend's route cost and mansion-dominant interior have been stable across recent patches.{{Verify|cost and interior stability}}}}

== References ==
{{Reflist}}

[[Category:Moons]]
[[Category:Tier 3 moons]]`,
  ),
  moon(
    "Dine",
    `{{Infobox_moon
| name = 7-Dine
| cost = 600
| tier = 3
| risk = S{{Verify|risk rating}}
| layout_size = Large
| map_multiplier = 1.8{{Verify|map size multiplier}}
| min_scrap = 22{{Verify|scrap count range}}
| max_scrap = 25{{Verify|scrap count range}}
| weather = None, Foggy, Stormy, Eclipsed{{Verify|weather pool for snow moons}}
| interior = Mansion (common), Factory{{Verify|interior weights}}
| indoor_power = 15{{Verify|indoor power cap}}
| outdoor_power = 6{{Verify|outdoor power cap}}
}}
'''7-Dine''' is a tier-3 snow moon positioned between [[Rend]] and [[Titan]]: more scrap than Rend, a shorter effective commute, and a 600-credit route that mid-run quota bands can pay every day. Its defining habit in high-quota play is '''fire-exit-first routing''' — the fire exit, not the main entrance, is the door the day is built around.<ref name="lethalwiki">Moon data cross-checked against the community-maintained [https://lethal.wiki Lethal Company Wiki].</ref>

== Surface and routing ==
The ship lands on an icy shelf. The main entrance is a long, exposed walk around the terrain; the '''fire exit''' sits much closer to the ship, up a short climb.{{Verify|exact door positions}} The standard loop:

* '''Entry''': the team enters through the fire exit and pushes toward the main-entrance side of the interior.
* '''Door opening''': the first runner to reach the main entrance opens it from inside, converting it into a second haul door for the rest of the day.
* '''Hauling''': loot flows out of whichever door is closer; the fire-exit side stays the evacuation route, since it is the short leg back to the ship.

The climb to the fire exit is the route's weak point — a dropped two-handed item can slide back down, and in [[Weather|Stormy]] weather the exposed approach is where conductive items get people killed.

== Interior ==
Dine leans Mansion but rolls Factory a meaningful fraction of days{{Verify|interior weights}}, so unlike [[Rend]] you scout the first room before committing to a loot plan. Scrap count is the draw: 22&ndash;25 items{{Verify|scrap count range}} approaches [[Titan]] volume at a cheaper route price.

{| class="wikitable"
! Roll !! Plan
|-
| '''Mansion''' || Treat as a richer Rend: ferry chains through the main hall, [[Nutcracker]] and [[Jester]] discipline.
|-
| '''Factory''' || Faster loops, more traps; standard [[Bracken]] corner-checking while looting fast.
|}

== High quota play ==
Dine is the standard '''mid-tier alternative''': crews route it when [[Artifice]] is not yet affordable, banned by ruleset, or weather-blocked, and when Rend's lower scrap count will not fill the band. Its indoor power cap runs high{{Verify|indoor power cap}}, so late-day spawn pressure resembles Titan — plan dips around the [[Jester]] and pull the [[Apparatus]] on the way out (see [[Apparatus pulls]]). An Eclipsed Dine is normally rerouted; the snow-moon commute is too long to fight through surface spawns.{{Verify|community consensus on Eclipsed Dine}}

== Version notes ==
{{Version|version=v45+|note=Dine's route cost and scrap profile have been stable across recent patches.{{Verify|cost and scrap stability}}}}

== References ==
{{Reflist}}

[[Category:Moons]]
[[Category:Tier 3 moons]]`,
  ),
  moon(
    "Experimentation",
    `{{Infobox_moon
| name = 41-Experimentation
| cost = 0
| tier = 1
| risk = B{{Verify|risk rating}}
| layout_size = Small
| map_multiplier = 1.0{{Verify|map size multiplier}}
| min_scrap = 8{{Verify|scrap count range}}
| max_scrap = 11{{Verify|scrap count range}}
| weather = None, Rainy, Foggy, Stormy, Flooded, Eclipsed{{Verify|weather pool}}
| interior = Factory (dominant){{Verify|interior weights}}
| indoor_power = 4{{Verify|indoor power cap}}
| outdoor_power = 8{{Verify|outdoor power cap}}
}}
'''41-Experimentation''' is the free tier-1 starter moon and the traditional opening board of a high-quota run. Its scrap table is shallow, but the route costs nothing, the interior is small, and the entity pressure is low — which makes it the place where early quotas are filled while credits are banked for gear and, eventually, the jump to [[Titan]] and [[Artifice]].<ref name="lethalwiki">Moon data cross-checked against the community-maintained [https://lethal.wiki Lethal Company Wiki].</ref>

== Overview ==
The ship lands opposite a fenced factory compound. The '''main entrance''' is reached by climbing a staircase onto a '''catwalk''' that runs along the building face; the fire exit sits around the back, up a cliffside ladder.{{Verify|fire exit position}} Indoor power is tiny{{Verify|indoor power cap}}, so days here rarely die to spawns — they die to complacency around [[Bracken]] grabs and turret corners.

== The catwalk shortcut ==
The catwalk is the moon's signature time-save. Instead of walking the staircase both ways, runners hop the railing on the way ''out'' and drop straight toward the ship side, cutting each haul loop by several seconds.{{Verify|drop is damage-free at all landing points}} Over a full farming day of a dozen round trips, the shortcut adds up to a free extra trip. The drop is one-way — returning still uses the stairs — so haul batching (carrying out once per couple of rooms cleared) beats item-by-item ferrying here.

== Early-run credit farming ==
The standard opening pattern alternates farming and selling around the first deadlines:

{| class="wikitable"
! Day !! Plan
|-
| 1&ndash;2 || Full-clear Experimentation; every inventory slot filled, [[Apparatus]] pulled at day end.
|-
| 3 || Sell at [[The Company (71-Gordion)|the Company]] on deadline day for the 100% rate (see [[Selling at the Company]]).
|-
| Gear day || Spend banked credits before quota scaling makes tier-1 farming obsolete.
|}

A typical first gear buy: '''walkie-talkies''' (12 credits each), a '''shovel''' (30), and '''pro-flashlights''' (25) — the minimum kit for coordinated tier-3 play.{{Verify|current store prices}} Crews aiming at record pace skip comfort items entirely and bank toward [[Teleporters]].

== High quota play ==
Past the opening quotas, Experimentation's 8&ndash;11 scrap items{{Verify|scrap count range}} cannot fill a band, and the moon leaves the rotation. It returns in two niches: a free '''gear-buy day''' destination when the crew needs a cheap landing to shop and reset the day counter, and a weather dodge when every paid moon rolled badly (see [[Weather]] and [[High quota routing]]).

== References ==
{{Reflist}}

[[Category:Moons]]
[[Category:Tier 1 moons]]`,
  ),
  moon(
    "Embrion",
    `{{Infobox_moon
| name = 5-Embrion
| cost = 150
| tier = 3
| risk = S+{{Verify|risk rating}}
| layout_size = Small
| map_multiplier = 1.1{{Verify|map size multiplier}}
| min_scrap = 2{{Verify|scrap count range}}
| max_scrap = 6{{Verify|scrap count range}}
| weather = None, Foggy, Stormy, Eclipsed{{Verify|weather pool}}
| interior = Factory (dominant){{Verify|interior weights}}
| indoor_power = 8{{Verify|indoor power cap}}
| outdoor_power = 12{{Verify|outdoor power cap}}
}}
'''5-Embrion''' is a radioactive wasteland moon added in the wave of hidden moons{{Verify|exact patch that added Embrion}} and the strangest entry in the tier-3 roster: a 150-credit route with a scrap table so thin that looting it normally wastes a day. In high-quota play it is a ''specialist'' destination, not a farming moon.<ref name="lethalwiki">Moon data cross-checked against the community-maintained [https://lethal.wiki Lethal Company Wiki].</ref>

== Overview ==
The surface is a dust-choked plain under a radiation haze, scattered with wrecked machinery. Outdoor spawn pressure is high for such a small map{{Verify|outdoor power and pool}}, and the ambient visuals make entity silhouettes hard to read at range. Inside, the interior rolls Factory almost every day{{Verify|interior weights}} with hostile trap density — turrets and mines punch above the moon's size.{{Verify|trap density claim}}

== Why anyone routes it ==
Embrion's value is concentrated in fixed-value pulls rather than its loot table:

{| class="wikitable"
! Day plan !! Verdict
|-
| Full loot clear || Poor — 2&ndash;6 items{{Verify|scrap count range}} cannot justify a tier-3 day.
|-
| '''Apparatus run''' || The play. Land, sprint the [[Apparatus]] (fixed 80 credits), leave — a cheap top-up when a quota is short by one pull (see [[Apparatus pulls]]).
|-
| Weather dodge || Serviceable — the 150-credit route is the cheapest tier-3 landing when better moons rolled Eclipsed (see [[Weather]]).
|}

Community shorthand calls Embrion ''apparatus-heavy'': the machine room features prominently in its layouts, and the pull is the whole economic point of the visit.{{Verify|apparatus prominence claim}}

== Running the apparatus play ==
* Send exactly two runners in: one puller, one escort with a light and a [[Zap gun|zap gun]] or stun for the blackout scramble.
* Pulling the apparatus kills the lights and powered doors — the pair should already be facing their exit route when the pull happens.
* Everyone else stays shipside; Embrion's surface pool punishes idling in the open.{{Verify|outdoor pool details}}
* Total time on the ground should be minutes. If the crew is looting Embrion at length, the route plan upstream has already failed.

== High quota play ==
In [[High quota routing]] terms Embrion is a tool for two edge cases: topping up a nearly-filled quota with a guaranteed 80-credit pull on deadline day, and burning a day cheaply when weather blocks [[Artifice]], [[Titan]], [[Rend]] and [[Dine]] at once. Crews chasing records otherwise never land here.

== References ==
{{Reflist}}

[[Category:Moons]]
[[Category:Tier 3 moons]]`,
  ),
  moon(
    "The Company (71-Gordion)",
    `{{Infobox_moon
| name = The Company (71-Gordion)
| cost = 0
| risk = Safe{{Verify|risk designation}}
| layout_size = Selling floor only
| weather = None{{Verify|weather immunity}}
}}
'''The Company building''' on '''71-Gordion''' is the selling floor: the only place scrap converts to credits. There is no facility to loot and nothing spawns on the surface{{Verify|no-spawn claim}} — the entire moon exists for the transaction at the desk, and high-quota runs live or die by how cleanly they execute it on deadline day.<ref name="lethalwiki">Behavior cross-checked against the community-maintained [https://lethal.wiki Lethal Company Wiki].</ref>

== The desk ==
The counter is a wide shuttered desk with a service '''bell'''. Something lives behind it. The sell flow: place items fully on the counter, ring the bell once, step back, and wait for the shutter to lift and the payout to register. The rates the desk pays by days-to-deadline belong to [[Selling at the Company]] and [[Quota]]; this page covers the floor itself.

The desk creature tolerates polite service and punishes everything else. Provocations — lingering against the counter after ringing, spamming the bell, loitering while the shutter is open — escalate it until tentacles drag players over the counter.{{Verify|exact provocation triggers and thresholds}}

{| class="wikitable"
! Action !! Desk response
|-
| Place items, one firm ring, step back || Normal service; payout follows.
|-
| Repeated rapid rings || Escalating agitation.{{Verify|agitation model}}
|-
| Standing at the counter while it opens || Risk of a tentacle grab.{{Verify|grab conditions}}
|-
| Touching the counter during service || Treated as loitering; back off.{{Verify|loiter detection}}
|}

== Counter placement ==
* The counter accepts a limited batch — commonly cited as '''12 items''' per ring{{Verify|counter item limit}} — so large hauls sell in waves.
* An item must rest ''on'' the counter to count; items thrown from range can bounce or clip and vanish under the floor. Walk up and place.
* Sell high-value items in the first wave. If a wave is interrupted, the cheap tail is the part left unsold.
* Two-handed items go on last, so their carriers are free to ferry during the wait.

== Deadline-day flow ==
The standard high-quota pattern: arrive with the full run bank on the deadline, ferry everything from the ship to the floor in one organized chain, then sell in waves — ring, collect, reload. Fulfilling the quota with days technically remaining feeds the [[Overtime bonus]], so crews time the final sale against the clock rather than selling the moment they land.{{Verify|overtime interaction with sale timing}} Landing at Gordion is free, and the ship can leave the same day for the next quota's first moon (see [[High quota routing]]).

== References ==
{{Reflist}}

[[Category:Moons]]
[[Category:The Company]]`,
  ),
];
