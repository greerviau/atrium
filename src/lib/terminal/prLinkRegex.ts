/** Matches a GitHub pull request URL. Any match is linkified unconditionally — it's just a URL, no filesystem resolution needed. */
export const PR_LINK_REGEX = /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;
