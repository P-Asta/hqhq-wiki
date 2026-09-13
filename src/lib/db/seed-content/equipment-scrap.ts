import { slugifyTitle } from "@/lib/title";

import type { SeedArticle } from "../seed-data";

/**
 * Seed batch: equipment + scrap articles (seed-content-plan.md §1
 * "Equipment"/"Scrap"). Slugs follow decisions O1 (slug = slugifyTitle(title));
 * titles follow the §1 inventory with the O9 renames applied. Numbers that
 * could not be stated with high confidence carry {{Verify}} per the plan's
 * data honesty rule.
 *
 * Filing is wikitext-native (decisions-v2 O13): every article carries its
 * `[[Category:Equipment]]` / `[[Category:Scrap]]` tag — no nav bucket.
 */

function article(title: string, wikitext: string): SeedArticle {
  return { title, slug: slugifyTitle(title), wikitext, translations: [] };
}

export const EQUIPMENT_SCRAP_ARTICLES: readonly SeedArticle[] = [
  article(
    "Jetpack",
    `{{Infobox_item
| name = Jetpack
| type = Equipment
| price = 700
| conductive = yes
| two_handed = yes
| battery = Yes &mdash; drains only while thrusting{{Verify|full-charge flight time}}
}}
The '''Jetpack''' is a 700-credit mobility tool and the most expensive item in the store. It exists for exactly one reason in high-quota play: it deletes the surface commute. A pilot who knows a moon's flight lines turns a ninety-second walk into a five-second hop, and over a full day on [[Artifice]] or [[Titan]] that difference is measured in whole extra hauls.<ref name="lethalwiki">Item data cross-checked against the community-maintained [https://lethal.wiki Lethal Company Wiki].</ref>

== Overview ==
The Jetpack is '''two-handed''': while flying you hold the pack's controls and cannot carry another two-handed item, so pilots ferry one-handed scrap such as [[Gold bar|gold bars]] and leave the [[Cash register]] to walkers or the [[Company Cruiser]]. Everything else in your inventory still counts toward carry weight, and weight directly blunts thrust &mdash; a loaded pilot climbs noticeably slower.{{Verify|weight effect on thrust}} Thrust is a held input; releasing it leaves you ballistic, and most of the skill is short pulses rather than continuous burns.

== Fuel and battery ==
The pack runs on the standard battery system and drains '''only while thrusting'''. It recharges on the ship's charging dock between trips, so the working rhythm is: fly a line, drop the load, top the charge while calling the next route. A fresh charge comfortably covers several ship-to-entrance round trips on most moons.{{Verify|flight time per charge}} Never start a return line under half charge with a storm rolling in &mdash; the pack is '''conductive''', and holding it in [[Weather|stormy]] weather invites the lightning strike that ends both the pilot and the pack.

== Explosion and death rules ==
* Sustained continuous thrust overheats the pack: it starts shaking and beeping, then '''explodes''', killing the pilot.{{Verify|overheat threshold and warning timing}}
* Hitting terrain or a building at high speed is instant death even with the pack intact &mdash; flare out and land vertically.
* The explosion also destroys the 700-credit pack itself, which is why disciplined crews treat low, pulsed flight as the default and long high burns as an emergency tool.

== Flight lines ==
{| class="wikitable"
! Moon !! Line !! What it saves
|-
| [[Artifice]] || Ship &rarr; main entrance, straight over the compound || The longest walk in the standard rotation; also skips ground-level [[Old Bird]] patrol lanes.{{Verify|Old Bird aggro vs. airborne players}}
|-
| [[Artifice]] || Fire exit &rarr; ship return hop || Ends a haul without re-crossing open ground.
|-
| [[Titan]] || Ship &rarr; catwalk fire exit || Skips the staircase chokepoint in both directions.
|-
| [[Dine]] || Ship &rarr; fire exit ledge || The cliffside fire exit becomes a first-minute entry instead of a detour.
|}

== High quota play ==
Serious crews assign one dedicated pilot. The pilot ferries pre-staged one-handed scrap between the door pile and the ship while walkers keep looting, and pairs naturally with the [[Teleporters|inverse-dive loop]]: divers feed the pile, the pilot empties it. Buy the pack once the [[Quota]] curve makes days scarcer than credits &mdash; on record pace that is early, because a pilot effectively adds daylight. See [[High quota routing]] for where the pilot slots into role assignments.

== References ==
{{Reflist}}

[[Category:Equipment]]`,
  ),
  article(
    "Teleporters",
    `{{Infobox_item
| name = Teleporters
| type = Ship upgrade
| price = 375 (regular) / 425 (inverse){{Verify|inverse teleporter price}}
}}
The ship '''teleporters''' &mdash; the regular '''Teleporter''' and the '''Inverse Teleporter''' &mdash; are one-time ship upgrades operated from buttons on the ship console. Between them they define the tempo of modern high-quota runs: the inverse puts runners deep inside the facility without walking, and the regular one is the safety net that turns would-be wipes into lost seconds.<ref name="lethalwiki">Upgrade data cross-checked against the community-maintained [https://lethal.wiki Lethal Company Wiki].</ref>

== Regular teleporter ==
Pressing the button teleports '''whoever the ship monitor is currently viewing''' back to the teleporter pad. The target '''drops every held item''' on the spot where they were standing &mdash; scrap, keys, and gear all stay behind. The cooldown is short, about '''10 seconds'''.{{Verify|regular cooldown}} Its two canonical jobs:
* '''Saves''': yank a runner out of a popped [[Jester]], a [[Bracken]] grab, or a turret hallway. The loot stays where they stood, and a teammate recovers it on the next rotation.
* '''Body recovery''': teleporting a corpse home avoids the end-of-day penalty and keeps the [[Quota]] math intact.

== Inverse teleporter ==
The inverse pad sends whoever stands on it to a '''random location inside the facility'''. The cooldown is long, about '''210 seconds'''.{{Verify|inverse cooldown}} Item behavior has changed across patches: for much of Early Access the inverse stripped all items on use, and later builds are commonly reported to let divers keep held gear.{{Verify|current-version inverse item rules and the patch that changed them}} Check your patch before committing a loadout to the pad.

{| class="wikitable"
! Device !! Price (credits) !! Cooldown !! Destination !! Held items
|-
| Teleporter || 375 || ~10 s{{Verify|regular cooldown}} || Ship pad || Dropped at the target's feet
|-
| Inverse Teleporter || 425{{Verify|inverse price}} || ~210 s{{Verify|inverse cooldown}} || Random interior point || Version-dependent{{Verify|inverse item rules}}
|}

== The inverse-dive scrap ferry ==
The loop that anchors high-quota days on large interiors:
* A diver takes the inverse in and lands somewhere deep &mdash; usually territory a door-entry sweep would only reach late in the day.
* The diver sweeps '''away from the entrance''', consolidating scrap into piles at the nearest fire exit or a known landmark.
* Surface ferriers (on foot, [[Jetpack]], or [[Company Cruiser]]) empty the piles while the diver keeps working.
* The ship watcher holds the regular teleporter for emergencies; a dead or cornered diver is teleported out, and the run loses a rotation instead of a player.
The 210-second inverse cooldown sets the cadence: one fresh diver roughly every three and a half minutes, which is why crews stagger dives rather than stacking the pad.

== Cooldown discipline ==
Both buttons belong to the ship watcher, not to whoever walks past. The standing rules: never burn the regular teleporter for convenience while a [[Jester]] is winding, always confirm who the monitor is watching before pressing, and stop inverse dives late in the day when the walk out would outlast remaining daylight. See [[High quota routing]] for how teleporter roles fit the wider rotation.

== References ==
{{Reflist}}

[[Category:Equipment]]`,
  ),
  article(
    "Zap gun",
    `{{Infobox_item
| name = Zap gun
| type = Equipment
| price = 400
| battery = Yes &mdash; drains while the beam is held{{Verify|total beam time per charge}}
}}
The '''Zap gun''' is a 400-credit utility tool that projects a lightning tether at a nearby entity. It deals '''no damage''' on its own: its entire job is to hold a monster still while the operator wins a small beam-steering minigame, buying teammates time to escape, loot past, or line up a kill.<ref name="lethalwiki">Item data cross-checked against the community-maintained [https://lethal.wiki Lethal Company Wiki].</ref>

== The beam-steering minigame ==
Firing at a valid target within range locks a beam onto it. The beam then '''drifts''' &mdash; the aim is pulled off the target in a shifting direction, and the operator must steer '''against the pull''' to keep the tether attached. Let the drift win and the beam snaps, releasing the entity instantly. Drift strength varies by entity, with stronger monsters fighting the beam harder.{{Verify|per-entity drift strength}} The practical consequences: plant your feet before firing, and never fire without a plan for the next ten seconds, because the hold ends the moment your aim or battery does.

== What it holds ==
{| class="wikitable"
! Entity !! Held? !! Notes
|-
| [[Bracken]] || Yes || The classic save: freeze it mid-snap while the victim runs.
|-
| [[Nutcracker]] || Yes || Hold it while a teammate melees &mdash; the backbone of safe shotgun farming.
|-
| [[Thumper]] || Yes || Turns a corridor charge into a free retreat.
|-
| [[Hoarding bug]] || Yes || Rarely worth the battery.
|-
| [[Coil-Head]] || Partial{{Verify|coil-head interaction}} || Line-of-sight discipline remains the primary answer.
|-
| [[Jester]] || Brief at best{{Verify|zap gun effectiveness on Jester}} || Use only to unstick a trapped teammate, never to extend looting.
|-
| [[Old Bird]] || No{{Verify|Old Bird immunity}} || Surface threats are out of the tool's weight class.
|}
The hold lasts as long as the operator maintains both the steering and the charge; some entities are commonly reported to break free after a capped duration regardless.{{Verify|per-entity hold caps}}

== Battery discipline ==
The charge drains '''only while the beam is live''', and it drains fast. The rules that keep the gun useful: top it on the ship dock every morning, fire only when the follow-up (an escape route or a killing blow) is already set, and call the hold out loud so teammates act during it instead of watching it. An idle zap gun costs nothing; a wasted hold usually costs a life.

== High quota play ==
The zap gun is a specialist purchase, not a staple. Its two high-value jobs are '''[[Nutcracker]] farming''' &mdash; free shotguns are the cheapest firepower in the game &mdash; and emergency saves during deep sweeps on [[Rend]] and [[Dine]]. It competes for an inventory slot with a shovel and for credits with the [[Teleporters|teleporter]] safety net; most crews buy it after those, if at all. See [[High quota routing]] for loadout priorities by quota band.

== References ==
{{Reflist}}

[[Category:Equipment]]`,
  ),
  article(
    "Company Cruiser",
    `{{Infobox_item
| name = Company Cruiser
| type = Vehicle
| price = 400{{Verify|store price}}
}}
The '''Company Cruiser''' is a drivable utility truck ordered from the store and delivered to the moon's surface beside the ship. It seats a driver and a passenger, carries an open cargo bed, and changes the surface game on big moons: hauling stops being a per-item walk and becomes a single loaded trip.<ref name="lethalwiki">Vehicle data cross-checked against the community-maintained [https://lethal.wiki Lethal Company Wiki].</ref>

<v55+>''Added in v55, the vehicle update.''</v55+>

== Driving and cargo ==
The ignition is deliberately unreliable &mdash; turning the key can take several attempts, so start the engine '''before''' you need to leave, not during the emergency. The open bed accepts scrap and standing players alike; a loaded bed is the fastest way to move a day's haul, including items that punish walkers such as the [[Cash register]]. A stuck Cruiser can be pushed out of terrain by hand, and the horn is a genuinely useful rally signal on moons with long sightlines.

== Ramming ==
Driven with speed, the Cruiser is a weapon. Impacts kill most small and medium surface entities outright &mdash; [[Eyeless Dog|Eyeless Dogs]] and [[Baboon hawk|Baboon Hawks]] are the standard victims &mdash; at the cost of vehicle damage on each hit.{{Verify|which entities survive a ram}} Heavier threats are a different story: trading paint with an [[Old Bird]] is usually a losing exchange unless the crew is deliberately spending the truck (see below).{{Verify|Old Bird ram outcomes}}

== Boost and self-destruct ==
{| class="wikitable"
! Quirk !! Behavior
|-
| Turbo boost || A limited boost gives a burst of acceleration; charges are finite, so save them for escapes.{{Verify|how turbo charges are gained}}
|-
| Critical damage || A heavily damaged Cruiser catches fire and beeps, then '''explodes''', killing anyone aboard or nearby.
|-
| The truck bomb || A burning Cruiser aimed at a surface threat and bailed out of is a legitimate last-resort play against [[Old Bird]] clusters.{{Verify|explosion damage vs. Old Birds}}
|-
| Magnet || With the ship's magnet enabled, the Cruiser clamps to the ship's side and travels with it between moons.
|}

== High quota play ==
The Cruiser earns its keep on '''[[Artifice]]''', where the ship-to-entrance distance is the worst in the rotation and [[Old Bird|Old Birds]] own the open ground: runners stage scrap at the doors, the driver runs loops, and the cab doubles as mobile cover. On compact moons like [[Titan]] it is dead weight &mdash; skip it. Buy once your route commits to Artifice days and the [[Quota]] band makes ferry time the bottleneck; pair it with the [[Teleporters|inverse-dive loop]] so piles are always waiting when the truck arrives. See [[High quota routing]].

== References ==
{{Reflist}}

[[Category:Equipment]]`,
  ),
  article(
    "Apparatus",
    `{{Infobox_item
| name = Apparatus
| type = Scrap
| value_min = 80
| value_max = 80
}}
The '''Apparatus''' (community shorthand: ''appy'') is a fixed-value scrap item socketed into a powered pedestal in its own room of the facility. It always sells for '''80 credits''', and pulling it from its socket '''cuts the facility's power''' &mdash; which is why, unlike every other item, the question with the Apparatus is not ''whether'' to take it but ''when''.<ref name="lethalwiki">Item data cross-checked against the community-maintained [https://lethal.wiki Lethal Company Wiki].</ref>

== Power-off consequences ==
{| class="wikitable"
! System !! After the pull
|-
| Lights || Off facility-wide, for the rest of the day.
|-
| Secure doors || Lose power and open.{{Verify|big-door state after the pull}}
|-
| Turrets || '''Stay armed'''.{{Verify|turret power source}}
|-
| Landmines || '''Stay armed'''.{{Verify|mine power source}}
|}
The blackout is the real price. Every corridor becomes flashlight-only, scanning replaces sight, and entities that were merely dangerous in the light &mdash; a roaming [[Bracken]], a [[Coil-Head]] you can no longer see to freeze &mdash; become dramatically worse. The traps staying live in the dark is what kills careless crews: a known minefield crossed from memory is a coin flip.

== When to pull ==
The standard is a '''last-action pull''': the day's looting is done, everyone else is at or near an exit, and one designated runner yanks the Apparatus and sprints the pre-agreed route out. Pulling early is almost always a mistake &mdash; 80 credits does not buy back an hour of blackout looting. The exceptions are deliberate: a day already cut short by a wound [[Jester]], or a quota-math situation where 80 guaranteed credits closes the [[Quota]] on a deadline day. Team-level timing, routes, and who carries what during the pull live on the dedicated strategy page: [[Apparatus pulls]].

== High quota economics ==
Eighty fixed credits is real money in the first quota bands and rounding error later &mdash; the [[Scrap value multiplier]] inflates everything else while the Apparatus stays flat. High-quota crews still pull it every single day, for two reasons: it is the most consistent item in the game (every facility has one), and the pull costs nothing when executed as the day's final act. On [[Titan]] the short stair run makes the pull trivial; on [[Artifice]] the puller coordinates with the [[Company Cruiser]] or a [[Jetpack]] pilot for the surface leg.

== References ==
{{Reflist}}

[[Category:Scrap]]`,
  ),
  article(
    "Gold bar",
    `{{Infobox_item
| name = Gold bar
| type = Scrap
| value_min = 156
| value_max = 210{{Verify|value range}}
| weight = 77{{Verify|weight}}
| conductive = yes
| two_handed = no
}}
The '''Gold bar''' is the highest value-per-slot scrap item in the game. A single one-handed inventory slot carrying 156&ndash;210 credits{{Verify|value range}} outclasses everything else you can pocket, which makes bars the first-priority extract of any haul they appear in.<ref name="lethalwiki">Item data cross-checked against the community-maintained [https://lethal.wiki Lethal Company Wiki].</ref>

== Value ==
{| class="wikitable"
! Item !! Sell value (credits) !! Hands !! Verdict
|-
| '''Gold bar''' || 156&ndash;210{{Verify|value range}} || One || Best per-slot value in the game; always extract first.
|-
| [[Cash register]] || ~100&ndash;175{{Verify|register value range}} || Two || Similar money, several times the handling cost.
|-
| [[Apparatus]] || 80 (fixed) || Two{{Verify|apparatus handedness}} || Guaranteed, but a special case &mdash; see [[Apparatus pulls]].
|}
The catch is '''weight''': at roughly 77 lb{{Verify|weight}} a bar is one of the heaviest one-handed items in the game, and two bars will grind a runner's sprint to a crawl. It is completely safe to drop &mdash; a bar loses no value however many times it hits the floor &mdash; so relay-carrying is free.

== Where it spawns ==
Gold bars appear on the expensive end of the rotation: '''[[Rend]]''', '''[[Dine]]''', and '''[[Titan]]''', with a commonly reported bias toward '''Mansion''' interiors.{{Verify|spawn moons and mansion bias}} They are effectively absent from starter moons, which is one of the structural reasons [[High quota routing]] moves runs onto tier-3 moons as the [[Quota]] climbs. On [[Artifice]] the general scrap table is rich enough that bars are a bonus rather than the plan.{{Verify|Artifice gold bar spawn odds}}

== Handling ==
* '''Call it''' the moment it is scanned &mdash; the team should know a bar exists before anyone routes home.
* Carry one bar plus light scrap, not two bars; the sprint penalty on a double-carry costs more time than a second trip.{{Verify|stamina penalty scaling with weight}}
* Bars ride first on every ferry: first into the [[Company Cruiser]] bed, first into a [[Jetpack]] pilot's hands, first through the door on a dip.
* It is '''conductive''' &mdash; in [[Weather|stormy]] weather, drop it outside and let the strike land before the final carry.

== High quota play ==
On tier-3 days the bars ''are'' the day: a Mansion roll on [[Dine]] with two bars found early can settle most of an early [[Quota]] on its own, and late-run the [[Scrap value multiplier]] scales bars harder than anything else per slot. The standing rule on record-pace crews: a known gold bar never gets left inside overnight.

== References ==
{{Reflist}}

[[Category:Scrap]]`,
  ),
  article(
    "Cash register",
    `{{Infobox_item
| name = Cash register
| type = Scrap
| value_min = 100{{Verify|value range}}
| value_max = 175{{Verify|value range}}
| weight = 84{{Verify|weight}}
| conductive = yes
| two_handed = yes
}}
The '''Cash register''' is the game's canonical weight-versus-value problem: solid money &mdash; commonly around 150 credits{{Verify|average value}} &mdash; bolted to one of the heaviest bodies in the scrap table. It is '''two-handed''' and roughly 84 lb,{{Verify|weight}} which means the player carrying it is slow, defenseless, and carrying nothing else that matters.<ref name="lethalwiki">Item data cross-checked against the community-maintained [https://lethal.wiki Lethal Company Wiki].</ref>

== Weight economics ==
Value per pound is the worst among high-value scrap: a [[Gold bar]] delivers roughly twice the credits per pound in half the hands.{{Verify|comparative weights}} The register's cost is not just stamina &mdash; a two-handed carry means no flashlight, no shovel, and no reaction to whatever is around the next corner. Price that in before picking it up:

{| class="wikitable"
! Situation !! Take it?
|-
| Found near the main entrance, ship close ([[Titan]]) || Yes &mdash; short carry, real money.
|-
| Deep in the facility, mid-day || Stage it at a door pile; decide at end of day.
|-
| [[Jester]] wound or winding || '''No.''' Nothing this heavy is worth a dip gone wrong.
|-
| [[Company Cruiser]] on the surface ([[Artifice]]) || Yes &mdash; the bed makes the surface leg free.
|-
| Solo crew, long surface walk || Almost never; the time is worth more as looting.
|}

== When hauling is worth it ==
The register is an '''end-of-day item'''. The standard play is to stage it: drag it to the main entrance or fire exit when found, then make the final call with full information &mdash; remaining daylight, entity pressure, and how close the [[Quota]] is. On deadline days it earns extraction more often, because guaranteed credits at the 100% [[Selling at the Company|selling rate]] beat a speculative extra loop. In [[Weather|stormy]] weather remember it is conductive: stage it outside early and let the lightning discharge before the ship carry.

== High quota play ==
Vehicle access flips the verdict. With a [[Company Cruiser]] running loops on [[Artifice]], registers are simply money and go in the bed with everything else. Without one, they are the last item ranked in [[High quota routing]] extraction priority: gold bars first, then dense mid-value scrap, then &mdash; if the day is safe and the walk is short &mdash; the register. [[Teleporters|Inverse divers]] should never sweep one deep into their route, and a [[Jetpack]] pilot cannot fly one at all (both are two-handed). A register left inside is not a failure; it is a decision the numbers usually agree with.

== References ==
{{Reflist}}

[[Category:Scrap]]`,
  ),
];
