# Playground entity selection design

## Goal

Make the browser playground a practical inspection tool rather than a fixed
demo. Users can choose which PII categories local-pii protects, then compare
the same policy through the Vercel AI SDK and TanStack AI examples.

## User experience

- Add a shadcn multi-select near the framework tabs labelled “Protect these
  Detection categories”.
- Group options by identity, contact, address, documents, and network/payment
  data.
- Select all sensitive categories by default. Keep `CITY`, `STATE`, and
  `ZIP_CODE` unselected initially, matching the current anonymizer policy.
- Show compact selected-category chips and a clear affordance for removing a
  category.
- Provide optional example chips for email, phone, address, and mixed content.
  Choosing an example fills the composer but does not submit it.
- The policy is shared by both chat tabs so their behavior remains comparable.

## Data flow and lifecycle

1. The playground owns the selected `PiiType` set.
2. Each chat receives the set and creates its privacy session with matching
   Detection `keep`/`redact` configuration.
3. Changing the set resets both conversations and their privacy inspection;
   no old mapping is reused under a new policy.
4. The original input objects remain immutable. The inspector continues to show
   the protected text delivered to the selected browser runtime.
5. Runtime/model state is not cleared when the policy changes. Only
   conversation and privacy-session state are reset.

## Entity policy

The UI exposes the canonical `PiiType` values already supported by local-pii:

- Identity: `GIVEN_NAME`, `SURNAME`, `PERSON`, `ORGANIZATION`.
- Contact: `EMAIL`, `PHONE`, `URL`.
- Address: `BUILDING_NUMBER`, `STREET_NAME`, `SECONDARY_ADDRESS`, `CITY`,
  `STATE`, `ZIP_CODE`.
- Documents: `TAX_ID`, `GOVERNMENT_ID`, `PASSPORT`, `DRIVERS_LICENSE`.
- Financial/network: `BANK_ACCOUNT`, `ROUTING_NUMBER`, `CREDIT_CARD`, `IBAN`,
  `IP_ADDRESS`.

The selected set is translated to the existing anonymizer `keep`/`redact`
options without adding a second filtering implementation. The selector
controls model-backed Detection categories. The precise deterministic
detectors (email, URL, IP, SSN, card, IBAN, and phone) remain always-on in
this first version because the public anonymizer contract does not expose a
per-detector disable list. The UI labels this distinction so users do not
mistake a deselected model category for a guarantee that deterministic
protection was disabled.

## Error and accessibility behavior

- If changing policy while a generation is active, stop and settle both chats
  before resetting them; preserve the primary generation error.
- Multi-select controls use labelled checkboxes, keyboard navigation, and
  screen-reader announcements for selection changes.
- The reset announcement explains that the privacy policy changed and the
  conversation was restarted.
- Empty Detection selection is allowed and leaves the deterministic baseline
  active; the UI makes this state explicit.

## Verification

- Unit/component tests cover defaults, grouped selection, keyboard toggling,
  shared policy, reset behavior, and immutable inputs.
- Adapter tests verify the same selected policy reaches both Vercel and
  TanStack seams.
- A browser test checks that selecting/deselecting a category changes the
  inspector's protected request and that example chips only fill the composer.
- Existing runtime and model-cache behavior remains unchanged.

## Non-goals

- No backend, Gateway, persistence, analytics, or remote policy service.
- No model download or deletion as part of policy selection.
- No separate policy per framework tab.
