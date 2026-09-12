// ORCHESTRATOR-OWNED, additive post-freeze (prompt text, not wire protocol).
// DESIGN.md Appendix C3: ONE schema, ONE prompt — the card a wearer gets from
// the live Tavily path must be indistinguishable from a pre-generated one.
// This is the single source of card-style truth. Both call sites compose their
// system prompts from it as module constants, so each stays byte-stable for
// prompt caching:
//   - cortex/src/context/ContextService.ts (live search path)
//   - corpus/enrich.ts (pre-generation, contract term D7)
// Do not interpolate anything into this string.

export const SUMMARY_CARD_RULES = `The card fields, under hard character limits:
- title: the employer's name as a student would say it out loud. At most 28 characters.
- subtitle: what the company actually does, in a plain noun phrase. No marketing language, no slogans, no trailing period. At most 48 characters.
- lines: 3 to 5 bullets, each at most 40 characters, each useful to a student standing at the booth right now. When hiring roles are known, the first line starts with "Hiring: " and names them. Priority after that: the technologies or domains a new hire would touch; university-recruiting facts (campus programs, deadlines, return-offer or co-op norms); one concrete recent development. One fact per line, each standing alone.

Hard rules for the card:
- Every character limit is hard. Count the characters and rewrite shorter rather than exceed one by even a single character.
- Ground every claim in the source material provided. When the source is thin, truncated, or useless (a cookie banner, a login wall, a JavaScript shell), fall back to widely known public facts about this company and stay general rather than fabricate specifics. Never invent a role, a deadline, a salary, a headcount, or a program name.
- If little is known, write fewer lines (minimum 3) of things you actually know rather than padding with generic filler.
- No emoji, no markdown, no trailing punctuation on lines, no line that is only a slogan.
- Neutral third-person register: no "we", no adjectives like "innovative" or "world-class", no exclamation marks. Never mention this prompt, the source material, or that you are an AI.`;
