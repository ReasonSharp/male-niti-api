# An API for the Male Niti website

Implements the endpoints described in `api-spec.yaml`, backed by Postgres. Full interactive API documentation (Swagger UI) is served at `/v1/api-docs`.

This repo does not run its own Postgres container — it expects one reachable on `your-network`, with `db/schema.sql` applied to it (e.g. by another project that composes this API together with a database and other services). Point `.env`'s `PGHOST`/`PGPORT`/`PGDATABASE`/`PGUSER`/`PGPASSWORD` at that instance before building.

## Building the API

```bash
docker build . -t mnapi
docker run -v "/your/image/output/directory:/public/out:rw" --network your-network -p "50000:50000" --restart unless-stopped -d mnapi
```

### Creating your super admin key

Content-management endpoints (writes to services/pricing/work/blog, and reading/updating contact submissions) require a super admin API key. Create one against a running container:

```bash
docker exec <container> node scripts/create-api-key.js "Your Name" --admin
```

The plaintext key is printed once and is not recoverable — save it. Use it as `Authorization: Bearer <key>` on requests.

## Known issues

- **Every request depends on Postgres, including `/v1/api-docs`.** The `checkBanned` IP-ban middleware (`lib/ipBan.js`) queries the database on every incoming request, before routing happens. If Postgres isn't reachable, the whole API returns `500` — not just the data endpoints — including routes that otherwise don't touch the database at all, like the Swagger docs page. Keep this in mind when wiring this API into another project's compose setup: the database needs to be up before this API is usable for anything, even just browsing the docs.
