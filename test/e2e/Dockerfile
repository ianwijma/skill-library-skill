# The end-to-end suite runs only in this container (see scripts/e2e.mjs), so it can never touch the
# host: not its home directory, agents, npm prefix, git config or network.
ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# A regular user, like a real one: permission checks (e.g. an unwritable npm prefix) behave as on a laptop.
USER node
WORKDIR /home/node/app

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY --chown=node:node . .

# Belt and braces: even outside the tests' sandboxed git config, git can't push to any remote host.
RUN for p in https:// http:// ssh:// git:// git@; do \
      git config --global --add url."file:///nonexistent/e2e-push-blocked/".pushInsteadOf "$p"; \
    done

# global-setup.ts refuses to run without this.
ENV SKILL_LIBRARY_E2E_CONTAINER=1
CMD ["npx", "vitest", "run", "--config", "vitest.e2e.config.ts"]
