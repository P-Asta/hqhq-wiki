import type { SeedArticle } from "../seed-data";

import { ENTITY_ARTICLES } from "./entities";
import { EQUIPMENT_SCRAP_ARTICLES } from "./equipment-scrap";
import { MECHANICS_STRATEGY_ARTICLES } from "./mechanics-strategies";
import { MOON_ARTICLES } from "./moons";

/**
 * Wave-2 seed articles (seed-content-plan.md §1 inventory beyond the three
 * §3 full articles). Load order: moons → entities → equipment/scrap →
 * mechanics/strategies, so cross-links resolve as far as possible in-wave.
 */
export const EXTRA_ARTICLES: readonly SeedArticle[] = [
  ...MOON_ARTICLES,
  ...ENTITY_ARTICLES,
  ...EQUIPMENT_SCRAP_ARTICLES,
  ...MECHANICS_STRATEGY_ARTICLES,
];
