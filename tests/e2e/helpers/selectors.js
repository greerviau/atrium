// XPath predicate matching one whitespace-delimited class token.
//
// Svelte scopes component styles by appending a compiler-generated
// `svelte-<hash>` class to every element its own `<style>` block can match, so
// a styled element renders as `class="recent-path svelte-1g4ixvo"`. Two
// consequences, both of which have already produced broken selectors here:
//
//   - `@class='recent-path'` never matches: there is always a second token.
//   - `contains(@class, 'tab active')` never matches either. Svelte appends
//     `class:`-directive tokens *after* the scoping hash (`to_class` in
//     svelte/src/internal/shared/attributes.js), so an active tab renders
//     `class="tab svelte-w72ddb active"` and the two tokens are not adjacent.
//     Compose two `hasClass` calls instead of matching one substring.
//
// The hash is derived from the component's CSS and changes whenever that CSS
// changes, so it must never be written into a selector.
export function hasClass(token) {
  return `contains(concat(' ', normalize-space(@class), ' '), ' ${token} ')`;
}
