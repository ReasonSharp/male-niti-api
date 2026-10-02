// Links emailed to users point at the atodo frontend's own reachable base
// URL (ATODO_FRONTEND_BASE_URL, see platform-integration/config.template) --
// deployment-configured, never client-supplied, so no request can point an
// emailed link at an arbitrary attacker-controlled domain. The atodo
// client's boot code reads each link's query param back off exactly this URL.
// `extra` adds fixed, server-chosen params (e.g. next=checkout&plan=monthly)
// -- never anything a request supplied as free text.
function buildFrontendLink(param, value, extra = {}) {
 const link = new URL(process.env.ATODO_FRONTEND_BASE_URL);
 link.searchParams.set(param, value);
 for (const [key, extraValue] of Object.entries(extra)) link.searchParams.set(key, extraValue);
 return link.toString();
}

module.exports = { buildFrontendLink };
