import { slugifyTitle } from "@/lib/title";

import type { SeedArticle } from "../seed-data";

/**
 * Seed batch: remaining entity articles (seed-content-plan.md §1 "Entities"):
 * Bracken, Coil-Head, Nutcracker, Old Bird, Masked.
 *
 * Structure follows the §3 Jester exemplar: {{Infobox_entity}} → bold-title
 * lead → behavior/counterplay/high-quota sections (wikitable where the data
 * is tabular) → external links → {{Reflist}} → [[Category:]] tags. Per the
 * plan's data-honesty rule every number not known with high confidence
 * carries {{Verify|…}}; no version-tag/#vswitch constructs are used because
 * none of these facts has a patch boundary we can source confidently (the
 * Coil-Head cooldown rework in particular stays a {{Verify}}).
 *
 * Filing is wikitext-native (decisions-v2 O13): every article below carries
 * `[[Category:Entities]]` plus an indoor/outdoor category — no nav bucket.
 */

function entity(title: string, wikitext: string): SeedArticle {
  return { title, slug: slugifyTitle(title), wikitext, translations: [] };
}

export const ENTITY_ARTICLES: readonly SeedArticle[] = [
  entity(
    "Bracken",
    `{{Infobox_entity
| name = Bracken
| hp = 6{{Verify|shovel hits to kill}}
| power_level = 3{{Verify|Bracken power level}}
| max_spawn = 1{{Verify|max spawn count}}
| speed = Slow creep (stalking) / very fast (enraged)
| danger = High
| stunnable = yes
| killable = yes
| locations = [[Rend]], [[Dine]], [[Titan]], [[Artifice]], and most lower-tier moons{{Verify|full spawn pool}}
| type = Indoor
}}
The '''Bracken''' is a stealthy indoor entity that shadows isolated players and kills from behind with an instant neck snap. It is the designated punisher of undisciplined speed-looting: crews that split up solo through [[Titan]] or [[Artifice]] corridors are exactly the prey it hunts best, and the corner-checking habit drilled into every high-quota runner exists because of it.<ref name="lethalwiki">Behavior cross-checked against the community-maintained [https://lethal.wiki Lethal Company Wiki].</ref>

== Behavior ==
The Bracken picks a target and follows just outside their view, hugging walls and doorframes. Its reaction to being seen is what makes it unique:

{| class="wikitable"
! State !! Trigger !! What it does
|-
| '''Stalking''' || Default || Trails its target from adjacent rooms and dark corners, closing distance only while unobserved.
|-
| '''Retreating''' || A player looks at it briefly || Turns away, hunches, and walks off to reposition. A short glance is enough to send it away.
|-
| '''Enraged''' || Stared at too long, or attacked || Sprints straight at the offender and attempts the neck snap regardless of who is watching.
|}

Direct eye contact fills a hidden '''anger meter'''{{Verify|anger accumulation and decay timing}} — a glance of under a second is safe, while a held stare of a few seconds tips it into a charge. If it closes on a player who is not looking at it, the neck snap is effectively instant{{Verify|whether the snap animation can be interrupted}}, and it then drags the body to a distant dark dead-end, which is why Bracken victims are so rarely recovered for [[Teleporters|teleporter]] body extraction until the ship watcher pings the corpse.

== Counterplay ==
* '''Glance, don't stare.''' Flick your camera across it to trigger the retreat, then break line of sight and keep moving. Never hold the stare while backing away.
* '''Corner-check on a cadence.''' While speed-looting, snap a full look behind you on every room transition and before crouching at loot piles — the snap only lands from behind.
* It is '''killable''': roughly six shovel hits{{Verify|shovel hits to kill}} or a point-blank [[Nutcracker|shotgun]] blast{{Verify|shotgun one-shot}}. Fight it in pairs — one player holds eye contact to freeze it into retreat loops while the other swings.
* The ship watcher should call its position from the map screen; a Bracken ping that vanishes near a runner is the emergency signal.

== High quota relevance ==
Speed-looting doctrine assumes rooms are cleared solo, which is exactly what the Bracken punishes: a silent death deep in the facility costs the body, the carried loot, and the minutes spent finding the drag spot. Standard high-quota handling is prevention over combat — cadence corner-checks, monitor callouts, and pairing up once a Bracken is confirmed. Its power level of 3{{Verify|power level}} also matters strategically: a live Bracken eats a large share of a tier-3 moon's indoor spawn budget, so experienced crews sometimes leave a managed Bracken alive to suppress worse spawns{{Verify|spawn-suppression practice}}. A Bracken holding the exit corridor during a [[Jester]] wind is the classic compound kill — see [[High quota routing]] for dip discipline.

== External links ==
* [https://lethal.wiki Lethal Company Wiki] — entity data reference.

== References ==
{{Reflist}}

[[Category:Entities]]
[[Category:Indoor entities]]`,
  ),
  entity(
    "Coil-Head",
    `{{Infobox_entity
| name = Coil-Head
| hp = Invulnerable{{Verify|immune to conventional weapons}}
| power_level = 1
| max_spawn = 5{{Verify|max spawn count}}
| speed = Frozen (observed) / far above sprint speed (unobserved)
| danger = High
| stunnable = yes
| killable = no
| locations = Most moons; heaviest on [[Rend]], [[Dine]], [[Titan]], [[Artifice]]{{Verify|spawn pool weighting}}
| type = Indoor
}}
The '''Coil-Head''' is an invulnerable spring-necked mannequin that cannot move while any player is looking at it and moves far faster than sprint speed when nobody is. Individually it is a nuisance; in numbers, and combined with a [[Jester]], it is the classic wipe recipe of tier-3 moons — every additional Coil-Head is one more direction the team must keep eyes on.<ref name="lethalwiki">Behavior cross-checked against the community-maintained [https://lethal.wiki Lethal Company Wiki].</ref>

== Behavior ==
While it is on any player's screen it freezes completely{{Verify|exact line-of-sight rule (on-screen vs. facing)}}. The moment no one observes it, it sprints directly at its target, opening doors on the way, and strikes for massive damage on contact{{Verify|contact damage (commonly cited ~90)}}. It never leaves the facility and it does not despawn — a spawned Coil-Head is a permanent tax on the crew's attention for the rest of the day.

After an extended chase a Coil-Head can go '''dormant''', its spring visibly steaming, standing still even while unobserved{{Verify|v56+ cooldown rework — trigger, duration, and telegraph of the inactive window}}. Until those timings are confirmed for the patch you play, treat the cooldown as bonus time, not a mechanic to build routes around.

== Escorting hauls ==
The standard answer on long carries is the '''escort''': one player walks backwards behind the loot carriers and does nothing but watch the Coil-Head. Carriers holding two-handed items cannot check behind themselves, so the watcher calls every door and turn. Hand the watch off explicitly at intersections ("my coil" / "your coil") — most Coil-Head deaths happen in the half-second when two watchers each assume the other has it.

== Door buffering ==
Closing a door in its face breaks nothing mechanically — it opens doors — but the open animation costs it a beat even at full speed{{Verify|door-opening delay}}. Chaining doors shut along the exit route buys a loaded crew several seconds per corridor, and terminal-locked secure doors hold it entirely while locked{{Verify|secure-door interaction}}. Door buffering is the difference between a Coil-Head being a threat and being a chore on [[Titan]]'s tight factory exits.

== High quota relevance ==
At power level 1 the spawn system can afford several, so late-day interiors on a [[One-day quota]] pace often hold two or three at once. The working rule: loot fast enough to leave before the third one spawns. During a [[Jester]] dip, assign the exit-corridor Coil-Head a dedicated watcher '''before''' the crank finishes — a frozen Coil-Head is harmless, but a forgotten one on the exit route turns an orderly dip into a wipe. See [[High quota routing]].

== External links ==
* [https://lethal.wiki Lethal Company Wiki] — entity data reference.

== References ==
{{Reflist}}

[[Category:Entities]]
[[Category:Indoor entities]]`,
  ),
  entity(
    "Nutcracker",
    `{{Infobox_entity
| name = Nutcracker
| hp = 5{{Verify|shovel hits to kill}}
| power_level = 1{{Verify|Nutcracker power level}}
| max_spawn = 10{{Verify|max spawn count}}
| speed = Stiff patrol march / fast pursuit when alerted
| danger = High
| stunnable = yes
| killable = yes
| locations = [[Rend]], [[Dine]], [[Titan]], [[Artifice]]{{Verify|full spawn pool}}
| type = Indoor
}}
The '''Nutcracker''' is a shotgun-wielding toy soldier that patrols the facility in a stiff march. It is the only entity that is worth money to kill: it drops its '''double-barrel shotgun''' on death — the game's only free weapon and the backbone of late-run entity handling. High-quota crews treat every Nutcracker as a shopping opportunity first and a threat second.<ref name="lethalwiki">Behavior cross-checked against the community-maintained [https://lethal.wiki Lethal Company Wiki].</ref>

== Behavior: the scan-step ==
The Nutcracker is functionally blind while marching. On a cadence it halts and its head rises out of the body to '''scan'''{{Verify|blind-while-marching claim}}; anything that ''moves'' in its view during the scan becomes the target. Standing perfectly still through a scan — mid-corridor, in the open, anywhere — keeps you invisible to it. Once it has a target it aims and fires the double-barrel, two shells before a reload pause{{Verify|shell count before reload}}.

Critically, '''one hit is a commitment''': after taking any damage it goes permanently alert, seeing continuously instead of scan-stepping, and hunts the crew for the rest of the day{{Verify|permanent aggro after first hit}}.

== Kill routes ==
{| class="wikitable"
! Route !! Players !! How it works
|-
| '''Freeze discipline''' || 1 || Follow it, freeze through every scan, and land shovel hits from behind between scans. Safe until the first hit lands — after that, kite around pillars and swing during its reload pause.
|-
| '''Bait and flank''' || 2 || One player draws the shot from behind hard cover at range; the flanker swings freely through the aim-and-reload cycle. The standard route.
|-
| '''Stun burst''' || 2+ || A [[Zap gun]] hold or stun grenade{{Verify|stun tool effectiveness}} while everyone swings. Fastest, but spends resources.
|}

== Shotgun economics ==
The drop is the double-barrel plus shells{{Verify|dropped shell count}}. As scrap it sells in the 25&ndash;90 range{{Verify|sell value range}}, but selling it is almost always wrong: a held shotgun deletes a [[Bracken]] point-blank{{Verify|one-shot thresholds}}, shortens [[Masked]] fights from panic to routine, and makes every later Nutcracker an easier kill. The gun has a safety toggle — call "safety on" before handing it across the team, because a friendly-fire death costs far more than the gun is worth.

== High quota relevance ==
On [[Rend]], [[Dine]] and [[Titan]] days, good crews kill the first Nutcracker '''early''', while the interior is still quiet, and carry the gun for the rest of the run. The fight is loud and takes minutes, so never start it with a [[Jester]] already roaming — check the monitor first. On [[One-day quota]] pace, whether to farm the gun at all is a routing call: it pays for itself only if the run lasts long enough to use it. See [[High quota routing]].

== External links ==
* [https://lethal.wiki Lethal Company Wiki] — entity data reference.

== References ==
{{Reflist}}

[[Category:Entities]]
[[Category:Indoor entities]]`,
  ),
  entity(
    "Old Bird",
    `{{Infobox_entity
| name = Old Bird
| hp = Invulnerable
| power_level = 3{{Verify|Old Bird power level}}
| max_spawn = 20 on [[Artifice]]{{Verify|Artifice spawn cap}}
| speed = Heavy walk / relentless pursuit; missiles outrange any sprint
| danger = Extreme
| stunnable = yes{{Verify|which stun tools affect it}}
| killable = no
| locations = [[Artifice]] (dormant surface spawns); rare elsewhere{{Verify|non-Artifice spawn pool}}
| type = Outdoor
}}
The '''Old Bird''' is a giant, invulnerable war machine that dominates the surface of [[Artifice]]. Since v50 made Artifice the highest-value moon in the game, Old Bird management has been ''the'' defining outdoor skill of modern high-quota play: the interior runs on the [[Jester]] clock, and the surface runs on how many Old Birds are awake.<ref name="lethalwiki">Behavior cross-checked against the community-maintained [https://lethal.wiki Lethal Company Wiki].</ref>

== Behavior ==
Old Birds spawn '''dormant''', standing like statues scattered across the map. A dormant Old Bird wakes when players make noise close to it, shine light at it, or damage it{{Verify|exact wake triggers}}. Awake, it patrols with a sweeping '''spotlight'''; being caught in the beam locks it onto you with a siren blast, and it shares the target with nearby Old Birds{{Verify|alert sharing between Old Birds}}.

{| class="wikitable"
! Attack !! Range !! Handling
|-
| '''Missile volley''' || Long || Arcing rockets fired in bursts. Sprint perpendicular to the volley and hug hard cover; the blast radius punishes straight-line running.
|-
| '''Stomp''' || Melee radius || Area kill around its feet. Never loot or revive under a standing Old Bird.
|-
| '''Grab and torch''' || Contact || Grabs a player, lifts them, and incinerates them with a blowtorch — unconditionally lethal, and it can pluck [[Jetpack]] users out of the air{{Verify|mid-air grab}}.
|}

== Artifice surface control ==
The day starts with a census: the ship watcher counts dormant Old Birds and their positions from the monitor before anyone walks{{Verify|monitor visibility of dormant spawns}}. Routes between ship, main entrance and fire exit are then drawn around the statues — wide berths, no flashlights aimed at them, no [[Company Cruiser|vehicle]] noise nearby. Every bird still asleep at sundown is loot in the bank; every one awake is a corridor closed.

== Ship-camping counterplay ==
Awake Old Birds converge on the ship and camp its door — the standard end-of-day disaster. Working answers:
* '''Doors shut, always.''' The closed ship door blocks everything; open it only on a called sprint window.
* '''Inverse routing.''' Use the [[Teleporters|inverse teleporter]] to put runners inside the facility without crossing the surface, and the regular teleporter to pull bodies and held loot home.
* '''Bait rotation.''' One cheap-loadout runner draws the spotlight and missile volleys wide while the carriers cross behind the ship.
* '''Leave before nightfall''' — it beats all of the above, since night spotlights make clean crossings nearly impossible.

== High quota relevance ==
Artifice's scrap table makes the danger worth it — but only for crews that treat the surface as a solved routing problem rather than a fight. The benchmark: a good Artifice day wakes zero Old Birds before the final haul. Waking one early does not end the run; it converts every later crossing into a tax that compounds with the indoor [[Jester]] timer. See [[High quota routing]] for how Old Bird pressure decides ship-leave timing.

== External links ==
* [https://lethal.wiki Lethal Company Wiki] — entity data reference.

== References ==
{{Reflist}}

[[Category:Entities]]
[[Category:Outdoor entities]]`,
  ),
  entity(
    "Masked",
    `{{Infobox_entity
| name = Masked
| hp = 4{{Verify|shovel hits to kill}}
| power_level = 1{{Verify|Masked power level}}
| max_spawn = 2 natural{{Verify|natural spawn cap; conversions can exceed it}}
| speed = Mimics player walk and sprint{{Verify|exact speed vs. player sprint}}
| danger = High
| stunnable = yes
| killable = yes
| locations = [[Titan]], [[Artifice]], eclipsed moons; anywhere via conversion{{Verify|natural spawn pool}}
| type = Indoor
}}
The '''Masked''' is a mimic that wears the body of a crew member. It kills by grabbing a player and forcing a mask onto their face — and the victim stands back up as another Masked. That conversion mechanic makes it the single biggest wipe risk on large lobbies: one missed identification can cascade through the whole crew.<ref name="lethalwiki">Behavior cross-checked against the community-maintained [https://lethal.wiki Lethal Company Wiki].</ref>

== Identification ==
A Masked copies the appearance of a player in the lobby, but the disguise leaks:

{| class="wikitable"
! Tell !! What to look for
|-
| '''No name tag''' || Looking at a real teammate shows their username above their head; a Masked shows '''nothing'''. This is the definitive check.
|-
| '''Silence''' || It never speaks on voice chat and never answers a direct challenge.
|-
| '''Empty hands''' || It carries no items and casts no flashlight beam, even in pitch-dark corridors.
|-
| '''Movement''' || Beeline pathing toward players, twitchy head tilts, and raised arms in the final lunge. It can mimic idle gestures to lure{{Verify|gesture mimicry}}.
|}

== Spawning and conversion ==
Masked spawn naturally indoors, weighted toward later moons and heavily during an [[Weather|Eclipsed]] day{{Verify|natural spawn weighting}}. Two other sources drive the real danger: a player who dies while wearing a Comedy or Tragedy mask (the scrap items) rises as a Masked, and a player killed by a Masked's grab converts on the spot{{Verify|exact conversion rules}}. Converted Masked path toward the remaining crew and will follow them out of the facility and onto the ship{{Verify|ship-boarding behavior}} — which is why the death of one runner deep inside can end a run an hour later at the ship door.

== Wipe prevention on large lobbies ==
* '''Voice checks are the protocol.''' Challenge anyone you meet unexpectedly; a teammate answers, a Masked cannot. No answer means weapon out.
* '''Count heads.''' The ship watcher tracks who is inside, who is out, and calls any body-count mismatch immediately.
* '''Ship door policy.''' Nobody silent boards the ship, ever — a Masked on the ship at day's end is how full wipes happen.
* '''Kill without hesitating''' once confirmed: about four shovel hits{{Verify|hits to kill}} or one [[Nutcracker|shotgun]] blast. Fight in pairs; its grab targets one player at a time.
* '''Sell masks, never wear them.''' A worn Comedy or Tragedy mask is a delayed conversion in your inventory.

== High quota relevance ==
High-quota lobbies run large crews for parallel looting, which is exactly the population a Masked exploits — a run rarely dies to the first Masked, it dies to the second and third conversions nobody noticed. After any unexplained death, treat every silent silhouette as hostile until voice-confirmed. A [[Jester]] dip is the classic infiltration moment: the whole team funnels through the same corridors at once, and an extra body in the crowd goes unnoticed. See [[High quota routing]] for lobby-size tradeoffs.

== External links ==
* [https://lethal.wiki Lethal Company Wiki] — entity data reference.

== References ==
{{Reflist}}

[[Category:Entities]]
[[Category:Indoor entities]]`,
  ),
];
