/**
 * Seed data — the typed constants `scripts/seed.ts` writes into a fresh
 * database. Nothing here touches the db: it is pure data plus the slug
 * derivation, so it can be unit-tested (see ./seed-data.test.ts) and imported
 * from anywhere.
 *
 * Normative sources:
 * - docs/engine/seed-content-plan.md — the 8 templates, 3 EN articles and the
 *   KO Titan translation. Every wikitext string below is that plan's
 *   `<!-- fixture:… -->` block VERBATIM; seed-data.test.ts asserts it byte for
 *   byte, so edit the plan and re-sync rather than diverging here.
 * - docs/engine/decisions.md O1 (slug = slugifyTitle(title)), O9 (canonical
 *   bare moon titles + redirect pages for the number-prefixed and vanity
 *   names).
 * - docs/engine/decisions-v2.md O13: a page's organization is its
 *   `[[Category:…]]` tags and nothing else. `SeedArticle` therefore carries no
 *   `navCategory`; `NAV_CATEGORIES` below survives purely as optional display
 *   metadata for the seven categories that want a nicer name.
 * - docs/engine/versioning.md §1 (the 13-version registry, default v70).
 * - wiki-data/languages.json, wiki-data/categories.json — the file-store data
 *   this migrates, plus the new `strategies` category the plan asks for.
 *
 * Corrections applied to the plan, recorded here so they are not silently lost:
 * - Plan §0/§2 store templates under slug `template-infobox-moon`; the plan's
 *   own Addendum supersedes that — the `template` namespace column carries the
 *   prefix, so the slug is `infobox-moon`.
 * - Plan §1 titles the moons `8-Titan`/`68-Artifice`; decisions O9 makes the
 *   bare name canonical and the numbered form a redirect page.
 * - Plan §3.1 lists `[[Eclipsed]]` as an intentional red link, but the fixture
 *   only uses "Eclipsed" as italic prose — no such link exists. The plan's
 *   Addendum list (Fancy lamp, Snare Flea, Eyeless Dog, Extension ladder) is
 *   the accurate one.
 */

import { slugifyTitle } from "@/lib/title";
import { SITE_NAME } from "@/lib/wiki/config";

import { EXTRA_ARTICLES } from "./seed-content";

import { SEED_DEFAULT_VERSION, SEED_VERSION_IDS, versionOrdinal } from "./store";

/* ------------------------------------------------------------------ */
/* Actor + site settings                                               */
/* ------------------------------------------------------------------ */

/** The author recorded on every seeded revision (users mirror row). */
export const SEED_ACTOR = { uid: "system", displayName: "HQHQ Wiki" } as const;

/** `site_settings` key/value seeded alongside `default_version`. */
export const SITE_NAME_KEY = "sitename";
/** Re-exported: `{{SITENAME}}` is owned by the engine config (wiki/config.ts). */
export { SITE_NAME };

/* ------------------------------------------------------------------ */
/* Languages (migrated from wiki-data/languages.json)                  */
/* ------------------------------------------------------------------ */

export interface SeedLanguage {
  code: string;
  label: string;
  nativeName: string;
  direction: "ltr" | "rtl";
  status: "active" | "proposed";
}

export const LANGUAGES: readonly SeedLanguage[] = [
  { code: "en", label: "English", nativeName: "English", direction: "ltr", status: "active" },
  { code: "ko", label: "Korean", nativeName: "한국어", direction: "ltr", status: "active" },
];

/* ------------------------------------------------------------------ */
/* Category display metadata (decisions O3, narrowed by decisions-v2 O13.6) */
/* ------------------------------------------------------------------ */

/**
 * DECORATION ONLY. Since decisions-v2 O13 the `categories` table no longer
 * organizes anything: browsing reads `category_links`, which the engine fills
 * from the `[[Category:…]]` tags in page wikitext. These rows just supply a
 * localized label, a description and a sort order for the seven categories
 * that had them, so nothing regresses visually (O13.6). A category with no row
 * here is completely normal and renders under its own name.
 *
 * Migrated from wiki-data/categories.json, plus `strategies` (seed plan §0,
 * sortOrder 55) which the file store never had.
 */
export interface SeedNavCategory {
  slug: string;
  sortOrder: number;
  labels: Record<string, string>;
  description: Record<string, string>;
}

export const NAV_CATEGORIES: readonly SeedNavCategory[] = [
  {
    slug: "moons",
    sortOrder: 10,
    labels: { en: "Moons", ko: "위성" },
    description: {
      en: "Locations, routes, hazards, and version-specific observations.",
      ko: "지역, 경로, 위험 요소와 버전별 관찰 정보입니다.",
    },
  },
  {
    slug: "entities",
    sortOrder: 20,
    labels: { en: "Entities", ko: "생명체" },
    description: {
      en: "Creatures, behavior, encounters, and verified counterplay.",
      ko: "생명체의 행동, 조우 방식과 검증된 대응법입니다.",
    },
  },
  {
    slug: "equipment",
    sortOrder: 30,
    labels: { en: "Equipment", ko: "장비" },
    description: {
      en: "Tools, upgrades, controls, and practical usage notes.",
      ko: "도구, 업그레이드, 조작법과 활용 정보입니다.",
    },
  },
  {
    slug: "scrap",
    sortOrder: 40,
    labels: { en: "Scrap", ko: "스크랩" },
    description: {
      en: "Collectible items, value ranges, and handling notes.",
      ko: "수집 아이템, 가치 범위와 취급 정보입니다.",
    },
  },
  {
    slug: "mechanics",
    sortOrder: 50,
    labels: { en: "Mechanics", ko: "게임 시스템" },
    description: {
      en: "Core systems, rules, and reproducible gameplay behavior.",
      ko: "핵심 시스템, 규칙과 재현 가능한 게임 동작입니다.",
    },
  },
  {
    slug: "strategies",
    sortOrder: 55,
    labels: { en: "Strategies", ko: "전략" },
    description: {
      en: "High-quota routing, rulesets, and run planning.",
      ko: "하이 쿼터 동선, 룰셋과 런 설계입니다.",
    },
  },
  {
    slug: "tech",
    sortOrder: 60,
    labels: { en: "Tech", ko: "기술" },
    description: {
      en: "Terminal commands, routing, modding, and technical references.",
      ko: "터미널 명령, 경로, 모딩과 기술 참고 자료입니다.",
    },
  },
];

/**
 * Seed value of the `home_categories` site setting (decisions-v2 O13.3): the
 * curated order of the home grid, as a plain list of category slugs.
 *
 * Without it the grid falls back to member count descending, and the busiest
 * category on a fresh seed is the `{{Verify}}` maintenance bucket — correct by
 * the rule, useless to a reader. Pinning the seven decorated categories keeps
 * the home page reading the way it did before O13 (O13.6 "nothing regresses
 * visually") while every other category stays one click away on
 * `/special/categories`.
 *
 * It is a HINT, not a registry: slugs naming a category no page has tagged are
 * dropped at read time, and an admin who edits the setting owns it from then on.
 */
export const HOME_CATEGORIES: readonly string[] = NAV_CATEGORIES.map((c) => c.slug);

/* ------------------------------------------------------------------ */
/* Version registry (versioning.md §1)                                 */
/* ------------------------------------------------------------------ */

export interface SeedVersion {
  id: string;
  label: string;
  /** major*1000 + minor — the only ordering key. */
  ordinal: number;
  status: "current" | "supported" | "legacy";
}

/** The version a reader gets when they have not chosen one. */
export const DEFAULT_VERSION: string = SEED_DEFAULT_VERSION;

/**
 * Derived from the store's `SEED_VERSION_IDS` so the registry keeps exactly
 * one source of truth: `scripts/seed.ts` writes it through `seedVersions()`,
 * and this constant is what the seed report and the tests check it against.
 */
export const VERSIONS: readonly SeedVersion[] = SEED_VERSION_IDS.map((id) => ({
  id,
  label: id,
  ordinal: versionOrdinal(id),
  status: id === SEED_DEFAULT_VERSION ? "current" : "legacy",
}));

/* ------------------------------------------------------------------ */
/* Pages                                                               */
/* ------------------------------------------------------------------ */

export interface SeedTemplate {
  /** Bare page name — no `Template:` prefix, the namespace column carries it. */
  title: string;
  /** Always `slugifyTitle(title)` (O1); never hand-written. */
  slug: string;
  wikitext: string;
}

export interface SeedTranslation {
  locale: string;
  /** Display title for this locale (page_locales.title). */
  title: string;
  wikitext: string;
}

export interface SeedArticle {
  title: string;
  slug: string;
  /**
   * The article source. It is also the ONLY statement of where the page is
   * filed: every seed article carries at least one `[[Category:…]]` tag, and
   * `seed-data.test.ts` enforces that (decisions-v2 O13.1/O13.7 — the old
   * `navCategory` bucket is gone).
   */
  wikitext: string;
  translations: readonly SeedTranslation[];
}

export interface SeedRedirect {
  title: string;
  slug: string;
  /** Title it points at — may not be seeded yet (plan §7 step 5). */
  target: string;
  wikitext: string;
}

function template(title: string, wikitext: string): SeedTemplate {
  return { title, slug: slugifyTitle(title), wikitext };
}

function article(
  title: string,
  wikitext: string,
  translations: readonly SeedTranslation[] = [],
): SeedArticle {
  return { title, slug: slugifyTitle(title), wikitext, translations };
}

function redirect(title: string, target: string): SeedRedirect {
  return { title, slug: slugifyTitle(title), target, wikitext: `#REDIRECT [[${target}]]` };
}

/**
 * The 8 `Template:` pages (plan §2.1–§2.8). Load order matters: these go in
 * before the articles that transclude them.
 */
export const TEMPLATES: readonly SeedTemplate[] = [
  template(
    "Infobox moon",
    `<table class="infobox" style="float:right; clear:right; width:290px; margin:0 0 1em 1.5em; border:1px solid #a2a9b1; background:#f8f9fa; border-collapse:collapse; font-size:88%; line-height:1.5;">
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
</table>`,
  ),
  template(
    "Infobox entity",
    `<table class="infobox" style="float:right; clear:right; width:290px; margin:0 0 1em 1.5em; border:1px solid #a2a9b1; background:#f8f9fa; border-collapse:collapse; font-size:88%; line-height:1.5;">
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
</table>`,
  ),
  template(
    "Infobox item",
    `<table class="infobox" style="float:right; clear:right; width:290px; margin:0 0 1em 1.5em; border:1px solid #a2a9b1; background:#f8f9fa; border-collapse:collapse; font-size:88%; line-height:1.5;">
<tr><th colspan="2" style="background:#1f4433; color:#ffffff; padding:6px 8px; font-size:112%; text-align:center;">{{{name|Unnamed item}}}</th></tr>
{{#if:{{{image|}}}|<tr><td colspan="2" style="text-align:center; padding:6px; background:#ffffff;">[[File:{{{image}}}|260px|{{{name|}}}]]</td></tr>}}
{{#if:{{{type|}}}|<tr><td colspan="2" style="text-align:center; padding:2px 8px; font-style:italic; background:#e8f0ec;">{{#switch:{{{type}}}|Equipment=Purchasable equipment|Scrap=Scrap item|Ship upgrade=Ship upgrade|#default={{{type}}}}}</td></tr>}}
{{#if:{{{price|}}}|<tr><th style="text-align:left; vertical-align:top; padding:4px 8px; width:46%; background:#ecf3ef;">Store price</th><td style="padding:4px 8px;">{{{price}}} credits</td></tr>}}
{{#if:{{{value_min|}}}{{{value_max|}}}|<tr><th style="text-align:left; vertical-align:top; padding:4px 8px; width:46%; background:#ecf3ef;">Sell value</th><td style="padding:4px 8px;">{{#ifeq:{{{value_min|}}}|{{{value_max|}}}|{{{value_min}}} (fixed)|{{{value_min|?}}} &ndash; {{{value_max|?}}}}} credits</td></tr>}}
{{#if:{{{weight|}}}|<tr><th style="text-align:left; vertical-align:top; padding:4px 8px; background:#ecf3ef;">Weight</th><td style="padding:4px 8px;">{{{weight}}} lb</td></tr>}}
{{#if:{{{conductive|}}}|<tr><th style="text-align:left; vertical-align:top; padding:4px 8px; background:#ecf3ef;">Conductive</th><td style="padding:4px 8px;">{{#ifeq:{{{conductive}}}|yes|'''Yes''' (drop it in [[Weather|storms]])|No}}</td></tr>}}
{{#if:{{{two_handed|}}}|<tr><th style="text-align:left; vertical-align:top; padding:4px 8px; background:#ecf3ef;">Two-handed</th><td style="padding:4px 8px;">{{#ifeq:{{{two_handed}}}|yes|Yes|No}}</td></tr>}}
{{#if:{{{battery|}}}|<tr><th style="text-align:left; vertical-align:top; padding:4px 8px; background:#ecf3ef;">Battery</th><td style="padding:4px 8px;">{{{battery}}}</td></tr>}}
</table>`,
  ),
  template(
    "Infobox mechanic",
    `<table class="infobox" style="float:right; clear:right; width:290px; margin:0 0 1em 1.5em; border:1px solid #a2a9b1; background:#f8f9fa; border-collapse:collapse; font-size:88%; line-height:1.5;">
<tr><th colspan="2" style="background:#3c3363; color:#ffffff; padding:6px 8px; font-size:112%; text-align:center;">{{{name|Unnamed mechanic}}}</th></tr>
{{#if:{{{image|}}}|<tr><td colspan="2" style="text-align:center; padding:6px; background:#ffffff;">[[File:{{{image}}}|260px|{{{name|}}}]]</td></tr>}}
{{#if:{{{introduced|}}}|<tr><th style="text-align:left; vertical-align:top; padding:4px 8px; width:40%; background:#edecf3;">Introduced</th><td style="padding:4px 8px;">{{{introduced}}}</td></tr>}}
{{#if:{{{formula|}}}|<tr><th style="text-align:left; vertical-align:top; padding:4px 8px; background:#edecf3;">Formula</th><td style="padding:4px 8px; font-family:monospace; font-size:95%;">{{{formula}}}</td></tr>}}
{{#if:{{{related|}}}|<tr><th style="text-align:left; vertical-align:top; padding:4px 8px; background:#edecf3;">Related</th><td style="padding:4px 8px;">{{{related}}}</td></tr>}}
</table>`,
  ),
  template(
    "Stub",
    `<div class="notice" style="border:1px dashed #8a94a6; background:#f4f6fa; padding:8px 12px; margin:8px 0; font-size:92%;">'''This article is a stub.''' It was seeded with minimal content — you can help the high-quota community by expanding it with verified data.</div>[[Category:Stubs]]`,
  ),
  template(
    "Version",
    `<div class="notice" style="border-left:4px solid #4a6fb3; background:#eef3fb; padding:6px 10px; margin:8px 0; font-size:92%;">'''Version note{{#if:{{{version|}}}|&nbsp;({{{version}}})}}:''' {{{note|This section describes version-specific behavior.}}}</div>`,
  ),
  template(
    "Reflist",
    `<div class="reflist" style="font-size:88%; line-height:1.5; margin-top:4px;"><references /></div>`,
  ),
  template(
    "Verify",
    `<sup class="notice" style="color:#b3261e; font-weight:bold; white-space:nowrap;" title="This value has not been verified against the current game version{{#if:{{{1|}}}|&#58; {{{1}}}}}.">[verify]</sup>[[Category:Pages with unverified data]]`,
  ),
  template(
    "Version note",
    `<div class="version-scoped" style="border-left:3px solid #ff6a00; background:rgba(255,106,0,0.08); padding:8px 12px; margin:0 0 1em;">
{{#if:{{{1|}}}|'''{{{1}}}'''|This page uses '''version scoping''': pick a game version above to change what it shows.}}
</div>`,
  ),
];

/**
 * The three complete EN articles (plan §3) plus the abridged KO Titan
 * translation (plan §4). Titles follow decisions O9: the bare canonical name,
 * with the number-prefixed form seeded as a redirect below.
 */
const CORE_ARTICLES: readonly SeedArticle[] = [
  article(
    "Titan",
    `{{Infobox_moon
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
[[Category:Tier 3 moons]]`,
    [
      {
        locale: "ko",
        // O9's bare-title rule applied per locale: "8-타이탄" is the numbered
        // display form, so the KO page title is the bare one too.
        title: "타이탄",
        wikitext: `{{Stub}}
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

[[Category:Moons]]`,
      },
    ],
  ),
  article(
    "Jester",
    `{{Infobox_entity
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
[[Category:Indoor entities]]`,
  ),
  article(
    "Quota",
    `{{Infobox_mechanic
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
[[Category:High quota]]`,
  ),
];

/**
 * All seed articles: the three §3 full articles plus the wave-2 inventory
 * batches (src/lib/db/seed-content/). Core stays first so ARTICLES[0] remains
 * the Titan fixture other tests rely on.
 */
export const ARTICLES: readonly SeedArticle[] = [...CORE_ARTICLES, ...EXTRA_ARTICLES];


/**
 * decisions O9: the number-prefixed moon names and the vanity alternates are
 * real pages holding `#REDIRECT`. Targets outside the three seeded articles
 * are deliberately "broken until backfilled" — the inventory pages they point
 * at land in plan §7 step 5.
 */
export const REDIRECTS: readonly SeedRedirect[] = [
  redirect("8-Titan", "Titan"),
  redirect("68-Artifice", "Artifice"),
  redirect("85-Rend", "Rend"),
  redirect("7-Dine", "Dine"),
  redirect("41-Experimentation", "Experimentation"),
  redirect("5-Embrion", "Embrion"),
  redirect("71-Gordion", "The Company (71-Gordion)"),
  redirect("The Company", "Selling at the Company"),
];

/* ------------------------------------------------------------------ */
/* Inventory helpers                                                   */
/* ------------------------------------------------------------------ */

export interface SeedPageRef {
  namespace: "main" | "template" | "project";
  slug: string;
  title: string;
  locales: readonly string[];
}


/* ------------------------------------------------------------------ */
/* Project-namespace help pages                                        */
/*                                                                     */
/* Closes app-status.md gap #1: no seeded page exercised the O10       */
/* version constructs, so the selector never appeared on real content. */
/* These pages document the feature with SELF-REFERENTIAL examples —   */
/* they make no claim about which Lethal Company value changed at      */
/* which patch, which stays an editorial task for contributors.        */
/* ------------------------------------------------------------------ */

export interface SeedHelpPage {
  title: string;
  slug: string;
  wikitext: string;
  translations: readonly SeedTranslation[];
}

export const HELP_PAGES: readonly SeedHelpPage[] = [
  {
    title: "Version scoping",
    slug: slugifyTitle("Version scoping"),
    wikitext: `{{Version note}}
'''Version scoping''' lets a single article carry facts for several game versions at once. A reader
picks a version from the selector at the top of the page and sees only what applies to it. Nothing
is duplicated: one page, one history, one translation set — the version is a ''view'' of the page,
never a separate page.

This page is itself version-scoped, so you can try the selector above right now.

== Live demonstration ==

The paragraph below is written three times in the source, once per window. Only one is shown:

<v45+v55>You are viewing a version between '''v45''' and v55. This sentence lives in the first window.</v45+v55><v56+v60>You are viewing '''v56''' to v60. The second window replaced the first at v56.</v56+v60><v62+>You are viewing '''v62''' or later. The third window replaced the second at v62.</v62+>

Selected version: '''{{VERSION}}'''. The site default is {{LATESTVERSION}}.{{#ifversion: >=v62 | This note only appears from v62 onward.}}

A value picked per version with a single expression: '''{{#vswitch: v45=first | v56=second | v62=third | default=none}}'''.

== The version tag ==

'''The version id is the tag name.''' There are no attributes to remember and three forms to choose
from:

{| class="wikitable"
! Tag !! Applies to
|-
| <code>&lt;v62&gt;…&lt;/v62&gt;</code> || v62 and nothing else
|-
| <code>&lt;v50+v61&gt;…&lt;/v50+v61&gt;</code> || v50 through v61, both ends included
|-
| <code>&lt;v62+&gt;…&lt;/v62+&gt;</code> || v62 and every later version
|}

The closing tag repeats the opening one exactly. An id is <code>v62</code> or <code>v64.1</code>, so
<code>&lt;v64.1+&gt;</code> and <code>&lt;v64.1+v70&gt;</code> are ordinary tags too. Something true
on two versions and nothing between them is simply two tags:
<code>&lt;v56&gt;…&lt;/v56&gt;&lt;v60&gt;…&lt;/v60&gt;</code>.

== Text with no tag belongs to every version ==

There is no fallback to declare and nothing to repeat: '''tag the part that changed and leave the
rest alone.'''

<pre>
The base quota is <v50+v61>'''130'''</v50+v61><v62+>'''180'''</v62+> credits.
</pre>

That renders ''130'' for v50 through v61 and ''180'' from v62 onward, with one sentence carrying
both. A reader on a version outside every window still sees the untagged words around them.

Write consecutive windows '''back to back''', with no space or newline between them. Whatever sits
between two tags is untagged text, so a line break parked there would show up on every version.

== Where the chips come from ==

Every id a tag names is collected while the page renders, including the ids of windows the current
view is hiding, and those ids are the chips the selector offers. Two consequences worth knowing:

* '''Only the versions that differ get a chip.''' A page whose windows start at v56 and v62 reads
  identically on v57, v58 and v60, so the selector offers v56 and v62 and nothing else.
* '''A window is closed by what you write next, not by the registry.''' Give the next window the
  patch it starts at — <code>&lt;v50+v61&gt;</code> then <code>&lt;v62+&gt;</code> — and the two can
  never overlap.

A window whose ends are the wrong way round (<code>&lt;v62+v50&gt;</code>) matches no version and
shows nothing. It is never quietly swapped: that would file one version's text under another
version's id, which is the mistake this whole feature exists to prevent.

== Inside templates and tables ==

Version constructs resolve before the page is laid out, so they work anywhere — including inside
table cells, list items and template parameters.

{| class="wikitable"
! Field !! Value
|-
| Conditional cell || {{#ifversion: >=v56 | shown from v56 | shown before v56}}
|-
| Switched cell || {{#vswitch: v45=A | v62=B | default=?}}
|}

For an infobox parameter, <code>#vswitch</code> keeps the change on one line:

<pre>
{{Infobox_moon
| cost = {{#vswitch: v50=1400 | v62=1500 }}
}}
</pre>

== Range expressions ==

<code>#ifversion</code> takes a range. Commas mean ''or''.

{| class="wikitable"
! Expression !! Matches
|-
| <code>v62</code> || exactly v62
|-
| <code>v50-v61</code> || v50 through v61, inclusive
|-
| <code>&gt;=v62</code> || v62 and later — also <code>&gt;</code>, <code>&lt;=</code>, <code>&lt;</code>
|-
| <code>v50,v55,&gt;=v62</code> || any of the parts
|-
| <code>*</code> || always
|}

== Version variables ==

<code><nowiki>{{VERSION}}</nowiki></code>, <code><nowiki>{{VERSIONLABEL}}</nowiki></code>,
<code><nowiki>{{VERSIONORDINAL}}</nowiki></code>, <code><nowiki>{{LATESTVERSION}}</nowiki></code> and
<code><nowiki>{{ISLATESTVERSION}}</nowiki></code> report the reader's selection.

== Guidelines ==

* Add a change point '''only when you know the patch''' that changed the value. An unsourced boundary
  is worse than no boundary — mark uncertain values with <nowiki>{{Verify}}</nowiki> instead.
* Version ids come from the registry, but a tag naming a patch nobody has registered yet still works:
  it orders by its number, and its chip appears so somebody can add the id. A word that is not shaped
  like a version id at all can only reach <code>#ifversion</code> and <code>#vswitch</code>, where it
  is ignored with a warning.
* Links, categories and redirects are read from the page as a whole, not per version, so a page never
  leaves a category because a reader picked an older build.
* Search indexes the default version only.

[[Category:Help]]
`,
    translations: [
      {
        locale: "ko",
        title: "버전 스코핑",
        wikitext: `{{Version note}}
'''버전 스코핑'''은 하나의 문서가 여러 게임 버전의 정보를 함께 담게 해줍니다. 독자가 문서 상단
선택기에서 버전을 고르면 해당 버전에 맞는 내용만 표시됩니다. 문서를 복제하지 않으므로 문서 하나,
편집 이력 하나, 번역 묶음 하나가 유지됩니다. 버전은 문서를 보는 ''관점''이지 별도 문서가 아닙니다.

이 문서 자체가 버전 스코핑을 사용하므로 위 선택기를 지금 눌러 확인할 수 있습니다.

== 실제 동작 ==

아래 문단은 원본에 세 번 작성되어 있고, 그중 하나만 표시됩니다:

<v45+v55>지금 '''v45'''부터 v55 사이를 보고 있습니다. 이 문장은 첫 번째 구간에 속합니다.</v45+v55><v56+v60>지금 '''v56'''부터 v60 사이를 보고 있습니다. v56에서 두 번째 구간이 첫 번째를 대체했습니다.</v56+v60><v62+>지금 '''v62''' 이상을 보고 있습니다. v62에서 세 번째 구간이 두 번째를 대체했습니다.</v62+>

선택한 버전: '''{{VERSION}}''' · 사이트 기본값: {{LATESTVERSION}}{{#ifversion: >=v62 | · 이 문구는 v62 이상에서만 보입니다.}}

한 줄로 버전별 값 고르기: '''{{#vswitch: v45=첫째 | v56=둘째 | v62=셋째 | default=없음}}'''.

== 버전 태그 ==

'''버전 ID가 곧 태그 이름입니다.''' 외울 속성은 없고, 형태는 세 가지뿐입니다:

{| class="wikitable"
! 태그 !! 적용 범위
|-
| <code>&lt;v62&gt;…&lt;/v62&gt;</code> || v62에서만
|-
| <code>&lt;v50+v61&gt;…&lt;/v50+v61&gt;</code> || v50부터 v61까지 (양끝 포함)
|-
| <code>&lt;v62+&gt;…&lt;/v62+&gt;</code> || v62 이상 전부
|}

닫는 태그는 여는 태그를 그대로 반복합니다. ID는 <code>v62</code> 또는 <code>v64.1</code> 형태이므로
<code>&lt;v64.1+&gt;</code>와 <code>&lt;v64.1+v70&gt;</code>도 똑같이 쓸 수 있습니다. 사이가 떨어진 두
버전에만 해당하는 내용은 태그를 두 번 쓰면 됩니다:
<code>&lt;v56&gt;…&lt;/v56&gt;&lt;v60&gt;…&lt;/v60&gt;</code>.

== 태그가 없는 글은 모든 버전에 속합니다 ==

따로 선언할 기본값도, 반복해서 적을 문장도 없습니다. '''달라진 부분만 태그로 감싸고 나머지는 그대로
두세요.'''

<pre>
기본 할당량은 <v50+v61>'''130'''</v50+v61><v62+>'''180'''</v62+> 크레딧입니다.
</pre>

이렇게 쓰면 v50~v61은 ''130'', v62 이상은 ''180''이 표시되고, 문장은 한 번만 작성됩니다. 어떤 구간에도
들어가지 않는 버전에서도 태그 밖의 글은 그대로 보입니다.

이어지는 구간은 '''공백이나 줄바꿈 없이 붙여서''' 쓰세요. 태그와 태그 사이의 내용은 태그가 없는 글로
취급되므로, 거기에 넣은 줄바꿈은 모든 버전에서 출력됩니다.

== 선택기의 칩은 어디에서 오는가 ==

문서를 렌더링하는 동안 태그가 지정한 ID는 모두 수집됩니다. 지금 화면에 보이지 않는 구간의 ID까지
포함되며, 그렇게 모인 ID가 선택기에 칩으로 나타납니다. 여기서 따라오는 두 가지가 있습니다:

* '''내용이 달라지는 버전만 칩이 됩니다.''' v56과 v62에서 시작하는 구간만 있는 문서는 v57·v58·v60에서
  똑같이 읽히므로, 선택기도 v56과 v62만 제시합니다.
* '''구간의 끝은 레지스트리가 아니라 다음에 쓴 태그가 정합니다.''' 다음 구간에 시작 패치를 적어 주면
  — <code>&lt;v50+v61&gt;</code> 다음에 <code>&lt;v62+&gt;</code> — 두 구간이 겹칠 일이 없습니다.

양끝이 뒤집힌 구간(<code>&lt;v62+v50&gt;</code>)은 어떤 버전에도 해당하지 않아 아무것도 표시되지
않습니다. 자동으로 바로잡지 않습니다. 그렇게 하면 한 버전의 내용이 다른 버전의 ID 아래에 놓이게 되고,
그것이 바로 이 기능이 막으려는 실수이기 때문입니다.

== 템플릿과 표 안에서 ==

버전 구문은 문서 구조가 만들어지기 전에 해석되므로 표 셀, 목록 항목, 템플릿 인자 등 어디서나
동작합니다.

{| class="wikitable"
! 항목 !! 값
|-
| 조건부 셀 || {{#ifversion: >=v56 | v56 이상에서 표시 | v56 미만에서 표시}}
|-
| 전환 셀 || {{#vswitch: v45=A | v62=B | default=?}}
|}

인포박스 인자는 <code>#vswitch</code>로 한 줄에 정리할 수 있습니다:

<pre>
{{Infobox_moon
| cost = {{#vswitch: v50=1400 | v62=1500 }}
}}
</pre>

== 범위 표현식 ==

<code>#ifversion</code>은 범위를 받습니다. 쉼표는 ''또는''을 뜻합니다.

{| class="wikitable"
! 표현식 !! 의미
|-
| <code>v62</code> || v62에서만
|-
| <code>v50-v61</code> || v50부터 v61까지 (양끝 포함)
|-
| <code>&gt;=v62</code> || v62 이상 — <code>&gt;</code>, <code>&lt;=</code>, <code>&lt;</code>도 사용 가능
|-
| <code>v50,v55,&gt;=v62</code> || 나열한 조건 중 하나라도 맞으면
|-
| <code>*</code> || 항상
|}

== 버전 변수 ==

<code><nowiki>{{VERSION}}</nowiki></code>, <code><nowiki>{{VERSIONLABEL}}</nowiki></code>,
<code><nowiki>{{VERSIONORDINAL}}</nowiki></code>, <code><nowiki>{{LATESTVERSION}}</nowiki></code>,
<code><nowiki>{{ISLATESTVERSION}}</nowiki></code>로 독자가 선택한 버전을 참조할 수 있습니다.

== 작성 지침 ==

* '''어느 패치에서 바뀌었는지 확실할 때만''' 변경 지점을 추가하세요. 근거 없는 경계는 경계가 없는
  것보다 나쁩니다. 불확실한 값은 <nowiki>{{Verify}}</nowiki>로 표시하세요.
* 버전 ID는 레지스트리에서 가져오지만, 아직 등록되지 않은 패치를 가리키는 태그도 그대로 동작합니다.
  번호 순서대로 정렬되고 칩으로도 나타나므로 누군가 등록해 줄 수 있습니다. 버전 ID 형태가 아예 아닌
  단어는 <code>#ifversion</code>과 <code>#vswitch</code>에만 들어갈 수 있고, 경고와 함께 무시됩니다.
* 링크·분류·넘겨주기는 버전과 무관하게 문서 전체에서 추출됩니다. 독자가 구버전을 선택했다고 해서
  문서가 분류에서 빠지지 않습니다.
* 검색은 기본 버전 기준으로만 색인합니다.

[[Category:Help]]
`,
      },
    ],
  },
];

/** Every page this seed creates, in load order: templates → articles → redirects. */
export function seedPageRefs(): SeedPageRef[] {
  return [
    ...TEMPLATES.map((t) => ({
      namespace: "template" as const,
      slug: t.slug,
      title: t.title,
      locales: ["en"],
    })),
    ...ARTICLES.map((a) => ({
      namespace: "main" as const,
      slug: a.slug,
      title: a.title,
      locales: ["en", ...a.translations.map((t) => t.locale)],
    })),
    ...REDIRECTS.map((r) => ({
      namespace: "main" as const,
      slug: r.slug,
      title: r.title,
      locales: ["en"],
    })),
    ...HELP_PAGES.map((h) => ({
      namespace: "project" as const,
      slug: h.slug,
      title: h.title,
      locales: ["en", ...h.translations.map((t) => t.locale)],
    })),
  ];
}
