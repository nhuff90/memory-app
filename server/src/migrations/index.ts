import init from "./001_init.js";
import ai from "./002_ai.js";
import captionsTokens from "./003_captions_tokens.js";
import pinnedKeywords from "./004_pinned_keywords.js";
import keywordAssignments from "./005_keyword_assignments.js";

/** Applied in order; `PRAGMA user_version` records how many have run. Never edit a shipped entry. */
export const MIGRATIONS: readonly string[] = [init, ai, captionsTokens, pinnedKeywords, keywordAssignments];
