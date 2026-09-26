// Links emailed to users point at the atodo frontend's own reachable base
// URL (ATODO_FRONTEND_BASE_URL, see platform-integration/config.template) --
// deployment-configured, never client-supplied, so no request can point an
// emailed link at an arbitrary attacker-controlled domain. The atodo
// client's boot code reads each link's query param back off exactly this URL.
function buildFrontendLink(param, value) {
 const link = new URL(process.env.ATODO_FRONTEND_BASE_URL);
 link.searchParams.set(param, value);
 return link.toString();
}

module.exports = { buildFrontendLink };
