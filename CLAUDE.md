# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Foundry VTT **module** (not a standalone app) adding combat automation and QoL features to the Dungeon Crawl Classics (DCC) RPG system. It runs inside Foundry: requires the `dcc` system (≥0.70.0), the `socketlib` module, and Foundry v14 (see `module.json` — the README's compatibility section is outdated).

This repo lives in a live Foundry install at `Data/modules/dcc-qol`. The DCC system source is at `../../systems/dcc/` — read it freely for reference (hooks it fires, CSS it provides), but **never modify DCC system code**.

## Commands

```bash
npm test                                  # run all Jest tests
npx jest scripts/__tests__/utils.test.js  # run one test file
npx jest -t "should apply damage"         # run tests matching a name
npm run format                            # standard --fix + stylelint --fix
npm run scss                              # compile styles/dcc-qol.scss → dcc-qol.css
npm run scss-watch                        # same, in watch mode
```

CI (`.github/workflows/run-tests.yml`) runs `npm test` on PRs against main. Formatting: Prettier config is 4-space indent, double quotes, semicolons.

## Architecture

**Strictly hook-based — no monkey-patching.** Never override or replace core Foundry or DCC system functions. If a needed hook doesn't exist, the answer is to request one in the DCC system, not to patch.

All hook registrations live in one place, `scripts/hooks/listeners.js`; handler implementations live in feature-named files under `scripts/hooks/`. To add a feature: write the handler in the appropriate `scripts/hooks/*.js` file, import it in `listeners.js`, register it there.

### Attack card data flow (the core loop)

1. `dcc.modifyAttackRollTerms` (DCC system hook) — `attackRollHooks.js` mutates roll terms before the roll: firing-into-melee penalty, range checks/penalties.
2. `dcc.rollWeaponAttack` — `prepareQoLAttackData` computes hit/miss, deed results, etc. and stores everything in the chat message's flags under the `"dcc-qol"` namespace.
3. `renderChatMessageHTML` — `chatMessageHooks.js` reads those flags, re-renders the message body using `templates/attackroll-card.html` (or `-compact.html` per the `attackCardFormat` setting), and binds button listeners.
4. Button clicks (damage / crit / fumble / friendly fire) are handled in `scripts/chatCardActions/handle*Click.js`.
5. Privileged operations from player clients (applying damage, updating message flags, applying status effects) go through socketlib: `socket.executeAsGM(...)` → GM-side functions in `scripts/socketHandlers.js`. The `socket` is exported from `scripts/dcc-qol.js`.

Card state (e.g. `damageButtonClicked`, `damageTotal`) is persisted in message flags so cards render correctly on reload — when adding a button, persist its clicked state the same way.

Other entry points: `settings.js` (all settings, namespace `"dcc-qol"`), `utils.js` (shared helpers), `compatibility.js` (DCC system setting checks), `dcc-qol.js` (init: preloads templates, registers settings/hooks/socket functions). New Handlebars templates must be added to `preloadTemplates()` in `dcc-qol.js`.

### V13+ DOM rules (enforced throughout)

- The `html` arg to `renderChatMessageHTML` handlers is a **raw DOM element**, not jQuery. No jQuery anywhere — use `querySelector`, `classList`, `addEventListener`, `insertAdjacentHTML`.
- Use `foundry.applications.handlebars.renderTemplate` / `loadTemplates`, not the deprecated globals.
- Null-check every DOM query.

### Utilities

Use the helpers in `scripts/utils.js` instead of inlining lookups — notably `getTokenById(tokenId)` (never `game.canvas.tokens.get(id)?.document` directly), `getFirstTarget(targetsSet)`, `getTokensInMeleeRange()`, `measureTokenDistance()`. New utilities should follow the same pattern: input validation, error handling, debug logging.

## Testing

Jest + jsdom. Foundry globals (`game`, `Hooks`, `ChatMessage`, the `foundry.applications.handlebars` namespace, etc.) are mocked in `scripts/__mocks__/foundry.js`, auto-loaded via `setupFilesAfterEnv` for every test — **extend that file when you need a new API mocked; never mock globals inside individual test files**. Use the factories in `scripts/__mocks__/mock-data.js` (`createMockPc`, `createMockNpc`, `mockMeleeWeapon`, ...) for test data.

Testing philosophy (full details in `docs/testing.md`): tests must engage real code, not shallow mocks. Mock `renderTemplate` with realistic HTML fixtures matching actual template output; verify contracts (template path + data object passed to `renderTemplate`); test actual DOM manipulation and event binding. Pass raw DOM elements to handlers, never jQuery wrappers.

## Styles

Edit the SCSS in `styles/` (`dcc-qol.scss` + `_*.scss` partials), then compile with `npm run scss` — `dcc-qol.css` is generated but committed. Scope QoL chat card styles under `.dccqol.chat-card`; use the existing utility classes (`.centered`, `.status-success`, `.status-failure`, `.status-warning`) before adding new color styles. The DCC system's `dcc.css` (in `../../systems/dcc/styles/`) provides the base styles being overridden — check it first.

## Other conventions

- User-facing strings go through `game.i18n` with keys in `language/en.json` (also es, fr, pt-br).
- The version appears in four places that must stay in sync for a release: `module.json` (`version` and the `download` URL), `package.json`, and `version.txt`. Releases are automated via the `.github/workflows/` release workflows.
- `docs/project_structure.md` is the maintained architecture doc — update it when the architecture changes.
