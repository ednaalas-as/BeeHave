/** Spread onto fields that are not sign-in credentials (selectors, filters, invites, device setup)
 * so browsers and password managers neither offer saved logins there nor try to save them.
 * The Sign In form keeps its own email / current-password hints for legitimate saving. */
export const notCredential = {
  autoComplete: "off",
  "data-1p-ignore": "true",
  "data-lpignore": "true",
  "data-bwignore": "true",
  "data-form-type": "other",
} as const;
