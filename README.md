# An API for the Male Niti website

## Building the API

```bash
docker build . -t mnapi
docker run -v "/your/image/output/directory:/public/out:rw" --network your-network -p "50000:50000" --restart unless-stopped -d mnapi
```