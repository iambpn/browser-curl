# The sandbox image for projects that use `"sandbox": { "type": "docker" }`.
# The native sandbox does not use this file.
#
# Build it from the project root after each change:
#   npx --prefix .sandcastle sandcastle docker build-image --image-name <sandbox.imageName>
FROM node:22-bookworm

RUN apt-get update && apt-get install -y \
  git \
  curl \
  jq \
  && rm -rf /var/lib/apt/lists/*

# Add the tools of your project here: language runtimes, compilers, and
# database clients. The checks in factory.config.json run inside this image.

# Sandcastle sets these to the user of your machine, so files in the mounted
# checkout keep the right owner.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Agents must not run as root. Rename the "node" user of the base image to "agent".
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node

# Codex installs for all users, so it runs before the switch to the agent user.
RUN npm install -g @openai/codex

USER ${AGENT_UID}:${AGENT_GID}

# Claude Code installs into the home folder of the agent user.
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/home/agent/.local/bin:$PATH"

WORKDIR /home/agent

# Sandcastle mounts the agent checkout and starts each command itself.
ENTRYPOINT ["sleep", "infinity"]
