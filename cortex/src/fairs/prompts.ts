// Byte-stable system prompts for the fair list import (DESIGN.md §2: nothing
// interpolated per call, so each stays prompt-cache stable).

import { SUMMARY_CARD_RULES } from "@wingman/shared";

/** List extraction — used for BOTH entry points (page text and roster image). */
export const LIST_EXTRACTION_SYSTEM = `You read material about a career fair, expo, hackathon or similar recruiting event and extract the list of organizations that will be present as exhibitors, sponsors, partners or employers. The material is either the text of a web page (navigation and unrelated sections included, sometimes with accessible names such as "Acme — visit website" or "[logo: acme]") or a photo or screenshot of a roster, sponsor wall, floor map or list.

Output:
- fairName: the event's name as written in the material (for example "HackRice 16" or "Fall 2026 Career Expo"), or null when it is not evident.
- companies: one entry per organization, in order of appearance. Each has:
  - name: the organization's name as a student would say it, at most 80 characters, without suffixes such as "— visit website", tier labels, booth numbers or taglines.
  - aliases: other spellings, abbreviations or former names that appear in the material for the same organization (for example "AWS" for Amazon Web Services). Empty when none appear. Never invent aliases.

Rules:
- Include every organization the material presents as exhibiting, sponsoring, partnering or recruiting at the event, including university departments, institutes and non-profits when they are listed among the sponsors or exhibitors.
- Exclude people, event names, tracks, prizes, workshop titles, navigation labels, the platform hosting the page, and generic words.
- A schedule line such as "MathWorks Workshop" is not a listing; the sponsor or exhibitor section is. Prefer sections titled sponsors, exhibitors, employers, partners or companies.
- Never invent an organization. If the material contains no such list (a login page, an error page, an unrelated page), return an empty companies array.
- Merge duplicates: an organization that appears several times is listed once.`;

export const LIST_EXTRACTION_USER_TEXT =
  "Extract the exhibitor list from this material. Answer with the structured result only.";

/**
 * Card pre-generation for an imported company. Same text as corpus/enrich.ts's
 * ENRICH_SYSTEM (copied, not imported: corpus/ is a script package, not a
 * library) and composed from the SAME SUMMARY_CARD_RULES as the live Tavily
 * path, so an imported card is indistinguishable from a marquee one
 * (DESIGN.md Appendix C3: one schema, one prompt).
 */
export const IMPORT_CARD_SYSTEM = `You write the pre-generated employer card that Wingman shows in a 600x600 monocular heads-up display at a university career fair. The wearer is a student standing at this employer's booth, reading the lens while making eye contact with a recruiter. The card must be absorbed in under two seconds.

Produce all three fields in one response:

summaryMd — one plain-prose paragraph, 2 to 4 sentences, at most 600 characters. What the company does, the kind of technical work a student intern would actually do there, and why a student might stop at this booth. No markdown headings, no bullet points, no links, no first person.

roles — 0 to 8 concrete internship or new-grad role titles this employer recruits for, each at most 60 characters (for example "Software Engineer Intern", "New Grad Backend Engineer", "Hardware Design Intern"). Use the role titles the source text actually shows. Return an empty array rather than guessing.

card — the HUD summary card, built under the following rules.

${SUMMARY_CARD_RULES}`;
