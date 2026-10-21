# Gymly

Gymly is our self-hosted workout and body-weight tracker, based on
[openGym by Duarte Santos](https://github.com/DuarteSantos8/openGym).

Application: **https://gymly.churntech.com**
Source: **https://github.com/nemathsnv/gymly**

## Deploy an update

Commit your changes and push to `main`. GitHub Actions runs the frontend, API and MCP
tests, builds and boots the two production images, and deploys the exact commit to KVM2.
Pull requests run checks without deployment. To deploy the current `main` again, use
**Actions → Gymly checks and deploy → Run workflow**, selecting `main`.

The server does not build code or keep a GitHub token. A dedicated SSH key can invoke only
Gymly's release receiver. The receiver verifies the archive checksum, image tags, image
revision labels, API writeability, web branding and web revision before opening traffic.
Deployments are serialized. A brief maintenance page prevents customer writes during the
data snapshot and upgrade. See [deployment and recovery](deploy/README.md).

## Run locally

```sh
cp .env.example .env
docker compose up -d --build
```

Open http://localhost:8080. The local compose file builds Gymly from this source;
production uses the isolated configuration in `deploy/compose.yml`.

## Upstream and licensing

The original project and contributors retain their copyright. Gymly modifications were
made on 21 October 2026. The code remains **AGPL-3.0-or-later**; see [LICENSE](LICENSE),
[NOTICE.md](NOTICE.md), and the [original README](docs/UPSTREAM_README.md).
Settings links to this fork's corresponding source and retains upstream attribution.
Existing storage identifiers and import/export formats remain compatible with openGym.

**Exercise media is separately licensed**, outside the AGPL. Upstream permits the
unmodified 180px media in a non-commercial fork with its notice. Commercial use needs
your own Gym visual license. See [NOTICE.md](NOTICE.md) before commercializing Gymly.

Native display names are Gymly. Native bundle identifiers remain upstream-compatible;
this deployment publishes the web/PWA, not native app-store packages.
